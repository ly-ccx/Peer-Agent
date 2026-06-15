# 28. OpenAI Subscription OAuth (ChatGPT Login)

## Status
Accepted

## Context

LLM provider 接入此前只有一种鉴权方式:用户手填 API Key,经 `safeStorage`
加密存储,请求时以 `Authorization: Bearer <key>`(OpenAI)或 `x-api-key`
(Anthropic)发出。

部分用户希望用 **ChatGPT 订阅账号**(Plus/Pro/Team)而非按量计费的 API Key
驱动 OpenAI 模型。该方式不是一个 Key,而是一条 OAuth 授权链:

- 浏览器跳转 `https://auth.openai.com/oauth/authorize`(PKCE)。
- 本地 `http://localhost:1455/auth/callback` 接收 `code`。
- `code` 换 `access_token` / `refresh_token`,后续用 `refresh_token` 刷新。
- 订阅账号的模型走 **OpenAI Responses API**,且需附带
  `chatgpt-account-id` 头,与 `/chat/completions` 路径不同。

现有代码把"协议族"与"鉴权方式"耦合在 `LlmProviderConfig.provider`
单字段上(`'openai' | 'anthropic'`),无法表达"OpenAI 协议族 + OAuth 鉴权 +
Responses 传输"这一组合。

## Decision

### 1. 解耦协议与鉴权

新增正交维度 `LlmAuthMethod = 'api_key' | 'oauth_chatgpt'`。

- `provider` 继续表示线协议族(决定消息编码 / 默认传输)。
- `authMethod` 决定凭据类型与鉴权头。
- 「OpenAI 订阅」= `provider: 'openai'` + `authMethod: 'oauth_chatgpt'`,
  传输切到 Responses adapter。

### 2. 凭据模型升级为 union

存储项的 `apiKey`(加密)扩展为 `credential` union:

```
{ kind: 'api_key', apiKey: <encrypted> }
{ kind: 'oauth_chatgpt', access, refresh, expires, accountId }   // 整体加密
```

- OAuth token 仅存在 main 进程的加密文件中。
- `LlmProviderConfigView` 不回传任何 token;订阅场景以 `oauthStatus`
  (`connected | expired | disconnected` + 账号标识)向 renderer 表达登录态。
- 满足治理底线:renderer 不持有 secret、权限/凭据真相不落在 renderer。

### 3. OAuth 作为 main 进程能力,经 IPC 暴露

- 新增 `electron/main/llm-oauth/openai-oauth.mjs`:PKCE 生成、起本地
  callback server、`code` 换 token、`refresh`。优先 **browser 模式**。
- 新增 IPC:`llm:oauth:start` / `llm:oauth:cancel`,登录成功后把加密凭据写入
  config-store 并返回脱敏 View。
- token 刷新在 `llm-chat-service` 发起请求前透明完成(临近过期即刷新并回写)。

### 4. Responses 传输走既有 encoder/adapter seam(ADR 23)

- 新增 `provider-adapters/openai-responses-adapter.mjs` 与
  `provider-encoders` 中的 Responses 编码;**不在 chat-adapter 内加鉴权分支**。
- `llm-chat-service` 按 `(provider, authMethod)` 选择 adapter,保持分发为薄层。
- UI 的 `xhigh` 必须按 OpenAI GPT-5.5 wire 契约透传。
  OpenAI Chat Completions 的 `reasoning_effort` 与 Responses 的 `reasoning.effort`
  支持 `low` / `medium` / `high` / `xhigh`; Peer Agent 的 `off` 不发送
  reasoning 字段。provider encoder 不得静默降级 `xhigh`，否则 UI 语义与
  provider 请求不一致。

### 5. 订阅登录链路:先登录、成功才落盘;失败/取消不留痕

订阅(`oauth_chatgpt`)的 provider 创建时机由登录结果决定,**不是点击即落盘**:

- UI(`LlmSettingsPanel`)在订阅模式下**不**调用 `llmAddProvider`。表单内容
  作为 `draft` 交给 `llmOAuthStart({ draft })`;只有 API Key 模式才在保存时
  直接 `llmAddProvider`。
- main 进程 `llm:oauth:start` 顺序固定:`startBrowserLogin()` →
  `await session.promise` 拿到 token → **之后**才
  `addProvider({ ...draft, authMethod: 'oauth_chatgpt' })` → `setOAuthTokens`。
- 失败回滚:若 `draft` 已创建 provider 但后续步骤失败,`catch` 中
  `removeProvider(createdId)`,保证登录失败/取消**不留下没有 token 的死配置**。
- `llmOAuthStart` 契约为 `{ id } | { draft }` 二选一:`{ id }` 对已存在订阅
  重新登录(只刷 token,不新建);`{ draft }` 新建(成功才落盘)。
- 同一时刻只允许一个进行中的 browser 登录会话(`activeOAuthLogin`),
  新登录会取消旧会话,`finally` 中清理。
- 按钮文案随场景区分:新建订阅为「登录 ChatGPT / Login with ChatGPT」,
  已存在订阅项为「重新登录 / Re-login」,不再使用"保存并登录"。

### 6. 订阅可用模型集 = gpt-5 家族

订阅 access token 只对 codex 端点
(`chatgpt.com/backend-api/codex/responses`)有效,对按量计费 API 面
(`api.openai.com/v1/models`)无权限。因此:

- 订阅链路真正可用的模型为 **gpt-5 家族**(`gpt-5-codex`、`gpt-5`),默认
  置顶 `gpt-5-codex`。
- `openai-model-catalog.mjs` 的 `FALLBACK_MODELS` 收敛为该集合;新增
  `isSubscriptionUsableModel`(`/^gpt-5/i`)白名单,远程清单也叠加此过滤,
  防止 `gpt-4o / o3 / o4-mini` 等 API-only 模型混进订阅下拉。
- 若日后实测订阅 codex 端点支持更多 model id,放宽
  `isSubscriptionUsableModel` 白名单即可,不改其它链路。

### 7. 连通性判定以 OAuth 登录态为准,纯逻辑下沉为可测 Module

订阅(`oauth_chatgpt`)provider **不持有 apiKey**(落盘时 `apiKey: encrypt('')`)。
此前 `testConnection` 对所有 provider 一律 `decrypt(item.apiKey)` 后判空,
导致订阅项必然命中 `API key not configured`——即便已成功登录,设置面板仍报
红色 `× API key not configured`。这是一个**判据错置**:订阅的"凭据是否就绪"
本应以 OAuth 登录态(`connected`)为准,而非 apiKey 是否存在。

决策:

- 订阅的连通性语义 = **OAuth 凭证是否有效/未过期**,这是 config-store 能独立
  回答的事实(已有 `oauthStatusOf`)。真正的远程探测留给 `llm:models:list`
  (main 层,含 token 刷新),`testConnection` 不再为订阅打网络。
- `testConnection` 订阅分支提前返回,以登录态映射结果:
  `connected → success`;`expired → oauth_session_expired`;
  其余 → `oauth_not_logged_in`。**不再落到 `API key not configured`**。
- `LlmProviderConfigView.apiKeyConfigured` 的投影与上面同口径:
  `authMethod === 'oauth_chatgpt' ? oauthStatus === 'connected' : Boolean(key)`。
  ChatSurface 用 `apiKeyConfigured` 选择可用 provider,因此订阅登录后即可被选中。

判定逻辑下沉为纯函数 Module `provider-connectivity.mjs`(无 electron / 无网络):

- `deriveOAuthStatus(tokens, now)`:由已解密 token 推导
  `connected | expired | disconnected`(不泄漏 token 本身)。
- `resolveSubscriptionTestResult(oauthStatus, model)`:由登录态映射连通性结果。
- `llm-config-store` 仅做注入调用(`oauthStatusOf` / `testConnection` 复用),
  **不在存储层反向依赖 provider 网络适配器**,符合分层方向。
- 该 Module 可在标准 `pnpm test`(裸 `node --test`)下脱离 electron 运行时被测,
  规避 `import { safeStorage } from 'electron'` 在纯 Node 解析期抛
  `SyntaxError` 的约束;`provider-connectivity.test.mjs` 锁住
  "订阅 connected 不得退化为 API key 错误"等契约。

### 8. 订阅模型目录"远程优先、回退兜底"是预期行为,非故障

订阅 access token 对 `api.openai.com/v1/models` 通常无权限(401/403),而 codex
对话端点本身**没有列模型接口**。因此 `listSubscriptionModels` 远程失败时回退
`FALLBACK_MODELS`(gpt-5 家族)是**设计内兜底**:它保证登录后下拉非空,而非
"拿不到真正模型列表"的 bug。`source: 'remote' | 'fallback'` 字段如实标注来源,
UI 可据此提示用户当前为兜底清单。

## Layering

```
LlmSettingsPanel (协议类型 + 鉴权方式 + 登录按钮)
  -> IPC llm:oauth:start / llm:add(authMethod)
    -> openai-oauth (PKCE + 本地回调 + token 交换/刷新)
    -> llm-config-store (credential union 加密存储, oauthStatus 投影)
      -> provider-connectivity (纯函数: 登录态推导 + 连通性判定, 无 electron)
      -> llm-chat-service (按 authMethod 选 adapter, 请求前刷新 token)
        -> openai-responses-adapter (传输 + 流解析 + chatgpt-account-id)
          -> provider-encoder (Responses wire body)
```

## Consequences

- 新增鉴权方式时扩展 `LlmAuthMethod` 与 credential union,不改协议族枚举。
- token 永不出 main 进程;Evidence / 诊断对 token 脱敏(复用 `maskApiKey` 思路)。
- 旧的纯 `apiKey` 存储项需兼容读取:无 `credential` 字段时回退为
  `{ kind: 'api_key', apiKey }`。
- 订阅 provider 的落盘真值在 main config-store,且仅在登录成功后写入;
  renderer 不得改回"点击即 `llmAddProvider`"——那会重新引入"登录失败仍留
  死配置"的 bug。
- 订阅下拉只应出现 gpt-5 家族;若发现其它 model id,先确认其确实能走 codex
  端点,再扩白名单,不要直接把 `/v1/models` 全量塞入。
- 订阅连通性以 OAuth 登录态为准:`testConnection` / `apiKeyConfigured` 不得对
  订阅项走 `decrypt(apiKey)` 判空,否则会重新引入"已登录仍报 API key not
  configured"的红框回归。两处必须复用 `provider-connectivity` 的同一口径。
- `listSubscriptionModels` 回退 `FALLBACK_MODELS` 是设计内兜底,不是错误;
  排查"拿不到模型列表"时先看 `source` 字段与远程 401/403,不要把兜底当 bug 修。

## References

- ADR 23 Provider Encoder Seam
- opencode `packages/core/src/plugin/provider/openai-auth.ts`(PKCE / 流程参考)
