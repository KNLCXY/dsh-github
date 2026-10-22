# Changelog

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
