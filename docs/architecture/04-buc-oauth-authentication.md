# BUC OAuth2.1 登录架构

> 状态：第一版真实登录链路  
> 目标：让 Zeus Atlas 桌面端使用 BUC OAuth2.1 + PKCE 完成登录，同时避免把 `client_secret` 或 token 暴露给 renderer。

---

## 一、核心原则

桌面端是公共客户端，不能安全保存 `client_secret`。

所以第一版采用：

```text
OAuth2.1 Authorization Code + PKCE
```

不采用：

```text
client_secret in desktop app
implicit token flow
renderer exchange token
token in localStorage
```

---

## 二、运行链路

```text
Renderer
  → ipc auth:login
    → Electron main
      → generate state / nonce / code_verifier
      → start 127.0.0.1 callback server
      → open system browser BUC auth URL
        → BUC redirects to 127.0.0.1 callback with code
      → Electron main validates state
      → exchange code with code_verifier
      → call user_info
      → encrypt and store token
      → return AuthState without token
```

Renderer 只能拿：

- 登录状态。
- 用户资料。
- token 过期时间。
- BUC 配置的公开部分。

Renderer 永远不能拿：

- `access_token`
- `refresh_token`
- `id_token`
- `client_secret`

---

## 三、配置项

通过环境变量配置：

```text
ZEUS_ATLAS_BUC_ENV=daily | prod
ZEUS_ATLAS_BUC_CLIENT_ID=<BUC 应用名>
ZEUS_ATLAS_BUC_REDIRECT_URI=http://127.0.0.1:16888/oauth/callback
ZEUS_ATLAS_BUC_LOGOUT_BACK_URL=http://127.0.0.1:16888/logout/callback
ZEUS_ATLAS_BUC_SCOPE=profile openid
```

默认值：

```text
ZEUS_ATLAS_BUC_ENV=daily
ZEUS_ATLAS_BUC_REDIRECT_URI=http://127.0.0.1:16888/oauth/callback
ZEUS_ATLAS_BUC_LOGOUT_BACK_URL=http://127.0.0.1:16888/logout/callback
ZEUS_ATLAS_BUC_SCOPE=profile openid
```

如果 `ZEUS_ATLAS_BUC_CLIENT_ID` 不存在，UI 必须显示“登录未配置”，不能伪造登录状态。

---

## 四、端口与白名单

BUC 应用白名单需要允许：

```text
http://127.0.0.1:16888/oauth/callback
http://127.0.0.1:16888/logout/callback
```

客户端只监听：

```text
127.0.0.1
```

禁止监听：

```text
0.0.0.0
```

固定端口比动态端口更适合 BUC 白名单。后续如果要支持备用端口，需要把每个备用 `redirect_uri` 都加入白名单。

---

## 五、token 存储

第一版使用 Electron `safeStorage` 加密 token 后写入 app userData。

如果系统加密不可用：

```text
token 只保存在内存里，不写明文文件。
```

后续可以替换为更强的 OS Vault 抽象：

- macOS Keychain
- Windows Credential Vault
- Linux Secret Service

这个替换不影响 renderer API，因为 token 从一开始就没有暴露给 renderer。

---

## 六、协议对象

登录状态进入 `ClientBootstrap`：

```text
ClientBootstrap.auth
AuthState
AuthProviderConfig
AuthenticatedUser
```

`AuthState` 是 renderer 的唯一登录事实输入。

---

## 七、与 Cloud Runtime 的关系

BUC 登录不等于 Cloud Runtime 已连接。

状态要分开：

```text
AuthState = 用户身份
CloudRuntimeState = 云端 Agent Runtime / Gateway 可用性
ClientSessionState = 本地能力会话
```

用户已经登录，但 Cloud Gateway 未配置时，UI 应显示：

```text
已登录
Cloud Runtime 未配置
本地就绪
```

不能把登录成功伪装成端云执行链路已经完成。
