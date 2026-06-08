# 0.0.1 高风险写入范围裁剪

## 结论

`0.0.1` 不开放 OpenClaw Governance、OpenClaw Studio、Agent Memory migration / simulation 这类高风险写动作的客户端执行按钮。

客户端在 `0.0.1` 的职责是：

- 展示真实云端 POST 能力的目录、风险、权限 gate、审计字段和 Evidence 要求。
- 让操作者能看到为什么当前不能直接执行。
- 保留未来接入执行闭环所需的协议和 UI 位置。

客户端在 `0.0.1` 明确不做：

- 不绕过云端策略执行 Governance / Studio / Memory 写动作。
- 不把个人经验、偏好或本地私有工具习惯自动写入云端 Patch。
- 不提供裸按钮触发 approve、promote、apply、takeover、migration、simulation、task evidence 等高风险动作。

## 原因

高风险写动作改变的是组织级运行态、Agent 认知演进、发布状态、记忆迁移或调度结果。它们不属于“客户端能力等价复刻”的第一阶段执行面。

`0.0.1` 的等价边界是：

```text
可读、可见、可审计、可确认边界
  !=
可直接执行高风险云端写动作
```

这保持了当前设计原则：

- 云端为准，个人为辅。
- 云端 Agent Runtime 负责认知、规划、调度、工具选择和治理。
- 客户端只做本地能力代理、授权、执行和 Evidence 闭环。

## 未来开放条件

未来版本要开放执行按钮，至少需要同时满足：

| 条件 | 要求 |
|---|---|
| 云端策略 | 云端返回当前操作者、组织、Agent、场景下是否允许该写动作。 |
| Effective Config | 客户端展示本次写动作实际生效的策略、版本和约束。 |
| 操作者确认 | 高风险动作必须二次确认，确认文案包含目标、影响范围和回滚方式。 |
| 审计原因 | 必填 reason / ticket / change source，不能由客户端静默生成。 |
| 幂等保护 | 每次写动作必须携带 idempotency key 或等价防重放字段。 |
| Evidence 回传 | 执行结果必须返回 Evidence，包括请求摘要、云端结果、操作者、时间和失败原因。 |
| 回滚或补偿 | 对 release、promotion、memory migration 等动作必须定义失败后的补偿路径。 |

## 当前实现证据

- OpenClaw write gate matrix: `packages/protocol/src/openclaw-write-policy.ts`
- Agent Memory write gate matrix: `packages/protocol/src/agent-memory-write-policy.ts`
- UI panels: `OpenClawWriteGatePanel`, `AgentMemoryWriteGatePanel`
- 静态审计：`scripts/client-parity-audit.mjs` 要求所有高风险写策略保持 `blocked_until_gated`
