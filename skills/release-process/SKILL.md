---
name: release-process
description: Peer Agent 发版流程（版本戳、release notes、CHANGELOG、GitHub Pages 文档站、打 tag 触发 CI）。
whenToUse: 用户要求发版、打 beta/正式 tag、写 release notes、更新 CHANGELOG、同步 docs 站点/Pages，或询问如何发布 Desktop/CLI。
version: 0.1.0
---

# Peer Agent 发布流程 Skill

在本仓库执行一次 **beta / 正式发版**。  
本 Skill 在既有 tag 驱动 CI 流程之上，**强制纳入文档站与 Changelog 更新**，避免“只发安装包、文档还是旧的”。

## 范围与事实源

| 项 | 路径 / 事实 |
|---|---|
| 版本权威（发布时） | git tag `v*`（如 `v0.0.1-beta.44` / `v0.1.0`） |
| 仓库基线版本文件 | `VERSION` + 各 `package.json` / Cargo 清单（由 `scripts/stamp-version.mjs` 回写） |
| 产品说明（中英） | `release-notes/vX.Y.Z.md`（`<!-- locale:zh-CN -->` / `<!-- locale:en-US -->`） |
| 累积 Changelog | `CHANGELOG.md` |
| 用户向站点 | `docs/index.html`（落地）、`docs/docs.html`（文档）、`docs/changelog.html`（独立更新日志） |
| Pages | 仓库 GitHub Pages：`source` 当前为 `dev/0.0.1` + `/docs`（以仓库设置为准） |
| 构建/发布 CI | `.github/workflows/release.yml`（推送 `v*` tag 触发） |

**不要**把 `docs/architecture/*` 或 `peer-knowledge` 工程合同文档当成对外发版站点内容提交进产品仓（架构文档默认 local-only）。

## 前置检查

1. 在干净工作区或明确列出的改动集上工作：`git status -sb`。
2. 确认当前分支策略：常见是在 `dev/0.0.1`（或发布约定分支）完成内容后打 tag；**不要**在未知脏状态上 stamp 版本。
3. 与用户确认目标版本字符串：
   - 预发布：`0.0.1-beta.N` → tag `v0.0.1-beta.N`（CI prerelease / beta 通道）
   - 正式：`x.y.z` → tag `vX.Y.Z`（latest 通道）
4. 确认本轮用户可见变更摘要（Desktop / CLI / docs / 修复 / 破坏性变更）。

## 流程（必须按序）

### 0) 冻结变更范围

- 用 `git log` / `git diff` 汇总自上一 tag 以来的用户可见变更。
- 上一 tag 可参考：`git tag --list 'v*' --sort=-v:refname | head`。
- 分类：新功能 / 优化 / 修复 / 破坏性变更 / 已知问题。
- 明确是否包含 **文档站** 变更（`docs/*`、logo、Pages 文案）。

### 1) 写 `release-notes`（产品向，中英）

创建：

```text
release-notes/v<version>.md
```

结构必须兼容现有解析（站点 `docs/changelog.html` 从该目录生成内容）：

```markdown
<!-- locale:zh-CN -->
## 说明
- …

## 新功能
- …

## 优化
- …

## 修复
- …

## 已知问题
- …

<!-- locale:en-US -->
## Notes
- …

## What's New
- …

## Improvements
- …

## Fixes
- …

## Known Issues
- …
```

要求：

- 中英都写；用户能读懂，避免纯内部模块名堆砌。
- 若本轮有 **文档站 / Changelog / Pages** 更新，在中英各加一条明确说明。
- 不要把未用户可见的纯重构硬写成“新功能”。

### 2) 更新 `CHANGELOG.md`

- 在文件顶部 `## Unreleased` 之下或新增 `## v<version>` 段（与仓库既有风格一致）。
- 与 `release-notes` 保持同版本事实，可更偏工程列表，但仍应可读。
- 若存在 Unreleased 条目，发版时迁入该版本段并清空 Unreleased 占位。

### 3) 更新 GitHub Pages 文档站（`docs/`）

**本 Skill 的增量要求：发版不得跳过文档。**

至少检查并在需要时更新：

| 文件 | 何时必须改 |
|---|---|
| `docs/changelog.html` | 新版本 notes 已写：确认生成逻辑仍读取 `release-notes/`；若是静态嵌入数据，重新生成/同步条目 |
| `docs/docs.html` | 用户可见行为/命令/安装/能力（Skill/Plugin/MCP/权限）有变更 |
| `docs/index.html` | 定位文案、下载入口、入口能力（Desktop/CLI）有变更 |
| `docs/logo*.png` / `favicon*.png` | 品牌资源变更时同步 |

操作要点：

1. 以 `release-notes/` + 代码真实行为为准，**禁止**文档继续描述已删除命令/别名（例如独立 `/history-earlier`）。
2. 本地预览（可选但推荐）：

```bash
python3 -m http.server 8777 --directory docs
# 打开 http://127.0.0.1:8777/ 与 /docs.html /changelog.html
```

3. 提交 `docs/*` 与 notes 到将要打 tag 的分支（Pages 若绑定 `dev/0.0.1` 的 `/docs`，确保该分支包含站点提交）。

### 4) 版本戳（工作区）

```bash
node scripts/stamp-version.mjs <version>
# 例：node scripts/stamp-version.mjs 0.0.1-beta.44
node scripts/check-version.mjs
```

- `stamp-version.mjs` 会写 `VERSION`、各 package.json、相关 Cargo 文件。
- **不**自动 commit；由执行者提交。
- `check-version.mjs` 必须通过后再进入 tag。

### 5) 提交发版准备提交

建议拆分或聚合为清晰 commit（示例）：

```text
release: prepare v<version>

- release-notes + CHANGELOG
- docs site sync (changelog/docs/landing as needed)
- stamp version manifests
```

只提交发版相关文件；不要夹带无关本地实验。

### 6) 打 tag 并推送（触发 CI）

```bash
git tag v<version>
git push origin HEAD
git push origin v<version>
```

CI（`release.yml`）会：

- 从 tag 解析版本/通道
- matrix 构建 Desktop（mac/win）
- 组装 CLI 归档（含 `peer` + `peer-credential-helper`）
- 创建/更新 GitHub Release，上传产物与更新清单

**不要**在本地绕过 workflow 手工伪造“已发布”状态，除非用户明确要求且你说明风险。

### 7) 发布后核验

1. GitHub Actions：对应 tag 的 workflow 成功。
2. GitHub Release：安装包 / CLI 归档 / notes 可见。
3. Pages（若本轮改了 `docs/`）：

```bash
curl -sI https://ly-ccx.github.io/Peer-Agent/ | head
curl -sI https://ly-ccx.github.io/Peer-Agent/docs.html | head
curl -sI https://ly-ccx.github.io/Peer-Agent/changelog.html | head
# 内容冒烟：新版本号是否出现在 changelog 页
curl -sL https://ly-ccx.github.io/Peer-Agent/changelog.html | rg -n "<version>" | head
```

4. 若 Pages 仍显示旧内容：确认已 push 到 Pages source 分支，等待 `built`，必要时硬刷新。

## 文档更新清单（发版 Definition of Done 的一部分）

发版完成前，下列项必须为真：

- [ ] `release-notes/v<version>.md` 存在且含 zh-CN + en-US
- [ ] `CHANGELOG.md` 含该版本条目
- [ ] 用户可见产品变更已反映到 `docs/docs.html`（若有）
- [ ] `docs/changelog.html` 能展示该版本（生成或静态数据已更新）
- [ ] 相关 `docs/*` 已提交并推到 Pages 源分支
- [ ] `stamp-version` + `check-version` 通过
- [ ] `v<version>` tag 已推送且 CI 触发
- [ ] 线上 Pages / Release 冒烟通过

## 权限与安全

- 推送 tag / 发布需要 git remote 写权限与 GitHub 权限。
- 不要在 notes 或 docs 中粘贴密钥、证书、notarization 敏感材料。
- 签名/公证密钥仅存在于 CI secrets；本地不要回写 secrets。

## 常见失败

| 现象 | 处理 |
|---|---|
| `check-version.mjs` 失败 | 先 `stamp-version.mjs` 再检查；勿手改漏文件 |
| Release CI 未触发 | 确认 tag 名 `v*` 且已 `git push origin v…` |
| Pages 无新 changelog | 确认 `release-notes` 已进源分支；必要时重生成 `docs/changelog.html` 数据 |
| CLI 归档缺 helper | 以 workflow 为准；文档/notes 写清 `peer` + `peer-credential-helper` 同目录要求 |
| 文档仍写已删命令 | 发版前以代码 registry 为准扫一遍 `docs/docs.html` |

## Agent 执行协议

1. 先复述将要发布的 **version**、分支、是否含 docs 变更，再动版本文件。
2. 每完成一个大步骤（notes → changelog → docs → stamp → tag → verify）简短汇报 Evidence（路径/命令结果）。
3. 任何一步失败：停止后续 stamp/tag，保留已改文件说明，不要强行推 tag。
4. 用户若只要“写 notes 不发版”：只做 0–3 步，不 stamp、不 tag。

## 最小命令速查

```bash
# 1) 准备说明与文档（编辑器/补丁）
# release-notes/vX.Y.Z.md, CHANGELOG.md, docs/*

# 2) 版本对齐
node scripts/stamp-version.mjs X.Y.Z
node scripts/check-version.mjs

# 3) 提交并推送分支
git add release-notes CHANGELOG.md docs VERSION package.json apps packages crates Cargo.lock
git commit -m "release: prepare vX.Y.Z"
git push origin HEAD

# 4) tag 触发 CI
git tag vX.Y.Z
git push origin vX.Y.Z

# 5) 核验 Pages / Release
gh run list --workflow=release.yml --limit 5
gh release view vX.Y.Z
curl -sL https://ly-ccx.github.io/Peer-Agent/changelog.html | rg -n "X.Y.Z" | head
```
