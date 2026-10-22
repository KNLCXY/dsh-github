// smoke.mjs — 不需要 DSH、不联网的冒烟测试：
//   1. apply() 是否注册了 4 个工具和设置路由
//   2. 设置接口的校验（坏 token 400、好 token 200 且只回显末 4 位、清除）
//   3. token 永远不会以明文出现在快照里
//
// 跑：node test/smoke.mjs
// 用 DSH 自带 Node 也行：ELECTRON_RUN_AS_NODE=1 "<DSH>/DeepSeek Harness.exe" test/smoke.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const STORE = mkdtempSync(join(tmpdir(), 'dsh-github-test-'))
process.env.DSH_GITHUB_STORE = STORE

// 把 @deepseek-ai/dsh-tools 换成桩，这样不装 DSH 也能 import
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  .replace(/from '@deepseek-ai\/dsh-tools'/, "from 'data:text/javascript,export const defineTool = (d) => d'")
const tmpPlugin = join(STORE, 'index.mjs')
writeFileSync(tmpPlugin, src, 'utf8')
const mod = await import(pathToFileURL(tmpPlugin).href)

let failed = 0
function check (name, cond, extra = '') {
  if (cond) { console.log('  ok   ' + name) } else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')) }
}

// ---- 假 ctx
const tools = []
const routes = []
const ctx = {
  get: (k) => {
    if (k !== 'webServer') return undefined
    return { register: (r) => { routes.push(r); return () => {} } }
  },
  tools: { register: (t) => tools.push(t) },
  effect: (fn, label) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}

mod.apply(ctx, {})
const names = tools.map((t) => t.name).sort()
check('注册 5 个工具', names.length === 5, JSON.stringify(names))
check('工具名齐全', ['github_api', 'github_fix_git_auth', 'github_push_files', 'github_repo_create', 'github_status'].every((n) => names.includes(n)), JSON.stringify(names))
check('注册两条路由', routes.length === 2 && routes.some((r) => r.path === '/_dsh-github/settings') && routes.some((r) => r.path === '/_dsh-github/git-auth'), JSON.stringify(routes.map((r) => r.path)))
check('每个工具都有 render', tools.every((t) => t.output && typeof t.output.render === 'function'))

// ---- 假 req/res
function fakeRes () {
  const r = { status: 0, body: '' }
  r.writeHead = (s) => { r.status = s }
  r.end = (t) => { r.body += t || '' }
  r.json = () => JSON.parse(r.body)
  return r
}
function fakeReq (method, payload) {
  if (payload === undefined) {
    return { method, url: '/_dsh-github/settings' }
  }
  const stream = Readable.from([JSON.stringify(payload)])
  stream.method = method
  stream.url = '/_dsh-github/settings'
  return stream
}
const handler = routes.find((r) => r.path === '/_dsh-github/settings').handler
const gitHandler = routes.find((r) => r.path === '/_dsh-github/git-auth').handler

// 1) 初始：没有 token，且有示例占位符（不是默认值）
let res = fakeRes()
await handler(fakeReq('GET'), res)
check('GET 200', res.status === 200)
check('初始 hasToken=false', res.json().hasToken === false, JSON.stringify(res.json()))
check('占位符是示例字符串', res.json().tokenPlaceholder === 'ghp_xxxxxxxxxxxxxxxxxxxx')
check('快照里没有 token 字段', !('token' in res.json()))

// 2) 坏 token → 400
res = fakeRes()
await handler(fakeReq('POST', { token: 'not-a-token' }), res)
check('坏 token 400', res.status === 400, res.body)

// 3) 好 token → 200，只回显末 4 位
const GOOD = 'ghp_' + 'a'.repeat(20) + 'WXYZ'
res = fakeRes()
await handler(fakeReq('POST', { token: GOOD }), res)
check('好 token 200', res.status === 200, res.body)
check('hasToken=true', res.json().hasToken === true)
check('只回显首尾', res.json().tokenHint === 'ghp_…WXYZ', res.json().tokenHint)
check('不返回明文', !res.body.includes(GOOD))

// 4) 落盘内容里确实有 token（存在本地，这是唯一允许的地方）
const saved = JSON.parse(readFileSync(join(STORE, 'settings.json'), 'utf8'))
check('token 写进本地设置文件', saved.token === GOOD)

// 5) 代理地址校验
res = fakeRes()
await handler(fakeReq('POST', { proxyUrl: 'socks9://nope' }), res)
check('坏代理 400', res.status === 400, res.body)
res = fakeRes()
await handler(fakeReq('POST', { proxyUrl: 'http://127.0.0.1:7897' }), res)
check('好代理 200', res.status === 200, res.body)

// 6) 清除 token
res = fakeRes()
await handler(fakeReq('POST', { token: '' }), res)
check('清除后 hasToken=false', res.json().hasToken === false)

// 7) 没 token 时工具给提示而不是抛错
const status = tools.find((t) => t.name === 'github_status')
const out = await status.execute({})
check('没 token 时返回提示', typeof out.text === 'string' && out.text.includes('还没有配置'), out.text)

// 8) push_files 参数校验（不联网：repo 格式错就直接拒）
const push = tools.find((t) => t.name === 'github_push_files')
const bad = await push.execute({ repo: 'no-slash', message: 'x', files: '[]' })
check('repo 格式校验', /owner\/name/.test(bad.text), bad.text)

// 9) git 凭据路由：GET 应该读得到 helper / store（只读，不写配置）
res = fakeRes()
await gitHandler(fakeReq('GET'), res)
check('git-auth GET 200', res.status === 200, res.body)
check('git-auth 返回 helpers 数组', Array.isArray(res.json().status.helpers), JSON.stringify(res.json().status || {}))
check('git-auth 返回 needFix 布尔', typeof res.json().status.needFix === 'boolean')

// 10) github_fix_git_auth 默认只检查、不写配置
const fix = tools.find((t) => t.name === 'github_fix_git_auth')
const report = await fix.execute({})
check('默认不 apply 时只报告', typeof report.text === 'string' && /git：|helper（system \+ global）/.test(report.text), report.text)

console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`)
process.exit(failed === 0 ? 0 : 1)
