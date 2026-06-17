# 0003 — request_user_input：用运行时护栏实现「提问即停，等待用户」

状态：已实现（B 级变更：触及 chat runtime tool 执行、Runtime Projection、prompt 上下文）。

## 背景 / 问题

agent loop 的回合终止条件只看「本轮模型是否发起了工具调用」：

- `anthropic-agent-loop.mjs`：`stopReason === 'tool_use'` 时执行工具 → 把 `tool_result`
  回灌进历史 → 进入下一轮；只有「纯文本、无工具调用」时才 `loop.sendDone()` 结束回合。
- `openai-agent-loop.mjs`：`toolCalls.length` 同理。
- `agent-loop-kernel.mjs`：默认 `DEFAULT_AGENT_LOOP_MAX_TURNS = AGENT_LOOP_UNBOUNDED`，无兜底刹车。

Anthropic / OpenAI 都允许在一次响应里**同时**输出文本和工具调用。于是当模型一边写
「你回个 1/2/3 即可」一边附带工具调用时，loop 只看到「有 tool_use」，就继续执行、回灌、
让模型在下一轮基于工具结果**自行做选择**，而不是停下来等用户。

此前「等用户批准」只存在于 `mode-copy.mjs` 的自然语言文案（goal 模式），运行时不认这句话。
这违反 AGENTS.md 的硬规则：

> Do not rely on prompt instructions as the only enforcement for permissions or capability limits.

## 方案：一个无副作用的「请求用户输入」能力 + 运行时终止信号

沿用非协商运行时链，不在 loop 里硬编码工具名旁路：

```
Capability Provider(local.interaction.request_user_input)
  → Manifest(tools/interaction-tool-definitions.mjs)
    → Runtime Projection（native / L0_inert / D0_public）
      → Tool Call(request_user_input)
        → PermissionGrant（无副作用，provider self-grant，不弹框）
          → Evidence（outputPreview.control = { terminal: true }）
```

- 新 Provider：`runtime-gateway/local-interaction-provider.mjs`。它不读写文件、不执行命令，
  只把 agent 要问用户的问题登记为 Evidence，并在结果里附带终止控制信号。
- 新 Manifest：`tools/interaction-tool-definitions.mjs`，`permissionPolicy.kind = 'interaction'`，
  在 `runtime-projection-tool-materializer.mjs` 中归类为 `L0_inert` / `D0_public`。
- 注册：`tools/index.mjs` 的 `createRuntimeToolRegistry` 与 `local-tool-host.mjs` 的 provider 列表。
- 信号提取：`tool-orchestrator.mjs` 新增 `extractToolControlSignal()`，`executeModelToolCall`
  在返回值里带上 `controlSignal`。
- 终止动作（治本点）：两个 agent loop 在**把本回合所有 `tool_use` 配对的 `tool_result`/`tool`
  消息写回历史之后**，若检测到 `terminalControlSignal` 就 `loop.sendDone(); return;`，
  停止回灌、交还控制权给用户。
  - 关键正确性：必须先配对再终止，否则会留下悬空 `tool_use` / 未应答 `tool_call`，
    导致下一轮 provider 请求被拒。
- Prompt 契约：`mode-copy.mjs` 的 `chat` 与 `goal` 模式都加入「需要用户决定/选择/批准时，
  调用 request_user_input；该调用结束本回合并等待用户」。这是**引导**，强制由运行时完成。

## 为什么不是纯提示词

提示词无法强制；模型仍可能在同一响应里夹带工具调用。本方案把「等用户」从模型自觉
升级为运行时可识别、可测试的终止信号。

## 测试

- `runtime-gateway/local-interaction-provider.test.mjs`：provider 契约（成功带终止信号、
  缺 question 不终止、字符串入参归一、self-grant、D0_public）。
- `chat-runtime/request-user-input-signal.test.mjs`：经真实运行时链
  （`createRuntimeToolProjection` → `executeProjectedModelTool` → `extractToolControlSignal`）
  验证投影分级与终止信号端到端传播。

## 后续（未包含在本提案）

- goal 模式「未批准不可执行有副作用工具」的真值闸门仍应下沉到 PermissionGrant 层（A 级，另开 ADR）。
- 渲染层可针对 `request_user_input` 的待决问题与 options 做更明确的交互呈现。
