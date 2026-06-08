# 版本管理

> 状态：0.0.1 开发期版本规则  
> 目标：让 Zeus Atlas 从第一版开始具备清晰版本事实源、发布边界和变更记录，避免脚手架阶段的版本漂移。

---

## 一、当前版本

当前正在开发：

```text
0.0.1
```

含义：

- `0.0.1` 是 Zeus Atlas 的第一个工程开发版本。
- 当前不是稳定发布版，也不是对外产品版本。
- 版本号用于约束代码、文档、协议和验证记录，而不是表达功能成熟度。

---

## 二、版本事实源

版本事实源是根目录：

```text
VERSION
```

以下文件必须与 `VERSION` 保持一致：

```text
package.json
apps/desktop/package.json
packages/*/package.json
crates/*/Cargo.toml
Cargo.lock
```

检查命令：

```bash
npx --yes pnpm@10.22.0 version:check
```

原则：

- 不允许某个 package 私自漂移版本。
- 不允许 Rust crate 与 JS workspace 版本不一致。
- 不允许只改代码不更新 `CHANGELOG.md`。
- 发布 tag 使用 `v<version>`，例如 `v0.0.1`。

---

## 三、版本阶段

### 3.1 `0.0.x`

内部工程奠基版本。

允许：

- 协议快速调整。
- UI 骨架快速调整。
- 本地运行态边界调整。
- Cloud Gateway 接入方式调整。

要求：

- 每个版本必须有明确工程目标。
- 每个版本必须有验证命令。
- 契约变化必须更新架构文档或协议类型。

### 3.2 `0.1.x`

内部可用 alpha 版本。

进入条件：

- BUC 登录稳定。
- 真实 Cloud Chat Gateway 可用。
- 真实 conversation / message stream / cancel / history 可用。
- Timeline 能展示 assistant stream、thinking、tool call、confirmation。
- 不再依赖 mock conversation。

### 3.3 `1.0.0`

稳定可推广版本。

进入条件：

- 端云边界稳定。
- 关键本地能力通过 Manifest / Runtime Projection / Permission / Evidence 主链路。
- 权限、审计、诊断具备可运维闭环。
- Web Chat 常用能力完成桌面等价。

---

## 四、0.0.1 范围

`0.0.1` 的目标是建立真实工程底座：

```text
Electron desktop scaffold
  + BUC OAuth2.1 PKCE
  + Client bootstrap
  + CloudRuntimeState
  + ClientSessionState
  + CapabilityManifest
  + ProjectIndex
  + i18n scaffold
  + Chat parity protocol
  + chat-kernel reducer
```

`0.0.1` 不承诺：

- 完整 Web Chat UI 等价。
- 完整 Cloud Chat Gateway。
- 完整 SDK。
- Plugin market。
- MCP lifecycle。
- 任意本地工具执行。
- 多 Channel 完整产品闭环。

---

## 五、变更记录

所有版本变化记录在：

```text
CHANGELOG.md
```

规则：

- 当前开发版本使用 `Unreleased`。
- 每个版本必须写清楚 scope。
- 每个版本必须写 release gate。
- 重大架构边界变化必须同步 `docs/architecture/`。

---

## 六、发布检查

`0.0.1` 发布前至少执行：

```bash
npx --yes pnpm@10.22.0 version:check
npx --yes pnpm@10.22.0 --filter @zeus-atlas/chat-kernel test
npx --yes pnpm@10.22.0 typecheck
npx --yes pnpm@10.22.0 build
cargo build --workspace
```

如果后续新增 Rust 测试、Electron e2e 或 Browser verification，需要把对应命令加入当前版本的 release gate。

---

## 七、发布通道与产物分发

### 7.1 通道策略

| 通道 | 版本格式 | 示例 | 受众 | OSS 目录 |
|------|----------|------|------|----------|
| Beta | `x.y.z-beta.N` | `0.1.0-beta.1` | 内部测试 5–10 人 | `releases/beta/` |
| Stable | `x.y.z` | `0.1.0` | 全量发布 | `releases/latest/` |

### 7.2 发布流程

```
dev/x.y.z → 日常开发
  ↓ feature freeze
release/x.y.z → 发布分支
  ↓ VERSION 改为 x.y.z-beta.1
  ↓ pnpm release:beta
OSS /releases/beta/ → Beta 测试
  ↓ 验收通过、VERSION 改为 x.y.z
  ↓ pnpm release:stable + git tag vx.y.z
OSS /releases/latest/ → Stable OTA 推送
```

### 7.3 产物存储

- **OSS Bucket**: `zeus-atlas`
- **Region**: `oss-cn-beijing`
- **公网 URL**: `https://zeus-atlas.oss-cn-beijing.aliyuncs.com`
- **凭证来源**: 字典 ID 262

目录结构：

```
releases/
├── beta/
│   ├── latest-mac.yml      ← electron-updater macOS manifest
│   ├── latest.yml          ← electron-updater Windows manifest
│   ├── Zeus-Atlas-*.dmg
│   ├── Zeus-Atlas-*.zip
│   └── Zeus-Atlas-Setup-*.exe
└── latest/
    ├── latest-mac.yml
    ├── latest.yml
    ├── Zeus-Atlas-*.dmg
    ├── Zeus-Atlas-*.zip
    └── Zeus-Atlas-Setup-*.exe
```

### 7.4 OTA 自动更新

客户端内置 `electron-updater`，启动后 30s 检查更新，之后每 4 小时检查一次。

- Beta 用户只收到 beta 通道更新
- Stable 用户只收到 latest 通道更新
- 不自动下载，用户确认后才开始下载
- 下载完成后用户可选择“重启安装”或等下次退出时自动安装

### 7.5 CI/CD 流水线

参见仓库根目录 `.gitlab-ci.yml`。流水线分四个阶段：

1. **check**: 版本一致性、TypeScript 类型检查、单元测试
2. **build**: Renderer 构建 + Rust release 编译（多平台并行）
3. **package**: electron-builder 打包（macOS DMG/ZIP + Windows NSIS）
4. **publish**: 手动触发上传到 OSS（beta 或 stable）

### 7.6 代码签名

- **macOS**: Developer ID Application 证书 + Apple Notarization
- **Windows**: 待配置 EV 证书
- CI 环境变量：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
