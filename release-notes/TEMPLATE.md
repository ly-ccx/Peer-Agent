<!--
发布说明模板。复制本文件为 release-notes/v<版本>.md（如 v0.0.1-beta.7.md），
填写本版本的更新内容后再发布。该文件会作为 GitHub Release 正文，
并在桌面端「发现新版本」弹窗中按用户界面语言展示对应段落。

写作建议：
- 用使用者能感知的语言描述变化，不要堆砌 commit message。
- 按「新功能 / 优化 / 修复」分组，每条一句话；英文段用 What's New / Improvements / Fixes。
- 没有的分组可删除。
- 若本版含 CLI 产物，请保留下方「CLI（仅命令行）」/「CLI (command-line only)」小节。
- 必须使用 locale 标记分段，弹窗按用户设置切换中英文。
  推荐可见标记（单独成行；GitHub 渲染后仍保留，electron-updater 可识别）：
    locale:zh-CN
    locale:en-US
  仍兼容 HTML 注释 `<!-- locale:zh-CN -->`，但 GitHub 渲染 HTML 会剥掉注释，
  导致升级弹窗中英混显；新版本请优先用可见标记。
  若缺少某语言段落，客户端会回退到另一语言或全文。
-->

locale:zh-CN

## 新功能

-

## 优化

-

## 修复

-

## CLI（仅命令行）

- 本版 GitHub Release 附带 CLI 归档（与 Desktop 同 tag / 同版本）。
- 资产示例：`peer-darwin-arm64.tar.gz`（内含 `peer` + `peer-credential-helper`，**必须同目录**）。
- 安装方式：
  - **npm（有 `NPM_TOKEN` 且 publish 成功时）**：`npm i -g @peer-agent/cli`（或 `pnpm add -g @peer-agent/cli`），`postinstall` 自动拉本版归档。
  - **手动**：解压归档后将目录加入 `PATH`，执行 `peer --version` 校验，再运行 `peer`。
- 可不装 Desktop；会话与设置仍落在 `~/.peer-agent`，与客户端共享。

locale:en-US

## What's New
-

## Improvements

-

## Fixes

-

## CLI (command-line only)

- This GitHub Release ships a CLI archive under the same tag / version as Desktop.
- Asset example: `peer-darwin-arm64.tar.gz` (contains `peer` + `peer-credential-helper`; **must stay in the same directory**).
- Install:
  - **npm** (when `NPM_TOKEN` is set and publish succeeds): `npm i -g @peer-agent/cli` (or `pnpm add -g @peer-agent/cli`); `postinstall` pulls this version's archive.
  - **Manual**: unpack, add the directory to `PATH`, run `peer --version`, then `peer`.
- Desktop is optional; sessions and settings still live under `~/.peer-agent` and are shared with the app.
