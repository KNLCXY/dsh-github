// dsh-github — 用「你自己填的 GitHub token」干活：调 REST API、一次提交多个文件、
// 建仓库、看这个 token 是谁的。
//
// 设计约束（用户明确要求）：
//   · token 只存在插件自己的设置文件里（~/.dsh/storages/dsh-github/settings.json），
//     不进仓库、不进 cordis.patch.yml、不进任何工具输出；
//   · 设置页里那格**只有示例占位符，没有默认值** —— 不填就是没配；
//   · 所有工具在没有 token 时给一句人话提示，而不是抛异常。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
