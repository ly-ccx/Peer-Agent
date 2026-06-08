# 生产 E2E 验收 Runbook

本文档定义 `0.0.1` 端云能力等价目标的生产验收口径。它不是自动化测试替代品，而是用于记录真实 BUC 生产登录、Cloud Gateway 生产链路、本地能力代理、Evidence 回传和高风险写入阻断是否真正跑通。

## 验收范围

验收必须运行在：

- 分支：`dev/0.0.1`
- 环境：`prod`
- 登录：BUC 生产 OAuth
- Cloud Gateway：生产 Cloud Runtime endpoint

验收要证明桌面端使用的是真实云端运行态数据，并且本地能力执行仍然保持“客户端主动发起、显式授权、Evidence 回传”的边界。

## 预检

启动桌面端前先运行：

```bash
npx --yes pnpm@10.22.0 prod-e2e:preflight
```

环境变量可以参考仓库根目录 `.env.example`。复制成本地 `.env` 后，桌面 main 进程和 `prod-e2e:preflight` 会自动读取，但不会覆盖 shell 中已经设置的变量。该文件只包含 BUC PKCE 公开配置和生产 Cloud Gateway 默认值，不包含也不允许包含 `client_secret`。

预检只检查本机验收条件，不执行登录，不读取或输出 token。它会验证当前分支、版本、BUC PKCE 配置、Cloud Gateway 生产 HTTPS URL、gateway 可达性、redirect 端口和 `client_secret` 禁用状态；明显的 pre host 不能作为 prod 验收通过。

如果预检通过，再运行云端合约探针：

```bash
npx --yes pnpm@10.22.0 prod-e2e:probe-contract
```

探针不读取 token，也不代表完整登录验收。它用未登录请求检查客户端关键云端合约是否至少存在：本地能力轮询、Evidence 回传、Runtime Projection 发布、Chat Statistics export、OpenClaw Governance、OpenClaw Studio。`400`、`401`、`403`、`405`、`422` 代表路由存在但需要鉴权或有效参数；`404`、`501`、`5xx`、timeout 代表生产验收前必须处理的云端阻塞。

需要给后端交付机器可读证据时，可以写出 snapshot。命令在存在 blocker 时仍会返回非零，避免误判为验收通过：

```bash
npx --yes pnpm@10.22.0 prod-e2e:probe-contract --out docs/architecture/cloud-contract-probe.<date>.json
npx --yes pnpm@10.22.0 prod-e2e:probe-contract --json
```

云端修复这些阻塞时，按 `docs/architecture/11-client-runtime-cloud-contract-handoff.md` 的路由、请求/响应形状、安全 gate 和验收标准实现。

桌面端 Local Capability Proxy 面板也暴露同一套探针，便于在真实会话验收时直接把云端合约状态作为诊断 Evidence 记录下来。

## 必验项

每个检查项都必须在报告 JSON 中记录为 `status: "pass"`，并填写一段简短 Evidence。

| Check ID | 验收要求 |
|---|---|
| `bucLogin` | BUC 生产登录成功，客户端能渲染真实用户身份。 |
| `cloudRuntimeConnected` | Cloud Runtime 状态指向生产环境，并显示已连接或已配置。 |
| `conversationList` | 能加载真实云端会话列表。 |
| `conversationCreate` | 能创建或选择一条真实云端会话作为验收会话。 |
| `messageStream` | 发送消息后能启动并完成真实云端 stream。 |
| `timelineThinking` | Thinking timeline 来自真实 stream 或历史 message 数据。 |
| `toolTimeline` | Tool timeline 来自真实 Tool Call 数据，或记录真实无工具调用的 Evidence 状态。 |
| `humanConfirmationOrNoPending` | 待确认 UI 可用，或基于真实数据记录当前无待确认项。 |
| `sharePanel` | Share list/create/revoke 或只读 Share 状态经过真实接口验证。 |
| `workingMemory` | Working Memory 面板读取真实数据或真实空态。 |
| `memoryWiki` | Memory Wiki status/pages 读取真实数据或真实空态。 |
| `billingSummary` | Billing summary 读取真实数据或真实空态。 |
| `channelFilters` | Channel filters 基于真实会话数据渲染计数。 |
| `channelEvidence` | Channel Evidence 面板能渲染真实会话或消息来源元数据。 |
| `governanceRead` | Governance/OpenClaw 只读面板加载真实数据或真实空态。 |
| `observabilityRead` | Trace、Tool、Thinking、Memory Compile 观测面板读取真实数据或真实空态。 |
| `statisticsRead` | Chat Statistics 能读取 overview、trend、ranking、realtime 真实数据或真实空态。 |
| `statisticsExport` | Chat Statistics 优先触发云端 `/api/chat/statistics/export`；若云端无导出产物，则记录本地 JSON/CSV 快照兜底 Evidence。 |
| `agentStudioRead` | Agent Studio 能读取当前 scene、channel、session 真实数据或真实空态。 |
| `localProxyPolling` | Local Proxy polling 启动，并收到云端任务轮询响应。 |
| `localPermissionReview` | 本地能力执行前出现本地授权 Review。 |
| `evidenceReturn` | 本地能力结果生成 Evidence，并在用户明确发送后回传云端。 |
| `writeGatesBlocked` | OpenClaw 和 Agent Memory 写入门禁显示为 blocked，且没有可执行的高风险写入按钮。 |
| `logout` | BUC logout 完成，或 access token 被失效。 |

## 报告格式

先生成一份带当前分支、commit 和 testerWorkId 的待填写报告：

```bash
npx --yes pnpm@10.22.0 prod-e2e:create-report --tester <work_id> --out docs/architecture/prod-e2e-report.<date>.json
```

如果要把当前云端合约探针快照直接写入报告，使用：

```bash
npx --yes pnpm@10.22.0 prod-e2e:create-report --tester <work_id> --out docs/architecture/prod-e2e-report.<date>.json --with-contract-probe
```

也可以直接参考模板：

`docs/architecture/prod-e2e-report.template.json`

填写真实验收结果后，在同一个 commit 上运行：

```bash
npx --yes pnpm@10.22.0 prod-e2e:validate docs/architecture/prod-e2e-report.<date>.json
```

最后运行 completion audit：

```bash
npx --yes pnpm@10.22.0 parity:completion-audit
```

validator 会检查 report version、分支、当前 HEAD commit、所有必验项状态和 Evidence。如果报告包含 `cloudContractProbe`，则 `blockerCount` 必须为 `0`，且不能存在 `404` / `501` / `5xx` / timeout 归类的 blocker。`parity:completion-audit` 会把线程目标拆成协议、Chat Kernel、Cloud Gateway、真实会话流、Share/Memory/Billing/Channel、本地代理边界、task-thread Evidence artifact、云端合同交接、云端合同 blocker snapshot 和生产验收十类证据，并在没有当前 HEAD 的真实生产 E2E pass 报告时失败。只有真实生产报告和 completion audit 都通过后，才能把当前目标从“实现已接近完成”推进到“生产验收完成”。在此之前，不应把 `/goal` 标记为 complete。
