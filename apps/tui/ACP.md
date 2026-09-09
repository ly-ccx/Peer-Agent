# Peer ACP Agent（开发中）

Peer 作为 Agent Client Protocol **Agent**，由编辑器或其他 ACP Client 启动。不是 ACP Client，也不替代 MCP。

> 首期实现已通过自动化验证，尚未发布或完成具体编辑器的人工接入验收。源码与构建后二进制均验证了真实 Peer runtime、工具授权、Evidence 和取消/断连；远程模型响应由隔离的本地测试服务提供，未验证真实云模型或编辑器兼容性。

## 安装 CLI 后接入 Zed

安装包含 ACP 功能的 CLI 后，用户无需源码仓库或 Bun，直接让 Zed 启动 `peer acp`。在 Zed 设置中合并以下配置：

```json
{
  "agent_servers": {
    "Peer": {
      "type": "custom",
      "command": "peer",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

若 Zed 找不到命令，在终端运行 `command -v peer`，将输出的可执行文件绝对路径填入 `command`，不要填写开发仓库目录或 npm 包内部目录。项目工作目录由 Zed 创建会话时传入，不是 CLI 安装目录；模型配置默认来自 `~/.peer-agent`，凭据由既有安全存储管理。保存后结束旧 Peer 进程，必要时重启 Zed，再新建 Peer 会话。不需要先启动 Desktop。

本次本地构建（2026-09-09）输出 `peer 0.0.12`，二进制 ACP 集成 9 项、204 个断言通过，涵盖分组、实际模型切换、双会话隔离、授权、取消及断连。历史退出 137 本轮重建后未复现，根因尚未确认；未修改系统安全策略。**本地构建通过不等于已发布**，此次没有发布、全局安装或修改用户 Zed 设置；已安装旧版不保证包含此功能。

模型分组、名称和顺序与 Peer 聊天共享同一投影；ACP 隐藏聊天中置灰的模型及空组，不额外排序或去重。渠道名称作为分组标题，模型名称优先使用 modelLabel，否则使用模型 ID；不将内部 UUID 附加到展示名称。Zed 如何呈现分组由客户端决定，尚未人工实测。

## 本地开发与产物验证

构建了包含本功能的 CLI 后，客户端启动配置的命令与参数为：

```json
{
  "command": "peer",
  "args": ["acp"]
}
```

这是命令/参数示例，不是某个编辑器的完整配置文件。请放入客户端规定的 Agent 配置位置。如果 PATH 中的 peer 是旧版本，应改用新构建产物的绝对路径。

源码开发入口（需安装仓库依赖）：

```sh
bun run apps/tui/src/index.tsx acp
```

客户端通过 stdin/stdout 交换换行分隔的 JSON-RPC，不能把终端文本作为协议。无需 TTY、Desktop 或 TUI 窗口。`peer acp` 暂不接受其他参数；会话 cwd 由 `session/new` 提供，必须是本机现存的绝对目录。

先在 Peer 配置模型与本机凭据。ACP 不提供登录流程，也不接受客户端传入 API key。握手成功不代表模型已配置或会话可以正常运行。

## 模型切换（2026-09-09）

会话创建通过 ACP `configOptions` 返回 `category=model` 的选择器，`session/set_config_option` 接通当前会话的实际模型选择。只展示 Peer 已配置且可用的模型，名称带 Provider 标识；使用 `PEER_MODEL_API_KEY` 等环境变量配置时，目录只有该单个模型。

在 Zed 中使用新构建的 `apps/tui/dist/peer`，结束旧 Peer 进程（必要时重启 Zed），再新建 Peer 会话。支持 Session Config Options 的 Zed 版本应在会话输入区的配置控件中展示 Model 选择；不是 OpenCode 的模型菜单，也不是 Zed 内置模型配置。若没有出现，检查 ACP 日志中 `session/new` 响应是否含 `configOptions`，确认没有使用旧二进制。

生成、工具执行或等待审批期间拒绝模型切换；先停止或等待本轮结束。切换仅影响当前会话，不修改全局默认，不影响其他会话。未知模型、非字符串值及未知配置键均拒绝。

验证矩阵：`models.test.ts` 覆盖合法/非法 × 空闲/忙碌 × 单/双会话八格，以及同名不同 Provider、不可用过滤、持久化失败回滚；`multi-session.integration.test.ts` 验证切换后的真实 HTTP model 字段、另一个会话保持原模型、全局配置未变化及原授权路径。源码和新构建二进制均通过自动化测试；测试模型服务与凭据 helper 为隔离 fixture。**尚未进行 Zed 人工界面实测**，不将协议通过等同于 Zed 兼容性认证。

## 推理强度与上下文窗口

当前构建通过 Session Config Options 提供以下会话配置：

- `reasoning_effort`：只有共享模型元数据明确声明 `supportsReasoning=true` 且存在多个支持档位时显示；档位来自当前模型目录。不支持或能力未知时不展示，也拒绝设置，不凭模型名称猜测。
- `context_window`：使用模型 `modelOptions` 中首个含正数 `contextWindow` 的定义，按其 choices 展示名称和容量；默认选中已配置值或定义默认值。只有静态容量而没有可选定义的模型不显示菜单。协议值采用 JSON 编码以区分字符串、数字及布尔选项。

两项设置只影响当前会话，不改全局配置或其他会话。生成、工具执行及等待审批期间一律拒绝配置修改；非法值不改变状态。切换模型时，目标仍支持的强度和上下文选项值保留；不支持时，强度回退目标默认档位，上下文回退目标已配置值或定义默认值。目标无容量选项时使用静态容量。

上下文容量由会话选择器统一供模型请求预算、controller 统计／压缩及会话容量记录读取。它不是任意扩大模型服务端能力的开关，也不承诺将所有 modelOptions.requestValue 转成服务端专属参数。

使用新的 `apps/tui/dist/peer` 后需结束旧 Peer 进程并新建会话；已经指向该文件的 Zed 配置无需改动。安装用户使用 `peer acp`，但本地构建不代表已发布，旧版 CLI 不会自动获得功能。

验证分层：`options.test.ts` 覆盖能力矩阵、强度×容量、两键合法性×忙碌状态×会话隔离及模型切换保留／回退；真实 stdio 集成验证请求强度与全局配置隔离；`chat-controller.test.ts` 的 ACP capacity 用例使用真实 controller 验证所选容量及压缩阈值，摘要响应使用替身。新二进制集成验证两项设置及原模型切换、授权、取消路径。**尚未进行 Zed 人工界面实测或真实云模型验收，也不将 controller 测试等同于二进制压缩端到端验证。**

## 首期范围

- initialize、session/new、session/prompt、session/cancel。
- 文本增量和结构化工具状态更新。
- 同一连接的独立会话；同一会话不允许并行 prompt。
- session/request_permission：仅本次允许和本次拒绝。
- 文件和终端由 Peer 本地 Provider 执行，沿用本地授权和 Evidence；不使用客户端文件/终端代理。
- 无效选择、客户端错误、60 秒审批超时、取消或断连均拒绝待审批操作；不保存为全局信任。

不支持：会话恢复、多模态、客户端指定 MCP servers、协议登录、远程服务。客户端提供非空 MCP servers 或非文本 prompt 会被拒绝，不会默默启用。交互型工具受既有非交互工具过滤约束。

## 验证与剩余缺口

```sh
pnpm --filter @peer-agent/tui exec bun test src/acp
pnpm --filter @peer-agent/tui exec bun test src/cli-entry.integration.test.ts src/cli-argv.test.ts src/tui-host.test.ts
pnpm --filter @peer-agent/tui typecheck
```

当前测试按以下行为轴组织，不能以测试数量代替完整验收：

| 行为轴 | 命名用例与验证层次 |
| --- | --- |
| 生命周期 × 输入 | production agent rejects…；real CLI protocol error / unknown method、invalid parameters、session before initialize；real CLI rejects malformed JSON / scalar JSON and recovers |
| 会话 × 结束方式 | isolated streaming sessions / normal、cancel、failure、disconnect（含双会话及重入）；real concurrent sessions / allow-once x deny、deny x allow-once（真实 runtime 交错） |
| 文本/工具 × 终态 | text and tool updates preserve order and identity / completed、failed、cancelled、denied、unknown（投影层）；real stdio runtime / text、allow-once、deny、cancel、running-cancel（真实执行与结束原因） |
| 权限选择 × 会话数 | permission allow-once、deny、unknown / 1、2；mixed concurrent approvals 的 4×3 逆序回复矩阵；真实双会话混合批准及文件结果检查 |
| 待审批 × 中断 | pending approval fails closed / cancel、disconnect、timeout、error、client-cancelled（含迟到回复）；real stdio runtime / disconnect、running-cancel、running-disconnect，确认启动 PID 随中断消失 |
| 能力声明 × 请求 | invalid lifecycle, workspace, capabilities and prompts never reach runtime；非文本和客户端 MCP 配置拒绝 |
| 入口 × 环境 | 无 TTY JSON 协议子进程；真实 runtime 文本、文件与 shell 测试；同一组 9 项集成测试在构建二进制上重复运行；原 CLI/Host/Controller 回归 |

2026-09-08 汇总：ACP 50 项、相关回归 87 项、构建二进制集成 9 项均通过，CLI 类型检查通过。文件允许/拒绝/取消场景核对本地 Evidence 索引；执行中取消还验证 shell PID 消失。测试使用临时 HOME，不调用付费云模型。未逐一验证第三方编辑器、真实云模型、全部操作系统或所有后台进程形态。

上述结果不代表第三方编辑器兼容性认证。此前 `src/skill-mcp-bridge.ts:151` TS2352 已通过修正 Skill store 可省略工作区参数的默认值解决；重建 runtime-node 后 CLI 类型检查通过，Skill store 24 项回归通过。审批 helper 另有 mixed concurrent approvals 的 4×3 逆序回复矩阵，但不替代完整跨会话运行时验收。

架构边界记录于配套 peer-knowledge 的 `knowledge/decisions/76-peer-acp-agent.md`。
