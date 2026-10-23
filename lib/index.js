// dsh-github — 用「你自己填的 GitHub token」干活：调 REST API、一次提交多个文件、
// 建仓库、看这个 token 是谁的。
//
// 设计约束（用户明确要求）：
//   · token 只存在插件自己的设置文件里（~/.dsh/storages/dsh-github/settings.json），
//     不进仓库、不进 cordis.patch.yml、不进任何工具输出；
//   · 设置页里那格**只有示例占位符，没有默认值** —— 不填就是没配；
//   · 所有工具在没有 token 时给一句人话提示，而不是抛异常。
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)

export const name = 'dsh-github'
export const inject = ['tools', 'webServer']

const DEFAULTS = {
  // 默认空：不预置任何 key。设置页里那格也只是 placeholder 示例。
  token: '',
  apiBase: 'https://api.github.com',
  // 本机代理；留空 = 直连。GitHub 在部分地区直连会超时，走代理最稳。
  proxyUrl: '',
  timeoutMs: 20000,
  maxChars: 6000,
}

const STORE_DIR = process.env.DSH_GITHUB_STORE || join(homedir(), '.dsh', 'storages', 'dsh-github')
const SETTINGS_PATH = join(STORE_DIR, 'settings.json')

// ---------------------------------------------------------------- settings

function readSettingsFile () {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeSettingsFile (patch) {
  const next = { ...readSettingsFile(), ...patch }
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    return { ...next, _writeError: String((error && error.message) || error) }
  }
  return next
}

function resolveSettings (config) {
  const merged = { ...DEFAULTS, ...(config || {}), ...readSettingsFile() }
  merged.token = String(merged.token || '').trim()
  merged.apiBase = String(merged.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '')
  merged.proxyUrl = String(merged.proxyUrl || '').trim()
  merged.timeoutMs = Math.max(3000, Number(merged.timeoutMs) || DEFAULTS.timeoutMs)
  merged.maxChars = Math.max(500, Number(merged.maxChars) || DEFAULTS.maxChars)
  return merged
}

/** 只露出末 4 位，其余永远不回显。 */
function maskToken (token) {
  const t = String(token || '')
  if (!t) return ''
  if (t.length <= 8) return '****'
  return t.slice(0, 4) + '…' + t.slice(-4)
}

// ---------------------------------------------------------------- git 凭据弹窗

/**
 * 找 git 可执行文件。DSH 的宿主进程不继承 shell 的 PATH（实测 Electron 里
 * `git` 直接 ENOENT），所以按 DSH_GIT → PATH → 常见位置 的顺序试。
 */
let GIT_BIN = null
function gitCandidates() {
  const home = homedir()
  const out = []
  if (process.env.DSH_GIT) out.push(process.env.DSH_GIT)
  out.push('git')
  if (process.platform === 'win32') {
    // dsh-ops 自带的 MSYS2 版 git（本机就是这套）
    try {
      const profiles = join(home, '.dsh', 'profiles')
      for (const p of readdirSync(profiles)) {
        const base = join(profiles, p, 'node_modules', '@dsh-ops')
        let pkgs = []
        try { pkgs = readdirSync(base) } catch { continue }
        for (const pkg of pkgs) {
          out.push(join(base, pkg, 'ucrt64', 'bin', 'git.exe'))
          out.push(join(base, pkg, 'mingw64', 'bin', 'git.exe'))
        }
      }
    } catch {}
    out.push('C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe')
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'))
  } else {
    out.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
  }
  return out
}

async function resolveGit() {
  if (GIT_BIN !== null) return GIT_BIN
  for (const bin of gitCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000, windowsHide: true })
      if (/git version/i.test(String(stdout))) {
        GIT_BIN = bin
        return bin
      }
    } catch {}
  }
  GIT_BIN = ''
  return ''
}

/** 跑一条 git 命令，不抛异常。 */
async function gitCmd(args, timeoutMs = 8000) {
  const bin = await resolveGit()
  if (!bin) return { ok: false, out: '', err: 'git 不可用（可设 DSH_GIT 指向 git 可执行文件）' }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: timeoutMs, windowsHide: true })
    return { ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() }
  } catch (error) {
    return { ok: false, out: '', err: String((error && (error.stderr || error.message)) || error).trim() }
  }
}

/** 各平台 GCM 支持的存储后端。 */
function credentialStoreFor(platform) {
  if (platform === 'win32') return 'wincred'
  if (platform === 'darwin') return 'osxkeychain'
  return 'secretservice'
}

/**
 * 为什么会反复弹 CredentialHelperSelector：
 *   · git 的 system 配置把 credential.helper 设成了 `helper-selector`
 *     —— 这个 helper 的职责就是弹「选哪个凭据助手」；
 *   · 同时 credential.credentialStore 没配，GCM 不知道往哪存，于是每次都问。
 * 修法：global 里写死 store（wincred），并把 helper 从 helper-selector 换成 manager。
 */
async function gitAuthStatus() {
  const version = await gitCmd(['--version'])
  if (!version.ok || !version.out) {
    // 找不到 git 时不要假装「配置就绪」：说清现状和修法
    return { available: false, version: version.err || '(git 不可用)', helpers: [], effective: [], store: '', selector: [], needFix: false, platform: process.platform }
  }
  // 按「实际生效顺序」读回来：system → global → local，空值会清空此前累积的列表。
  // 只看原始值会误判 —— 修过之后 system 里那条 helper-selector 仍然在，但已被 global 的空值重置掉。
  const all = await gitCmd(['config', '--show-origin', '--get-all', 'credential.helper'])
  const rows = all.out.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t')
    return {
      origin: tab >= 0 ? line.slice(0, tab) : '',
      value: (tab >= 0 ? line.slice(tab + 1) : line).trim(),
    }
  })
  const effective = []
  for (const r of rows) {
    if (!r.value) effective.length = 0 // 空值 = 重置
    else effective.push(r.value)
  }
  const globalStore = await gitCmd(['config', '--global', '--get', 'credential.credentialStore'])
  const sysStore = await gitCmd(['config', '--system', '--get', 'credential.credentialStore'])
  const store = (globalStore.out || sysStore.out || '').trim()
  const selector = effective.filter((h) => /helper-selector/i.test(h))
  const needFix = selector.length > 0 || (effective.some((h) => /manager/i.test(h)) && !store)
  return {
    available: true,
    version: version.out,
    helpers: rows.map((r) => r.value || '(空值/重置)'),
    effective,
    store,
    selector,
    needFix,
    platform: process.platform,
  }
}

async function gitAuthFix() {
  const before = await gitAuthStatus()
  const store = credentialStoreFor(process.platform)
  const steps = []
  steps.push({ key: 'credential.credentialStore', value: store, res: await gitCmd(['config', '--global', 'credential.credentialStore', store]) })
  // 关键：git 的 credential.helper 是**多层叠加**的，system 里的 helper-selector
  // 不会因为 global 写了 manager 就消失。必须先清空 global 里的同名项，
  // 写一条空值（git 的约定：空值 = 重置此前累积的 helper 列表），再写 manager。
  await gitCmd(['config', '--global', '--unset-all', 'credential.helper'])
  steps.push({ key: 'credential.helper', value: '(reset)', res: await gitCmd(['config', '--global', '--add', 'credential.helper', '']) })
  steps.push({ key: 'credential.helper', value: 'manager', res: await gitCmd(['config', '--global', '--add', 'credential.helper', 'manager']) })
  const after = await gitAuthStatus()
  return { before, after, store, steps, ok: !after.needFix }
}

// ---------------------------------------------------------------- http

/** 通过 HTTP 代理开一条到 host:port 的隧道（CONNECT），返回裸 socket。 */
function openTunnel (proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let p
    try {
      p = new URL(proxyUrl)
    } catch {
      reject(new Error('proxyUrl 不是合法 URL：' + proxyUrl))
      return
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      timeout: timeoutMs,
      agent: false,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('代理连接超时')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 发一个 JSON 请求。有 proxyUrl 就走 CONNECT 隧道（Node 的 fetch 不读代理，
 * 这也是为什么这个插件自己实现了一层）。
 */
async function requestJson (url, { method = 'GET', body, token, timeoutMs, proxyUrl, headers } = {}) {
  const u = new URL(url)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const baseHeaders = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-github',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    ...(headers || {}),
  }

  if (!proxyUrl) {
    const res = await fetch(url, {
      method,
      headers: baseHeaders,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text }
  }

  const socket = await openTunnel(proxyUrl, u.hostname, Number(u.port) || 443, timeoutMs)
  return await new Promise((resolve, reject) => {
    const req = https.request({
      method,
      host: u.hostname,
      port: Number(u.port) || 443,
      path: u.pathname + (u.search || ''),
      headers: baseHeaders,
      agent: false,
      timeout: timeoutMs,
      createConnection: () => tls.connect({ socket, servername: u.hostname }),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 上传附件（multipart 不用，直接用 octet-stream + ?name=）。 */
async function requestBinary (url, { body, contentType, token, timeoutMs, proxyUrl } = {}) {
  const u = new URL(url)
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-github',
    authorization: 'Bearer ' + token,
    'content-type': contentType || 'application/octet-stream',
    'content-length': body.length,
  }

  if (!proxyUrl) {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    return { status: res.status, ok: res.ok, text }
  }

  const socket = await openTunnel(proxyUrl, u.hostname, Number(u.port) || 443, timeoutMs)
  return await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: u.hostname,
      port: Number(u.port) || 443,
      path: u.pathname + (u.search || ''),
      headers,
      agent: false,
      timeout: timeoutMs,
      createConnection: () => tls.connect({ socket, servername: u.hostname }),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('上传超时')))
    req.on('error', reject)
    req.end(body)
  })
}

function parseBody (text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/** 统一收口：错误、限流、结果裁剪。 */
async function call (settings, path, opts = {}) {
  if (!settings.token) {
    return {
      ok: false,
      error: '没有配置 GitHub token。打开「设置 → GitHub」把 token 粘进去（或在 ~/.dsh/storages/dsh-github/settings.json 里写 token 字段）。',
    }
  }
  const url = /^https?:\/\//i.test(path) ? path : settings.apiBase + path
  let res
  try {
    res = await requestJson(url, {
      method: opts.method || 'GET',
      body: opts.body,
      token: settings.token,
      timeoutMs: settings.timeoutMs,
      proxyUrl: settings.proxyUrl,
    })
  } catch (error) {
    return { ok: false, error: '请求失败：' + String((error && error.message) || error) }
  }

  const json = parseBody(res.text)
  if (!res.ok) {
    // GitHub 常把真正的原因放在 errors[].message 里（例如 "name already exists"），
    // 只回 message 会得到 "Repository creation failed." 这种没用的信息。
    const details = Array.isArray(json && json.errors)
      ? json.errors.map((e) => e && (e.message || e.code)).filter(Boolean).join('；')
      : ''
    const message = (json && json.message) || res.text.slice(0, 200) || ('HTTP ' + res.status)
    let hint = ''
    if (res.status === 401) hint = '（token 无效或已过期）'
    else if (res.status === 403) hint = '（可能是权限不足，或触发了 API 速率限制）'
    else if (res.status === 404) hint = '（仓库/路径不存在，或这个 token 没有访问权）'
    else if (res.status === 422) hint = details ? '（' + details + '）' : '（参数不合法，或者已经存在）'
    else if (details) hint = '（' + details + '）'
    return { ok: false, status: res.status, error: message + hint, body: json }
  }
  return { ok: true, status: res.status, headers: res.headers, json, text: res.text }
}

/** 把结果压到 maxChars 以内，避免一次 API 调用吃掉上下文。 */
function trim (value, maxChars) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n…（已截断，原长 ${text.length} 字符；用 max_chars 调大，或改用更精确的 path）`
}

// ---------------------------------------------------------------- tools

export function apply (ctx, config) {
  const settingsOf = () => resolveSettings(config)

  // ---- 设置路由：GET 返回掩码快照，POST 只接受 token / apiBase / proxyUrl
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({
        kind: 'exact',
        path: '/_dsh-github/settings',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, snapshot(settingsOf()))
              return
            }
            if (req.method === 'POST') {
              const body = await readJsonBody(req)
              let patch
              try {
                patch = sanitizePatch(body || {})
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
                return
              }
              if (Object.keys(patch).length === 0) {
                sendJson(res, 400, { ok: false, error: '没有可更新的字段' })
                return
              }
              writeSettingsFile(patch)
              sendJson(res, 200, snapshot(settingsOf()))
              return
            }
            sendJson(res, 405, { ok: false, error: 'GET / POST only' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
      'dsh-github: settings route',
    )

    // git 凭据弹窗：GET 看状态，POST { apply: true } 修
    ctx.effect(
      () => webServer.register({
        kind: 'exact',
        path: '/_dsh-github/git-auth',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, status: await gitAuthStatus() })
              return
            }
            if (req.method === 'POST') {
              const body = await readJsonBody(req)
              if (body && body.apply === true) {
                const r = await gitAuthFix()
                sendJson(res, 200, { ok: r.ok, status: r.after, steps: r.steps.map((s) => ({ key: s.key, value: s.value, ok: s.res.ok })) })
                return
              }
              sendJson(res, 200, { ok: true, status: await gitAuthStatus() })
              return
            }
            sendJson(res, 405, { ok: false, error: 'GET / POST only' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
      'dsh-github: git-auth route',
    )
  }

  // ---- github_status
  ctx.tools.register(defineTool({
    name: 'github_status',
    description:
      '看看当前配置的 GitHub token 是谁的、有哪些权限、还剩多少 API 配额。' +
      '不返回 token 本身（只给前 4 位和后 4 位），可以放心调用。' +
      '没配 token 时返回一句提示，不会报错。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async () => {
      const s = settingsOf()
      if (!s.token) {
        return { text: '还没有配置 GitHub token：打开「设置 → GitHub」，把 token 粘进去（输入框里只有示例，没有默认值）。' }
      }
      const user = await call(s, '/user')
      if (!user.ok) return { text: 'token 检查失败：' + user.error }
      const rate = await call(s, '/rate_limit')
      const scopes = user.headers && (user.headers['x-oauth-scopes'] || '')
      const d = user.json || {}
      const lines = [
        '✅ token 可用：' + (d.login || '?') + (d.name ? '（' + d.name + '）' : ''),
        'token：' + maskToken(s.token) + ' · 代理：' + (s.proxyUrl || '直连'),
        'API：' + s.apiBase,
      ]
      if (scopes) lines.push('scopes：' + scopes)
      else lines.push('scopes：（细粒度 token 不在响应头里报 scope，看仓库权限页）')
      if (rate.ok && rate.json && rate.json.rate) {
        lines.push('配额：' + rate.json.rate.remaining + '/' + rate.json.rate.limit)
      }
      return { text: lines.join('\n'), login: d.login, scopes: scopes || null, settingsPath: SETTINGS_PATH }
    },
  }))

  // ---- github_fix_git_auth
  ctx.tools.register(defineTool({
    name: 'github_fix_git_auth',
    description:
      '修「git 老是弹 CredentialHelperSelector（选哪个凭据助手）」这个弹窗。\n\n' +
      '成因通常是：git 的 system 配置把 `credential.helper` 设成了 `helper-selector`，' +
      '而 `credential.credentialStore` 没配 —— 前者专门负责弹框问你要哪个存储后端。\n\n' +
      '默认只**检查**并告诉你现状；传 `apply: true` 才真的写 `~/.gitconfig`：' +
      '把 store 设成本平台默认（Windows=wincred / macOS=osxkeychain / Linux=secretservice），' +
      '并把 helper 换成 `manager`。只影响 git 自己的凭据存储，不碰任何 token。',
    parameters: {
      apply: { type: 'boolean', description: 'true = 写入 ~/.gitconfig 修复；默认 false 只检查' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      if (args.apply !== true) {
        const s = await gitAuthStatus()
        if (s.available === false) {
          return { text: '找不到 git 可执行文件（DSH 宿主进程不继承 shell 的 PATH）。\n' + s.version + '\n\n修法：设置环境变量 DSH_GIT 指向 git.exe，或把 git 放进 PATH 后重启 DSH。', status: s }
        }
        const lines = [
          'git：' + s.version,
          '生效的 helper：' + (s.effective.length ? s.effective.join(' / ') : '（未设置）'),
          '原始配置：' + (s.helpers.length ? s.helpers.join(' / ') : '（未设置）'),
          'credentialStore：' + (s.store || '（未设置）'),
          s.needFix
            ? '⚠️ 会弹「选凭据助手」：' + (s.selector.length ? '生效的 helper 里含 helper-selector' : '有 manager 但没配 store') +
              '\n要修就调用 github_fix_git_auth({ apply: true })，会写 ~/.gitconfig（只改 git 凭据存储，不碰 token）'
            : '✅ 配置就绪，不会弹选择框',
        ]
        return { text: lines.join('\n'), status: s }
      }
      const r = await gitAuthFix()
      const lines = [
        r.ok ? '✅ 已修复' : '⚠️ 写入后仍需检查',
        '写入：' + r.steps.map((s) => `${s.key}=${s.value}${s.res.ok ? '' : '（失败：' + s.res.err + '）'}`).join('；'),
        '现在生效的 helper：' + (r.after.effective.length ? r.after.effective.join(' / ') : '（未设置）'),
        '现在 store：' + (r.after.store || '（未设置）'),
        '',
        '下次 git 需要凭据时不会再弹选择框；第一次仍会让你输入一次账号/token（之后按 store 记住）。',
      ]
      return { text: lines.join('\n'), status: r.after }
    },
  }))

  // ---- github_api
  ctx.tools.register(defineTool({
    name: 'github_api',
    description:
      '直接调 GitHub REST API（自动带上设置里的 token）。' +
      'path 写相对路径（如 `/repos/owner/repo`、`/user/repos`）或完整 URL；GET 优先，' +
      '写操作（POST/PUT/PATCH/DELETE）会在描述里说明会改什么，别拿它试探。\n\n' +
      '返回体默认压到 max_chars，超了会截断并告诉你原长；要看完整某一段就用更精确的 path。\n\n' +
      '常用：`/user` 我是谁；`/repos/{owner}/{repo}` 仓库信息；`/repos/{owner}/{repo}/issues?state=open`；' +
      '`/search/repositories?q=...` 搜仓库。',
    parameters: {
      path: { type: 'string', required: true, description: '相对路径（/repos/...）或完整 https URL' },
      method: { type: 'string', description: 'GET（默认）/ POST / PUT / PATCH / DELETE' },
      body: { type: 'string', description: 'JSON 字符串；只对写操作有意义' },
      max_chars: { type: 'number', description: '返回体上限，默认取设置里的 6000' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const s = settingsOf()
      let parsedBody
      if (args.body !== undefined && args.body !== '') {
        try {
          parsedBody = typeof args.body === 'string' ? JSON.parse(args.body) : args.body
        } catch {
          return { text: 'body 不是合法 JSON：' + String(args.body).slice(0, 120) }
        }
      }
      const res = await call(s, String(args.path || ''), {
        method: String(args.method || 'GET').toUpperCase(),
        body: parsedBody,
      })
      if (!res.ok) return { text: '❌ ' + res.error + (res.status ? '（HTTP ' + res.status + '）' : '') }
      const max = Math.max(500, Number(args.max_chars) || s.maxChars)
      return { text: trim(res.json === null ? res.text : res.json, max), status: res.status }
    },
  }))

  // ---- github_push_files
  ctx.tools.register(defineTool({
    name: 'github_push_files',
    description:
      '把一批文件作为**一个 commit** 推到 GitHub（走 Git Data API：blob → tree → commit → 更新 ref）。' +
      '空仓库也能用（自动建第一条 commit 和 main 分支）。\n\n' +
      'files 传数组最清楚：`[{"path":"README.md","content":"…"},{"path":"src/a.js","content":"…"}]`；' +
      '二进制内容用 `{"path":"x.png","content":"<base64>","encoding":"base64"}`。' +
      '也可以用对象一次给多份：`{"README.md":"…","LICENSE":"…"}`。\n\n' +
      '注意：这是**新增/覆盖**，不会删除仓库里已有的其它文件（base_tree 之上叠加）。',
    parameters: {
      repo: { type: 'string', required: true, description: '"owner/name"，例如 KNLCXY/dsh-github' },
      message: { type: 'string', required: true, description: 'commit message' },
      files: { type: 'string', required: true, description: 'JSON：数组 [{path, content, encoding?}] 或对象 {path: content}' },
      branch: { type: 'string', description: '目标分支，默认仓库的 default_branch' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const s = settingsOf()
      const repo = String(args.repo || '').trim()
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { text: 'repo 要写成 "owner/name"' }

      let files
      try {
        files = typeof args.files === 'string' ? JSON.parse(args.files) : args.files
      } catch {
        return { text: 'files 不是合法 JSON' }
      }
      const list = Array.isArray(files)
        ? files
        : Object.entries(files || {}).map(([path, content]) => ({ path, content }))
      if (list.length === 0) return { text: 'files 是空的' }

      // 1. 仓库信息 → 默认分支
      const info = await call(s, '/repos/' + repo)
      if (!info.ok) return { text: '找不到仓库 ' + repo + '：' + info.error }
      const branch = String(args.branch || (info.json && info.json.default_branch) || 'main')

      // 2. 当前 ref（空仓库会 404）
      const ref = await call(s, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
      const parentSha = ref.ok && ref.json && ref.json.object ? ref.json.object.sha : null
      let baseTree = null
      if (parentSha) {
        const commitInfo = await call(s, `/repos/${repo}/git/commits/${parentSha}`)
        baseTree = commitInfo.ok && commitInfo.json ? commitInfo.json.tree.sha : null
      }

      // 3. blobs
      const tree = []
      for (const f of list) {
        const path = String(f.path || '').replace(/^\/+/, '')
        if (!path) return { text: 'files 里有空 path' }
        const isB64 = f.encoding === 'base64'
        const content = String(f.content === undefined ? '' : f.content)
        const blob = await call(s, `/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: isB64 ? { content, encoding: 'base64' } : { content, encoding: 'utf-8' },
        })
        if (!blob.ok) return { text: '写 blob 失败（' + path + '）：' + blob.error }
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.json.sha })
      }

      // 4. tree（有 base_tree 时在其上叠加，不会删掉别的文件）
      const treeRes = await call(s, `/repos/${repo}/git/trees`, {
        method: 'POST',
        body: baseTree ? { base_tree: baseTree, tree } : { tree },
      })
      if (!treeRes.ok) return { text: '写 tree 失败：' + treeRes.error }

      // 5. commit
      const commitRes = await call(s, `/repos/${repo}/git/commits`, {
        method: 'POST',
        body: { message: String(args.message), tree: treeRes.json.sha, parents: parentSha ? [parentSha] : [] },
      })
      if (!commitRes.ok) return { text: '写 commit 失败：' + commitRes.error }

      // 6. 更新 / 创建 ref
      const refRes = parentSha
        ? await call(s, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
            method: 'PATCH',
            body: { sha: commitRes.json.sha, force: false },
          })
        : await call(s, `/repos/${repo}/git/refs`, {
            method: 'POST',
            body: { ref: 'refs/heads/' + branch, sha: commitRes.json.sha },
          })
      if (!refRes.ok) return { text: '更新分支失败：' + refRes.error }

      const short = String(commitRes.json.sha).slice(0, 7)
      return {
        text: '✅ 已提交 ' + list.length + ' 个文件到 ' + repo + '@' + branch + '\n' +
          'commit ' + short + ' · ' + String(args.message).split('\n')[0].slice(0, 80) + '\n' +
          'https://github.com/' + repo + '/commit/' + commitRes.json.sha,
        commit: commitRes.json.sha,
        branch,
      }
    },
  }))

  // ---- github_release_create
  ctx.tools.register(defineTool({
    name: 'github_release_create',
    description:
      '建一个 GitHub Release 并上传本地附件（一条命令替代「建 tag → 建 release → 传附件 → 校验」这一串）。\n\n' +
      '`tag` 不存在时会按 `target`（默认仓库默认分支）自动创建。' +
      '`assets` 传本地文件路径（逗号或 JSON 数组），会依次上传到 uploads.github.com；' +
      '单个文件上限 2GB，重名会报错（先删旧附件）。\n\n' +
      '注意：这是**写操作**，会给仓库产生一个公开 Release（`draft: true` 则不公开）。',
    parameters: {
      repo: { type: 'string', required: true, description: '"owner/name"' },
      tag: { type: 'string', required: true, description: 'tag 名，例如 v1.0.0（不存在会自动创建）' },
      name: { type: 'string', description: 'Release 标题，默认用 tag' },
      body: { type: 'string', description: 'Release 说明（markdown）' },
      assets: { type: 'string', description: '本地附件路径，逗号分隔或 JSON 数组' },
      target: { type: 'string', description: 'tag 指向的分支或 commit，默认仓库默认分支' },
      draft: { type: 'boolean', description: 'true = 先存成草稿，不公开' },
      prerelease: { type: 'boolean', description: 'true = 标记为预发布' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const s = settingsOf()
      const repo = String(args.repo || '').trim()
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { text: 'repo 要写成 "owner/name"' }
      const tag = String(args.tag || '').trim()
      if (!tag) return { text: 'tag 不能为空' }

      // 1) 建 release（tag 不存在时 GitHub 会自动在 target 上创建）
      const payload = {
        tag_name: tag,
        name: String(args.name || tag),
        body: String(args.body || ''),
        draft: args.draft === true,
        prerelease: args.prerelease === true,
      }
      if (args.target) payload.target_commitish = String(args.target)
      const created = await call(s, `/repos/${repo}/releases`, { method: 'POST', body: payload })
      if (!created.ok) return { text: '建 Release 失败：' + created.error }
      const rel = created.json || {}
      const lines = ['✅ Release 已创建：' + (rel.html_url || tag)]

      // 2) 逐个上传附件
      let paths = []
      if (args.assets) {
        try {
          paths = Array.isArray(args.assets) ? args.assets : JSON.parse(String(args.assets))
        } catch {
          paths = String(args.assets).split(/[,，\n]/).map((x) => x.trim()).filter(Boolean)
        }
        if (!Array.isArray(paths)) paths = [String(args.assets)]
      }
      const uploaded = []
      for (const raw of paths) {
        const file = String(raw || '').trim()
        if (!file) continue
        let buf
        try {
          buf = readFileSync(file)
        } catch (error) {
          lines.push('⚠️ 读不到文件 ' + file + '：' + String((error && error.message) || error))
          continue
        }
        const name = file.split(/[\\/]/).pop()
        const url = `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`
        const up = await requestBinary(url, {
          body: buf,
          contentType: /\.gz$|\.tgz$/i.test(name) ? 'application/gzip' : /\.zip$/i.test(name) ? 'application/zip' : 'application/octet-stream',
          token: s.token,
          timeoutMs: Math.max(s.timeoutMs, 120000),
          proxyUrl: s.proxyUrl,
        })
        if (up.ok) {
          let asset = {}
          try { asset = JSON.parse(up.text) } catch {}
          uploaded.push(name)
          lines.push('  📎 ' + name + '（' + Math.round(buf.length / 1024) + ' KB）')
        } else {
          lines.push('  ⚠️ ' + name + ' 上传失败：HTTP ' + up.status + ' ' + up.text.slice(0, 160))
        }
      }
      if (uploaded.length) lines.push('附件：' + uploaded.length + ' 个')
      return { text: lines.join('\n'), release: rel.html_url || '', assets: uploaded }
    },
  }))

  // ---- github_repo_create
  ctx.tools.register(defineTool({
    name: 'github_repo_create',
    description:
      '新建一个仓库（默认 public），可选地顺手把 topics 设上 —— topics 决定它能不能被 GitHub 搜到。' +
      '仓库已存在时返回 422，不会覆盖。',
    parameters: {
      name: { type: 'string', required: true, description: '仓库名，只写名字，不要 owner/' },
      description: { type: 'string', description: '一句话描述（≤350 字符，会显示在仓库页和搜索结果里）' },
      private: { type: 'boolean', description: 'true = 私有，默认 public' },
      topics: { type: 'string', description: '逗号分隔的 topics，例如 "dsh,dsh-plugin,deepseek-harness"' },
      owner: { type: 'string', description: '组织名；不填 = 自己的账号' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const s = settingsOf()
      const payload = {
        name: String(args.name || '').trim(),
        description: String(args.description || ''),
        private: args.private === true,
        auto_init: false,
      }
      if (!payload.name) return { text: 'name 不能为空' }
      const path = args.owner ? '/orgs/' + String(args.owner).trim() + '/repos' : '/user/repos'
      const res = await call(s, path, { method: 'POST', body: payload })
      if (!res.ok) return { text: '建仓库失败：' + res.error }
      const full = res.json.full_name
      const lines = ['✅ 已创建 ' + full + '（' + (res.json.private ? '私有' : '公开') + '）', 'https://github.com/' + full]

      const topics = String(args.topics || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20)
      if (topics.length) {
        const t = await call(s, '/repos/' + full + '/topics', { method: 'PUT', body: { names: topics } })
        lines.push(t.ok ? 'topics：' + topics.join(', ') : 'topics 设置失败：' + t.error)
      }
      return { text: lines.join('\n'), repo: full }
    },
  }))
}

// ---------------------------------------------------------------- helpers

function snapshot (s) {
  return {
    ok: true,
    hasToken: Boolean(s.token),
    tokenHint: s.token ? maskToken(s.token) : '',
    // 只给示例，不回显、也不当默认值
    tokenPlaceholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
    apiBase: s.apiBase,
    proxyUrl: s.proxyUrl,
    settingsPath: SETTINGS_PATH,
  }
}

function sanitizePatch (body) {
  const patch = {}
  if (body.token !== undefined) {
    const t = String(body.token || '').trim()
    if (t === '') {
      patch.token = ''
    } else if (!/^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,})$/.test(t)) {
      throw new Error('token 形状不对：classic 是 ghp_ 开头，fine-grained 是 github_pat_ 开头')
    } else {
      patch.token = t
    }
  }
  if (body.apiBase !== undefined) {
    const v = String(body.apiBase || '').trim().replace(/\/+$/, '')
    if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('apiBase 必须是 http(s):// 开头的 URL')
    patch.apiBase = v || DEFAULTS.apiBase
  }
  if (body.proxyUrl !== undefined) {
    const v = String(body.proxyUrl || '').trim()
    if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('代理地址必须是 http:// 或 https:// 开头（留空 = 直连）')
    patch.proxyUrl = v
  }
  return patch
}

function sendJson (res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readJsonBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}
