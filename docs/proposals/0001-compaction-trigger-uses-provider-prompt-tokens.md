# Proposal: 压缩触发应消费 provider 报告的当前 prompt token，而非字符估算

状态：草案（待批准后毕业为 `docs/architecture/33-*`）
日期：2026-06-16
分级：A 级（涉及压缩触发契约、System Context 排序边界与 usage 数据消费方向）

## 0. 术语澄清：三个被混淆的量

讨论中出现过“压缩依赖计费”的说法，这是措辞错误。先把三个**本不同源、不同量纲**的量分开：

| 代号 | 来源（代码） | 含义 | 正确用途 |
|---|---|---|---|
| A. 字符估算 | `context-compactor.mjs:132` `estimateTokensFromMessages` = `chars/4` | 当前 prompt 的**粗略上界** | 仅当 B 不可得时的兜底 |
| B. provider prompt token | provider 响应 `usage.input_tokens` | 当前 prompt 的**真实窗口占用** | 压缩触发应消费此值 |
| C. lifetimeUsage（计费账本） | `conversation-store.mjs:117-131` 累加 `input+output` | **整场会话累计**用量与成本 | 底部账单展示 |

关键边界（见 `docs/architecture/25-runtime-usage-ledger.md`）：

- C 单调累加、**压缩不重置**（测试 `lifetimeUsage survives replaceMessages`）。它衡量“这场会话总共烧了多少”，**不是**“当前 prompt 占了多少窗口”。
- 因此**不得用 C 驱动压缩**：拿累计账单去管当前窗口余量，量纲不对。
- B 与 C 仅**共用同一段 provider usage 解析入口**（adapter 解析 → agent loop 聚合 → 分别流向触发判据与计费账本）。共用解析路径 ≠ 压缩依赖计费。

本提案主张：**压缩触发消费 B，A 降级为兜底，C 与压缩彻底解耦。**

## 1. 现状

`context-compactor.mjs`：

- `shouldCompact(estimatedTokens, contextWindow)`（:415-417）：
  `return estimatedTokens > contextWindow * COMPACTION_CONFIG.triggerRatio;`（triggerRatio = 0.8）
- `estimatedTokens` 全程来自 `estimateTokensFromMessages`（A，`chars/4`）。
- 触发判据从不读取 provider 的 `usage.input_tokens`（B）。

## 2. 三个矛盾

1. **触发量与真实量脱节**：用 `chars/4`（A）近似窗口占用，对中日韩文本、代码、base64、工具结构化输出误差大，导致早压（浪费上下文与一次额外 LLM 调用）或晚压（请求超窗失败）。真实窗口占用 B 在每次 provider 响应里已经有了，却没被触发判据消费。

2. **数据消费方向不一致**：项目已确立 `Provider Usage -> Agent Loop Usage -> Runtime Ledger -> Renderer Display` 的 usage 流。计费侧（C）消费了 provider 真实 usage，压缩侧却退回本地字符估算（A），同一份权威信号在两条路径上待遇不一致。

3. **量纲混用风险**：因 B 与 C 共用解析入口，容易误把“累计账本（C）”接到压缩触发上。C 压缩不重置，一旦误用会随会话变长持续抬高，造成反复无意义压缩。必须在契约层显式禁止。

## 3. 提案

- 触发判据优先消费 **B**：以最近一次 provider 响应的 `usage.input_tokens`（含 cache 读相关字段，按 provider 语义）作为“当前 prompt 真实 token”。
- **A 降级为兜底**：仅在尚无任何 provider 响应（首轮）或 provider 未返回 usage 时使用 `estimateTokensFromMessages`。
- **C 与压缩解耦**：在契约与测试中显式声明 `lifetimeUsage` 不得进入压缩触发路径。
- 判据形如：`promptTokens(B 优先, A 兜底) > contextWindow * triggerRatio`，`triggerRatio`/`targetRatio` 不变。

## 4. 架构影响（A 级）

- 不新增执行路径：B 已沿既有 usage 流到达 main/runtime，触发器改为读取已存在的权威信号。
- System Context 排序不变；压缩仍只重写消息文件、不碰 meta（`main.mjs:483-484`）。
- Seam：在 compactor 暴露“当前 prompt token 来源”这一 Interface，B 为主 Adapter、A 为兜底 Adapter，避免在判据里散落分支。

## 5. 验证计划

- 单测：B 存在时走 B；B 缺失时回落 A；断言 C（lifetimeUsage）永不进入触发判据。
- 回归：`conversation-store.test.mjs`、`llm-chat-service.test.mjs` 维持计费与压缩互不影响。

## 6. 待用户确认

1. cache 读 token 是否计入 B 的“当前 prompt 占用”（按 provider 语义可能应计入）。
2. 批准后是否将本草案毕业为 `docs/architecture/33-compaction-trigger-source.md`。
