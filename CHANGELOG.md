# Changelog

## 0.4.0

新增 `linkWebsift` 联动开关（`off` / `auto` / `on`）：

- `auto`（默认）：**先探测** websift 是否装着 —— 没装就静默跳过，行为与单装完全一致；
  装了且自己 `proxyUrl` 为空时，借用它的代理
- 探测只读 websift 的 `settings.json`，不调用它的工具、不启动它的内核
- 对方 `proxyMode: never` 时不借
- 面板显示：是否检测到、实际用的代理、来源（自己 / websift）
- 实测四档：off+空 → 不用代理；auto+空 → 借 websift；auto+自己配 → 用自己的；on+自己配 → 优先 websift

## 0.3.1

- 三个旁路脚本不再硬编码内核路径：新增 `lib/detect-chrome.mjs`（多根目录扫描 +
  Chromium 特征校验 + 偏好排序），脚本改为 `DSH_CHROME` → 自动探测
- 与独立仓库 [dsh-github-scripts](https://github.com/KNLCXY/dsh-github-scripts) 保持一致

## 0.3.0

新增 `github_release_create`：一条命令替代「建 tag → 建 release → 传附件 → 校验」。

- `tag` 不存在时按 `target`（默认仓库默认分支）自动建
- `assets` 收本地文件路径（逗号分隔或 JSON 数组），按扩展名选 content-type
  （`.tgz/.gz` → gzip、`.zip` → zip，其余 octet-stream），逐个传到 uploads.github.com
- `draft: true` 先存草稿不公开
- 附件上传复用同一套 token 与代理隧道（有 `proxyUrl` 就走 CONNECT）

## 0.2.1

- 修 `github_fix_git_auth` 在 DSH 里报「git 不可用」：宿主进程不继承 shell 的 PATH，
  改为按 `DSH_GIT` → PATH → dsh-ops 自带 ucrt64/mingw64 → 常见安装位置 逐个探测并缓存
- 找不到 git 时不再假装「配置就绪」，直接说明并给修法

## 0.2.0

新增 `github_fix_git_auth`：修「git 老是弹 CredentialHelperSelector（选哪个凭据助手）」。

- 成因：git 的 **system** 配置里 `credential.helper = helper-selector`（这个 helper 的职责就是弹选择框），
  且 `credential.credentialStore` 没配 —— GCM 不知道往哪存，于是每次都问
- 注意：`credential.helper` 是**多层叠加**的，global 写 `manager` 不会顶掉 system 的
  `helper-selector`；必须先写一条空值重置列表，再写 `manager`
- 默认只检查；`apply: true` 才会写 `~/.gitconfig`（store 按平台取 wincred / osxkeychain / secretservice）
- 设置面板里也有「修复（写 ~/.gitconfig）」按钮，走 `/_dsh-github/git-auth`

## 0.1.1

- 错误信息带上 GitHub 的 `errors[].message`。以前建重名仓库只回
  `Repository creation failed.`，现在是 `Repository creation failed.（name already exists on this account）`

## 0.1.0

首个版本。

- **`github_status`**：查 token 身份、scopes、API 配额；只回显 `ghp_…9c31` 这种掩码
- **`github_api`**：通用 REST 调用，返回体按 `max_chars` 截断；401/403/404 翻译成人话
- **`github_push_files`**：一批文件 = 一个 commit（blob → tree → commit → 更新 ref）；
  空仓库能建第一条 commit；在 `base_tree` 上叠加，不删其它文件
- **`github_repo_create`**：建仓库 + 设 topics
- **设置面板**（`settings.section`）：token / API 地址 / 代理三个字段。
  token 那格**只有示例占位符，没有默认值**；接口只返回掩码和 `hasToken`
- **自实现代理**：`proxyUrl` 一填就走 CONNECT 隧道（Node 的 `fetch` 不读代理环境变量）
- **旁路脚本**：`scripts/gh-web-commit.mjs`（无 token 提交）、`scripts/gh-device-login.mjs`
  （OAuth 设备流）、`scripts/chrome-probe.mjs`（内核参数排查）
- **冒烟测试**：`test/smoke.mjs`，19 项，不联网、不需要 DSH
