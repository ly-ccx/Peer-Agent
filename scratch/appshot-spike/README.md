# Appshot Spike（S1–S5 实测脚手架）

历史 spike 归档，仅保留能力验证脚本、测量结果与本机 arm64 辅助产物；不参与产品构建或运行时打包。目录内的 `.gitignore` 继续阻止后续实验产物被默认加入。
结论回写至 peer-knowledge：
- `design/product/appshots-engineering-task-breakdown.md` §3
- `design/product/appshots-window-context-capture.md` §13

## 运行

```bash
# S1 前台窗口识别（osascript 路径）
node s1-frontmost.mjs

# S2 单窗口截图（screencapture -l CLI 路径；需 Screen Recording 权限）
node s2-capture-cli.mjs

# S4 权限读数（Electron systemPreferences；用仓库内 electron 运行）
../../node_modules/.bin/electron s4-permission.mjs
```

产物（PNG / JSON 计时）写入 `out/`。

## 范围声明

- 仅 macOS。
- S3（热键）主要靠对 shortcut-service.mjs 的静态分析 + Electron 文档事实；双 ⌘ 不做实现。
- S5（附件链路）以代码路径分析为主，必要时用最小 IPC 验证。
