# ADR 0001：跨平台凭证 Vault 与统一 Helper

- 状态：Accepted
- 创建时间：2026-07-15
- 最后更新：2026-07-15

## 背景

Peer Agent Desktop 当前使用 Electron `safeStorage` 加密 LLM API Key 与 OAuth Token，并把密文写入 `llm-providers.json`。在 macOS 上，`safeStorage` 的主密钥由 Keychain 保护。TUI 为复用 Desktop 凭证，直接读取 `Electron Safe Storage` 钥匙串项并复刻 Electron 的 AES-CBC 解密格式。

该实现存在以下问题：

1. Desktop 与 TUI 是两个独立访问主体，macOS 可能分别请求 Keychain 授权。
2. 当前发布构建允许 ad-hoc 签名，更新后代码身份变化会导致重复授权。
3. TUI 依赖 Electron 的内部密文格式，Windows 与 Linux 无法复用。
4. `safeStorage` 不可用时存在静默明文降级，违反凭证失败关闭原则。
5. API Key、Access Token、Refresh Token 与普通模型元数据混存在同一配置文件中。

## 决策

### 1. 独立 Credential Helper

新增独立原生二进制 `peer-credential-helper`。Desktop 与 TUI 不直接访问平台安全存储，也不自行解密 Vault。

每次请求由调用端启动 Helper，通过继承的 stdin/stdout 交换单条版本化 JSON 请求与响应：

```text
Desktop ─┐
         ├─ spawn + stdin/stdout ─ peer-credential-helper ─ platform key store
TUI ─────┘
```

选择按请求启动而不是常驻 Socket/Named Pipe 的原因：

- 不暴露可被其他本地进程连接的监听端点；
- 不需要额外的进程发现、锁、重连和生命周期治理；
- 凭证不进入 argv、环境变量或日志；
- macOS Keychain 看到的访问者始终是稳定签名的 Helper；
- Windows、macOS、Linux 使用同一个上层协议。

请求协议版本为 `1`，只允许 `ping`、`get`、`set`、`delete`。凭证键必须通过白名单校验，响应不得包含堆栈或底层系统错误文本。

### 2. 版本化加密 Vault

具体凭证保存在用户数据目录的 `credentials.vault.json` 中。Vault 版本为 `1`，每条记录独立使用 AES-256-GCM 加密：

- 32 字节随机主密钥；
- 每条记录使用 12 字节随机 nonce；
- AAD 绑定协议版本与凭证键；
- 认证标签由 AES-GCM 密文携带；
- 所有二进制字段使用 Base64；
- 更新使用同目录临时文件、`fsync` 与原子 rename；
- Unix 目录权限为 `0700`，文件权限为 `0600`。

Vault 只包含密文。普通模型配置只保存 provider、model、base URL、reasoning 等非敏感元数据和 `apiKeyConfigured` / `oauthConfigured` 布尔状态。

### 3. 平台主密钥保护

Vault 主密钥只由 Helper 访问：

- macOS：Keychain Generic Password；
- Windows：Windows Credential Manager，数据由当前用户的 DPAPI 保护；
- Linux：Secret Service（libsecret/KWallet 兼容服务）。

平台安全存储不可用时必须失败关闭。不得自动把主密钥或业务凭证写成明文。测试使用内存 Key Protector 注入，不访问真实系统凭证库。

### 4. 迁移

Desktop 首次读取旧配置时执行一次迁移：

1. 使用现有 Electron `safeStorage` 解密旧 API Key/OAuth Token；
2. 通过 Helper 写入 Vault；
3. 重新读取并进行常量时间等价校验；
4. 原子写回去除秘密字段的元数据文件；
5. 迁移任一步失败则保留旧文件，不删除旧密文，并返回明确错误；
6. 迁移完成后，TUI 只通过 Helper 读取 Vault。

TUI 不负责旧格式迁移，也不再读取 `Electron Safe Storage` 钥匙串项。

### 5. 签名与打包

Desktop 和 TUI 均打包同一个 `peer-credential-helper` 二进制。macOS 正式发布必须使用稳定 Developer ID Application 身份并完成 notarization；ad-hoc 签名只允许开发构建，不能承诺升级后免重复授权。

Windows Helper 随 Desktop/TUI 一同发布，凭证绑定当前 Windows 用户。Linux 若无 Secret Service，应提示安全存储不可用，而不是降级明文。

## 威胁模型

本方案防护：

- 凭证文件被单独复制或备份泄露；
- 配置文件被普通读取；
- 密文被篡改；
- Desktop/TUI 更新导致各自直接访问平台安全存储；
- 秘密通过命令行参数或日志泄露。

本方案不防护：

- 已完全控制当前用户会话或能注入 Peer Agent 进程的恶意程序；
- 已解锁用户会话中的管理员/root 级攻击者；
- 调试器读取进程内存。

## 失败语义

- 平台安全存储不可用：拒绝保存/读取，并返回稳定错误码；
- Vault 认证失败或格式损坏：拒绝返回任何秘密；
- Helper 不存在或协议不兼容：Desktop/TUI 显示可操作错误；
- 旧凭证迁移失败：保留旧密文，不做破坏性清理；
- 禁止任何隐式明文回退。

## 影响

- 新增 Rust Helper 与 TypeScript 客户端包；
- Desktop LLM Store 改为元数据 + Vault；
- TUI 共享模型配置改为通过 Helper 取 secret；
- release 构建增加 Helper 编译与资源打包；
- 需要 Windows 与稳定签名 macOS 的人工升级验证。
