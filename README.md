# dsh-github

给 [DeepSeek Harness](https://deepseek.com)（DSH）用的 **GitHub 工具插件**。装上之后 agent 可以直接：调 GitHub REST API、**一次提交多个文件**（一个 commit）、建仓库、查这个 token 是谁的。

**token 你自己填** —— 在 `设置 → GitHub` 里粘一次，之后每个会话都能用。设置里那格**只有示例占位符，没有默认值**；插件源码、`cordis.patch.yml`、任何工具输出里都不会出现你的 token。

```
github_status        这个 token 是谁的、有什么权限、还剩多少配额（不回显 token）
github_api           直接调 REST API（相对路径或完整 URL）
github_push_files    一批文件 = 一个 commit（blob → tree → commit → 更新 ref）
github_repo_create   建仓库，顺手设 topics
```

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/KNLCXY/dsh-github?label=release)](https://github.com/KNLCXY/dsh-github/releases/latest)

---

## 下载

不想 clone 就直接拿打包好的安装包：

**[⬇ dsh-github-0.1.1.tgz](https://github.com/KNLCXY/dsh-github/releases/latest/download/dsh-github-0.1.1.tgz)**

```bash
dsh plugin --profile <你的 profile> add "file:<下载路径>/dsh-github-0.1.1.tgz"
```

校验：同页附件 `SHA256SUMS.txt`（`sha256sum -c SHA256SUMS.txt`）。

---

## 安装

```bash
# 从 git 装
dsh plugin --profile <你的 profile> add github:KNLCXY/dsh-github

# 或从目录装（要改代码时）
dsh plugin --profile <你的 profile> add "file:/绝对路径/dsh-github"
```

装完**重启 DSH**（插件的宿主半和 client 半都在进程启动时组装一次）。

## 填 token（唯一的配置步骤）

打开 **设置 → GitHub**，把 token 粘进第一个输入框，点**保存**。

| 输入框 | 说明 |
|---|---|
| GitHub token | 只有示例占位符 `ghp_xxxxxxxxxxxxxxxxxxxx`，**没有默认值**；不填就是没配 |
| API 地址 | 留空用 `https://api.github.com`；只有 GitHub Enterprise 才需要改 |
| 代理 | 留空 = 直连。GitHub 直连超时的网络填 `http://127.0.0.1:7897` |

也可以直接写文件（等价，改完下一轮工具调用即生效，不用重启）：

```jsonc
// ~/.dsh/storages/dsh-github/settings.json
{
  "token": "ghp_xxxxxxxxxxxxxxxxxxxx",
  "apiBase": "https://api.github.com",
  "proxyUrl": "http://127.0.0.1:7897"
}
```

### token 怎么建、要什么权限

| 你想干什么 | 最小权限 |
|---|---|
| 只读仓库、看 issue / PR | Contents: Read（+ Issues: Read） |
| **提交文件**（`github_push_files`） | **Contents: Read and write** |
| 建仓库、设 topics | 再加 **Administration: Read and write** |
| 用 classic token 图省事 | 勾一个 **`repo`** 就全有了 |

- fine-grained：<https://github.com/settings/personal-access-tokens/new> → 选仓库 → 配上面几项 → Generate
- classic：<https://github.com/settings/tokens/new> → 勾 `repo` → Generate

**建议设过期时间**（7–30 天）。不用了随时在同一个页面 Revoke。

## 工具参考

### `github_status`

不带参数。返回登录名、token 掩码（`ghp_…9c31`）、scopes、API 配额余量。没配 token 时给一句提示，不报错。

```
✅ token 可用：KNLCXY
token：ghp_…9c31 · 代理：http://127.0.0.1:7897
scopes：repo
配额：4986/5000
```

### `github_api`

| 参数 | 说明 |
|---|---|
| `path` | 必填。`/repos/owner/repo` 这样的相对路径，或完整 `https://api.github.com/...` |
| `method` | `GET`（默认）/ `POST` / `PUT` / `PATCH` / `DELETE` |
| `body` | JSON 字符串，只对写操作有意义 |
| `max_chars` | 返回体上限，默认 6000，超了截断并告诉你原长 |

```js
github_api({ path: "/repos/KNLCXY/dsh-github" })
github_api({ path: "/search/repositories?q=dsh-plugin&sort=stars" })
github_api({ path: "/repos/KNLCXY/x/issues", method: "POST", body: '{"title":"hi","body":"…"}' })
```

错误会翻译成人话：`401`（token 无效/过期）、`403`（权限不足或限流）、`404`（仓库不存在或无权访问）。

### `github_push_files`

| 参数 | 说明 |
|---|---|
| `repo` | 必填，`"owner/name"` |
| `message` | 必填，commit message（多行只取第一行做摘要） |
| `files` | 必填。数组 `[{path, content, encoding?}]`，或对象 `{path: content}` |
| `branch` | 默认仓库的 `default_branch` |

```js
github_push_files({
  repo: "KNLCXY/scratch",
  message: "docs: 补 README",
  files: [
    { path: "README.md", content: "# hi\n" },
    { path: "docs/a.md", content: "…" },
    { path: "logo.png", content: "<base64>", encoding: "base64" },
  ],
})
```

返回 `✅ 已提交 N 个文件 … commit abc1234 … https://github.com/owner/repo/commit/…`。

行为说明：

- **空仓库也能用**：没有 `main` 时会自动建第一条 commit 和分支
- **只在 base_tree 上叠加**，不会顺手删掉仓库里别的文件
- 一个调用 = 一个 commit，不是 N 个
- 401/403 会明确告诉你是 token 权限问题

### `github_repo_create`

| 参数 | 说明 |
|---|---|
| `name` | 必填，只写名字（不带 `owner/`） |
| `description` | 一句话描述（≤350 字符，会进搜索结果） |
| `private` | 默认 `false` |
| `topics` | 逗号分隔，例如 `"dsh,dsh-plugin,deepseek-harness"` —— **决定能不能被搜到** |
| `owner` | 组织名；不填就是自己的账号 |

## 与 dsh-websift 的联动（可选）

dsh-github **单独可用**；联动只是让它借用 websift 的代理配置，省得设置两遍。

设置项 `linkWebsift` 三档：

| 值 | 行为 |
|---|---|
| `off` | 完全不看 websift，用自己设置里的 `proxyUrl` |
| **`auto`（默认）** | 先探测 websift 是否装着：没装 → **静默跳过**（行为与单装完全一致）；装了 → 只有自己 `proxyUrl` 为空时才借用 |
| `on` | 优先用 websift 的代理（便于统一管理） |

- 探测只读 `~/.dsh/storages/browser-kernel/settings.json`，**不调它的工具、不启动它的内核**
- 对方 `proxyMode: never`（一律直连）时不借
- 面板里会显示：是否检测到 websift、实际用的是哪个代理、来源是自己还是 websift

## 安全边界

| 事项 | 做法 |
|---|---|
| token 存在哪 | `~/.dsh/storages/dsh-github/settings.json`（本机，不进 git） |
| 会不会进 repo | 不会。仓库里的 `cordis.patch.yml` 写的是 `token: ''` |
| 会不会进工具输出 | 不会。只有 `github_status` 显示掩码（首 4 + 末 4） |
| 设置接口返回什么 | `hasToken` / `tokenHint` / 占位符，**没有 token 字段** |
| 明文出现在哪 | 只有设置文件本身和 `github_api` 发出去的 Authorization 头 |

想再稳一点：给 token 设 7 天过期，用完 Revoke；或者用只含目标仓库的 fine-grained token（不要 "All repositories"）。

## scripts/：三个可复用的旁路工具

> 这三个脚本也单独发了一个仓库（不装插件也能用，仓库里同样不含任何 key）：
> **[KNLCXY/dsh-github-scripts](https://github.com/KNLCXY/dsh-github-scripts)**


主流程用 token 走 API，这三个脚本是**没有 token 时**的旁路（也是本插件诞生的原因）：

| 脚本 | 干什么 |
|---|---|
| `gh-web-commit.mjs` | 不依赖 token，用浏览器里已登录的 GitHub 会话提交单个文件（驱动 GitHub 网页编辑器） |
| `gh-device-login.mjs` | 走 OAuth 设备流，用已登录的浏览器会话换一个 `gho_` token（scope 自己定） |
| `chrome-probe.mjs` | 用指定启动参数起内核、导航、跑 JS —— 排查「页面在自动化下不渲染」这类问题 |

```bash
ELECTRON_RUN_AS_NODE=1 "<DSH 目录>/DeepSeek Harness.exe" scripts/chrome-probe.mjs \
  "https://github.com/<you>/<repo>/new/main?filename=README.md" \
  --flag "--disable-blink-features=AutomationControlled" \
  --js "document.querySelectorAll('.cm-content').length"
```

两个入口都认环境变量：`DSH_CHROME`（内核路径）、`DSH_GH_PROFILE`（浏览器 profile 目录）。

> 踩过的坑（值得写下来）：GitHub 的文件编辑器在 `navigator.webdriver === true` 时**整块不渲染**，页面只剩 "Files main" 骨架。加 `--disable-blink-features=AutomationControlled` 才正常。这也是 `gh-web-commit.mjs` 默认带这个参数的原因。

## 排错

| 现象 | 原因 / 修法 |
|---|---|
| `还没有配置 GitHub token` | 去 设置 → GitHub 粘一个；或者写进 settings.json |
| `401 Bad credentials` | token 打错、已 Revoke、或复制时带了空格 |
| `403 Resource not accessible by personal access token` | 权限不够。fine-grained 要给 **Contents: Read and write**（推文件）或 **Administration**（建仓库/设 topics） |
| `403 API rate limit exceeded` | 未认证限流 60/小时，认证后 5000/小时；等一会儿或用别的 token |
| `404 Not Found` | 仓库名拼错，或 token 没有这个仓库的访问权（fine-grained 要显式选仓库） |
| 请求超时 / `fetch failed` | 这个网络到 GitHub 不稳，在设置里填代理（`http://127.0.0.1:7897`），或用 `github_status` 对比直连与代理 |
| 设置页没有「GitHub」 | client 半在进程启动时组装：**重启 DSH** |
| 反复弹 `CredentialHelperSelector` | git 的 system 配置把 `credential.helper` 设成了 `helper-selector`。用 `github_fix_git_auth({ apply: true })`，或在「设置 → GitHub」点「修复」——只改 git 凭据存储，不碰 token |

## 开发

```bash
# 纯逻辑冒烟（不联网、不需要 DSH）
node test/smoke.mjs
# 用 DSH 自带 Node 也一样
ELECTRON_RUN_AS_NODE=1 "<DSH>/DeepSeek Harness.exe" test/smoke.mjs
```

覆盖：4 个工具是否注册、设置路由的校验（坏 token 400 / 好 token 200 且只回显首末 4 位 / 明文不出现在响应里 / 清除 / 坏代理 400）、没 token 时的提示、`repo` 格式校验。

改完源码要生效：bump `package.json` 的 `version` → 重新 `dsh plugin add` → 重启 DSH。
（pnpm 是把包**复制**进 `node_modules`，版本号不变会说 "Already up to date"。）

实现要点见 [lib/index.js](lib/index.js) 顶部注释：代理是自实现的 CONNECT 隧道（Node 的 `fetch` 不读代理环境变量），所以 `proxyUrl` 一填，连 `api.github.com` 也能走隧道。


## git 凭据弹窗（CredentialHelperSelector）

Windows 上如果每次 git 要凭据都弹一个「Select a credential helper」的框，成因是：

```bash
git config --system --get-all credential.helper   # → helper-selector
git config --global --get credential.credentialStore  # → 空
```

`helper-selector` 这个 helper 的职责就是弹选择框；store 没配，它每次都问。

**修法**（注意 helper 是多层叠加的，只写 global `manager` 顶不掉 system 的那条）：

```bash
git config --global credential.credentialStore wincred
git config --global --unset-all credential.helper
git config --global --add credential.helper ""       # 空值 = 重置此前累积的列表
git config --global --add credential.helper manager
```

插件里做成了一条命令：

```js
github_fix_git_auth({})              // 只检查
github_fix_git_auth({ apply: true }) // 写入 ~/.gitconfig
```

或在「设置 → GitHub」点 **修复（写 ~/.gitconfig）**。只影响 git 的凭据存储位置，
不读取、不修改你的 GitHub token。

## 许可

[MIT](LICENSE) © KNLCXY
