<!--
发布说明模板。复制本文件为 release-notes/v<版本>.md（如 v0.0.1-beta.7.md），
填写本版本的更新内容后再发布。该文件会作为 GitHub Release 正文，
并在桌面端「发现新版本」弹窗中展示，请使用清晰、面向用户的中文描述。

写作建议：
- 用使用者能感知的语言描述变化，不要堆砌 commit message。
- 按「新功能 / 优化 / 修复」分组，每条一句话。
- 没有的分组可删除。
- 若本版含 CLI 产物，请保留下方「CLI（仅命令行）」小节，写清归档名与同目录约束。
-->

## 新功能

- 

## 优化

- 

## 修复

- 

## CLI（仅命令行）

- 本版 GitHub Release 附带 CLI 归档（与 Desktop 同 tag / 同版本）。
- 资产示例：`peer-darwin-arm64.tar.gz`（内含 `peer` + `peer-credential-helper`，**必须同目录**）。
- 安装：解压后将目录加入 `PATH`，执行 `peer --version` 校验，再运行 `peer`。
- 可不装 Desktop；会话与设置仍落在 `~/.peer-agent`，与客户端共享。 
