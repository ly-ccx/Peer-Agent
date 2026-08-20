---
name: release-process
description: Peer Agent 发版流程（版本戳、release notes、CHANGELOG、根 README 漂移检查、CLI 平台矩阵核对、GitHub Pages 文档站、打 tag 触发 CI）。
whenToUse: 用户要求发版、打 beta/正式 tag、写 release notes、更新 CHANGELOG、检查/更新根 README、同步 docs 站点/Pages，或询问如何发布 Desktop/CLI。
version: 0.1.4
---

# Peer Agent 发布流程 Skill

在本仓库执行一次 **beta / 正式发版**。  
本 Skill 在既有 tag 驱动 CI 流程之上，**强制纳入文档站与 Changelog 更新**，避免“只发安装包、文档还是旧的”。

## 范围与事实源

| 项 | 路径 / 事实 |
|---|---|
| 版本权威（发布时） | git tag `v*`（如 `v0.0.4-beta.5` / `v0.1.0`） |
| 仓库基线版本文件 | `VERSION` + 各 `package.json` / Cargo 清单（由 `scripts/stamp-version.mjs` 回写） |
| 产品说明（中英） | `release-notes/vX.Y.Z.md`（更新日志唯一内容来源；`<!-- locale:zh-CN -->` / `<!-- locale:en-US -->`） |
| 累积 Changelog | `CHANGELOG.md` |
| 产品入口说明 | 根 `README.md`（定位 / 安装 / 入口面 / 能力 / 仓库结构 / 文档入口；**不是**变更日志） |
| 用户向站点 | `docs/index.html`（落地）、`docs/docs.html`（文档）、`docs/changelog.html`（轻量页面外壳）、`docs/changelog-data/manifest.json` + `v<version>.json`（构建产物；按正式版/Beta 分组并按需加载） |
| Pages | `.github/workflows/pages.yml` 构建 `docs` artifact 并通过 GitHub Actions 部署 |
| 构建/发布 CI | `.github/workflows/release.yml`（推送 `v*` tag 触发） |

**不要**把 `docs/architecture/*` 或 `peer-knowledge` 工程合同文档当成对外发版站点内容提交进产品仓（架构文档默认 local-only）。

## 前置检查

1. 在干净工作区或明确列出的改动集上工作：`git status -sb`。
2. 确认当前分支策略：预发布可以在 `dev/<version>` 或发布约定分支打 tag；**正式版必须先合并 `main`，再创建正式 tag**，不得直接从开发/发布分支发布 latest。
3. 与用户确认目标版本字符串：
   - 预发布：`0.0.4-beta.N` → tag `v0.0.4-beta.N`（CI prerelease / beta 通道）
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
| `docs/changelog.html` | **生成门禁**：新版本 notes 已写则运行 `pnpm build:changelog`；禁止手工维护 `ENTRIES` |
| `docs/docs.html` | 用户可见行为/命令/安装/能力（Skill/Plugin/MCP/权限）有变更 |
| `docs/index.html` | 定位文案、下载入口、入口能力（Desktop/CLI）有变更 |
| `docs/docs.html` / `docs/index.html` 中的版本与发布态文案 | 残留旧版本示例（如 `v0.0.1-beta.*`）或未发布态文案（如 `install (when published)`）时**必须**改 |
| `docs/logo*.png` / `favicon*.png` | 品牌资源变更时同步 |

#### `docs/changelog.html` 生成门禁（禁止 stamp / tag 前跳过）

`release-notes/*.md` 是更新日志唯一内容来源。不要手工编辑 `docs/changelog-data/`；生成器会输出轻量 manifest，并为每个版本生成独立 JSON。`docs/changelog.html` 只保留页面与按需加载逻辑，Pages Actions 会在部署前从 notes 重新生成数据。

发版前必须同时满足：

1. `CHANGELOG.md` 含本版标题（如 `## 0.0.4-beta.N`）
2. `pnpm build:changelog` 成功，随后 `pnpm check:changelog` 通过
3. 目标版本的 notes 含非空的 zh-CN 与 en-US 段落
4. `docs/changelog-data/manifest.json` 的 `generatedAt` 为真实时间戳（生成器从 `release-notes/` 最近提交派生；`check:changelog` 会拒绝 epoch 占位 `1970-01-01`）

本地核验（失败则**禁止**进入 stamp / tag）：

```bash
# 把 VERSION 换成目标版本号，如 0.0.4-beta.5
VERSION=0.0.4-beta.5
rg -n "## ${VERSION}" CHANGELOG.md
pnpm build:changelog
pnpm check:changelog
test -f "docs/changelog-data/v${VERSION}.json"
rg -n "\"version\":\"v${VERSION}\"" docs/changelog-data/manifest.json | head
# generatedAt 非 epoch 占位（check:changelog 已含该断言，此处仅显式复核）
node -e "const m=require('./docs/changelog-data/manifest.json'); if (m.generatedAt==='1970-01-01T00:00:00.000Z' || Number.isNaN(Date.parse(m.generatedAt))) { console.error('generatedAt invalid:', m.generatedAt); process.exit(1); } console.log('generatedAt ok:', m.generatedAt)"
```

操作要点：

1. 以 `release-notes/` + 代码真实行为为准，**禁止**文档继续描述已删除命令/别名（例如独立 `/history-earlier`）。
2. **禁止**只写 notes 就 stamp/tag；CHANGELOG + `docs/changelog.html` 未过硬门禁则停。
3. 本地预览（可选但推荐）：

```bash
python3 -m http.server 8777 --directory docs
# 打开 http://127.0.0.1:8777/ 与 /docs.html /changelog.html
```

4. 提交 `docs/*`、`CHANGELOG.md` 与 notes 到将要打 tag 的分支（Pages 从该分支的 `/docs` 构建，确保该分支包含站点提交）。

### 3.5) 根 `README.md` 漂移检查（每次必做，条件更新）

**检查必做；完整重写不默认。** 根 README 是产品入口页，不是 `CHANGELOG` / `release-notes` 的替代品。

#### 每次发版至少扫这些字段

1. **版本表述** — 是否仍写过时 early-development / 旧版本号；**且不得引用尚未发布的版本**：无对应 git tag 与 release note 的版本（如刚 stamp 的 `0.0.5-beta.1` 开发线）只能写作「开发中」，不得写成「当前 beta 通道」。可写当前系列（如 `0.0.4`）或指向 `VERSION` / Release。
2. **安装路径与平台矩阵** — `@peer-agent/cli`、`peer`、Desktop 开发/打包命令是否与本轮一致；README 中的 CLI 平台表述必须与 `packages/npm-cli/lib/platform.mjs` 的 `supported` 矩阵一致（当前 `darwin-arm64` 与 `linux-x64` 一等支持，其余平台 `supported: false` 并在 postinstall 明确失败）。
3. **入口面** — Desktop / TUI / CLI 是否仍与产品一致。
4. **核心能力** — Agent / Plan / Goal / Quick Chat / Browser·Workbench / MCP / Skills 等用户可见能力是否过时或遗漏。
5. **链接存活** — 相对链接与文档入口是否可达；禁止再把已迁出的架构文档写成代码仓内死链。
6. **站点版本与发布态文案** — `docs/docs.html` / `docs/index.html` 中不得残留旧版本示例（如 `v0.0.1-beta.*`）或未发布态文案（如 `install (when published)`、demo 里的旧版本号）。
7. **新用户可见能力闭环** — 本轮 CHANGELOG / release-notes 里新增的用户可见能力（如自动更新、内嵌浏览器、Roundtable），必须显式决策：写进根 README 与落地页，**或**记录为有意暂不写（在发版汇报中说明理由）；不允许无声漏掉。

#### 仅在命中触发条件时更新 README

| 触发条件 | 动作 |
|---|---|
| 纯 bugfix / 内部重构 / 文案微调 | 通常 **no-op**（记录已检查） |
| 安装方式、入口面（Desktop / TUI / CLI）变化 | **更新** |
| 主能力上线/下线或对外叙事变化（模式、Goal、Quick Chat、Browser 等） | **更新** |
| Roadmap 大项完成态变化 | **建议更新** |
| 文档结构迁移导致 README 死链 | **更新** |
| 正式版（非 beta）或重大定位调整 | **更新** |

结果只允许两种，并在发版汇报中写明：

- `README: no-op` — 已检查，无需改
- `README: updated` — 本轮已改并随发版准备提交

**非目标：**

- 不要把每条 bugfix 写进 README
- 不要把 README 当 CHANGELOG 用
- 不要在发版流程里维护 `peer-knowledge` 架构长文

### 3.6) 开启开发线（与「发布」严格区分）

当目标是**开启 `x.y.z` 开发线**（如 stamp `0.0.5-beta.1`）而非发布时，只允许最小动作集：

- `node scripts/stamp-version.mjs x.y.z-beta.1` 回写 `VERSION` / manifests；
- `CHANGELOG.md` 顶部写入 `## x.y.z-beta.1 - <date>` 段，并明确注明「开启开发线」（如 `Open the 0.0.5 development line from the published 0.0.4 / origin/main`）。

**禁止**（否则会造成「CHANGELOG 有、站点无、README 当已发布」的分裂状态）：

- 写 `release-notes/vx.y.z-beta.1.md`（还没有可发布的用户可见变更）；
- 运行 `build:changelog` / 提交 `docs/changelog-data` 变更；
- 把该版本写进根 README / 站点任何「当前 beta 通道 / latest」表述。

README 若必须提及该版本，只能写「`0.0.5` 开发中（尚未发布）」；「当前 beta 通道」只允许引用**已有 tag 且已有 release note** 的版本（当下即 `v0.0.4-beta.4`）。

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
- README drift check (no-op or update)
- stamp version manifests
```

只提交发版相关文件；不要夹带无关本地实验。若本轮更新了根 `README.md`，一并纳入该准备提交。

### 6) 合并主线并打 tag（触发 CI）

预发布 tag 可以继续留在发布分支。正式版本必须先把已验证的发布准备提交通过 PR 合并到 `main`，再从最新 `origin/main` 创建 tag：

```bash
git push origin HEAD
# 正式版：创建/合并以当前分支为 head、main 为 base 的 PR
git fetch origin main --tags
git switch main
git pull --ff-only origin main
RELEASE_TAG=v<version> RELEASE_COMMIT=HEAD pnpm release:source-check
git tag -a v<version> -m "<version>"
git push origin v<version>
```

`release:source-check` 会校验 tag 版本与 `VERSION` 一致；对稳定版还会校验发布提交已被 `origin/main` 包含。门禁失败时禁止打 tag。预发布仅校验版本，可从发布分支触发 beta 通道。

CI（`release.yml`）会：

- 在任何构建/发布前运行 `version:check` 与 `release:source-check`
- 从 tag 解析版本/通道
- matrix 构建 Desktop（mac/win）
- 组装 CLI 归档（含 `peer` + `peer-credential-helper`；当前矩阵 `darwin-arm64` + `linux-x64`，脚本 `scripts/package-cli-archive.mjs`）
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
# 数据冒烟：线上 manifest 的 latest 通道与本版一致，且 generatedAt 非 epoch 占位
curl -sL https://ly-ccx.github.io/Peer-Agent/changelog-data/manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log('latest:',JSON.stringify(m.latest),'generatedAt:',m.generatedAt);if(m.generatedAt==='1970-01-01T00:00:00.000Z'||Number.isNaN(Date.parse(m.generatedAt)))process.exit(1);})"
```

4. 若 Pages 仍显示旧内容：确认已 push 到 Pages source 分支，等待 `built`，必要时硬刷新。

## 文档更新清单（发版 Definition of Done 的一部分）

发版完成前，下列项必须为真：

- [ ] `release-notes/v<version>.md` 存在且含 zh-CN + en-US
- [ ] `CHANGELOG.md` 含该版本条目
- [ ] **生成门禁**：`pnpm build:changelog && pnpm check:changelog` 通过
- [ ] 已用本地核验命令确认 CHANGELOG + 生成后的 changelog 包含本版；失败则未 stamp/tag
- [ ] 用户可见产品变更已反映到 `docs/docs.html`（若有）
- [ ] 相关 release notes、生成器、`docs/*` 与 `CHANGELOG.md` 已提交；Pages workflow 可从该 ref 构建
- [ ] 已完成根 `README.md` 漂移检查（版本口径 / 安装与 CLI 平台矩阵 / 入口 / 能力 / 链接 / 站点版本文案 / 新能力闭环）
- [ ] 若命中 README 触发条件：已更新并随发版提交；否则汇报中记录 `README: no-op`
- [ ] 若有「开启开发线」动作：只做了 3.6 允许的最小动作，未伪造发布态（无 notes / 无站点数据 / README 不写「当前通道」）
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
| Pages 无新 changelog / 「最新」仍是上版 | 先运行生成与检查命令，再检查 `Deploy GitHub Pages` workflow；不要手工修改 `ENTRIES` 或切换版本分支 |
| `manifest.json` 的 `generatedAt` 是 `1970-01-01` | 生成器旧版或数据未重建：升级到修复后的 `build-changelog.mjs` 并重跑 `pnpm build:changelog && pnpm check:changelog`；新版从 `release-notes/` 最近提交派生真实时间戳 |
| README 写的 beta 通道与站点 manifest `latest.beta` 不一致 | 核对该版本是否有 git tag + release note；只有已发布版本可写「当前通道」，未发布开发线只能写「开发中」（见 3.6） |
| CLI 归档缺 helper | 以 workflow 为准；文档/notes 写清 `peer` + `peer-credential-helper` 同目录要求 |
| 文档仍写已删命令 | 发版前以代码 registry 为准扫一遍 `docs/docs.html` |
| 根 README 仍写旧入口/死链 | 执行 3.5 漂移检查；命中触发条件则更新，勿用 notes 顶替 |

## Agent 执行协议

1. 先复述将要发布的 **version**、分支、是否含 docs / README 变更，再动版本文件。若只是开启开发线，声明走 3.6 最小动作集而非发布流程。
2. 每完成一个大步骤（notes → CHANGELOG → changelog 生成门禁 → 其他 docs → README 漂移检查 → stamp → tag → verify）简短汇报 Evidence（路径/命令结果）。
3. 进入 stamp/tag 前必须贴出 `pnpm check:changelog` 的通过输出；缺失则停。
4. README 步骤必须给出 `README: no-op` 或 `README: updated`，禁止静默跳过检查。
5. 任何一步失败：停止后续 stamp/tag，保留已改文件说明，不要强行推 tag。
6. 用户若只要“写 notes 不发版”：只做 0–3.5 步，不 stamp、不 tag。

## 最小命令速查

```bash
# 1) 准备说明与文档（编辑器/补丁）
# release-notes/vX.Y.Z.md, CHANGELOG.md, docs/*
# 根 README.md：漂移检查；仅触发时更新

# 2) 版本对齐
node scripts/stamp-version.mjs X.Y.Z
node scripts/check-version.mjs

# 3) 提交并推送分支
git add release-notes CHANGELOG.md docs README.md VERSION package.json apps packages crates Cargo.lock
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
