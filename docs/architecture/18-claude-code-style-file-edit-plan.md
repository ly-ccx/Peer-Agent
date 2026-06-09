# Claude Code 风格文件编辑机制计划

日期：2026-06-09
状态：计划草案

本文定义 Peer Agent 后续要补齐的本地代码变更机制。目标不是把 Claude Code 的实现逐行搬过来，而是吸收它在文件编辑上的关键约束：

```text
模型只能通过真实工具改变本地文件。
已有文件必须先读后改。
改动必须可校验、可回放、可拒绝、可追踪。
```

这套机制要同时解决当前暴露出来的几个问题：

- assistant 文本里出现 `[Tool call]` / `[Tool result]` 时，不能被当成真实工具调用。
- 模型不能在没有工具证据时声称已经读取、修改或验证。
- `write_file` 不能继续作为修改已有源码文件的主路径。
- 代码变更必须有 read-before-write、mtime 冲突检查和 diff 证据。
- UI 必须能区分“正在调用工具”“工具成功/失败”“等待用户批准文件写入”。

## 一、当前现状

当前 LLM 本地工具链主要在以下位置：

- `apps/desktop/electron/main/llm-prompts.mjs`
- `apps/desktop/electron/main/llm-chat-service.mjs`
- `apps/desktop/renderer/src/chat/components/ChatSurface.tsx`

当前已经有：

- `bash`
- `read_file`
- `write_file`
- backend `chat:stream:tool-call`
- backend `chat:stream:tool-result`
- renderer 工具调用卡片
- shell / read 结果的 artifact-backed preview

但当前还没有：

- `edit_file`
- `old_string` / `new_string` 精确替换
- `replace_all`
- per-conversation read state
- 已有文件写入前的强制 read 校验
- read 后 mtime / hash 防冲突
- structured patch / diff artifact
- 文件写入前的 permission dialog
- 写入失败后标准化 tool result

当前 `write_file` 是直接整文件写入：

```text
write_file(path, content) -> writeFileSync(filePath, content)
```

这对创建新文件可以接受，但不适合作为修改已有代码的主路径。

## 二、Claude Code 参考基线

本计划对齐 Claude Code 的方法，而不是对齐它的 UI 细节。

核心基线：

1. `Read` 是编辑已有文件的前置条件。
2. `Edit` 使用 `old_string` / `new_string` 做精确替换。
3. `old_string` 默认必须唯一命中。
4. 多处替换必须显式传 `replace_all`。
5. 写入前要检查文件是否在 read 之后被外部改过。
6. 变更要生成 diff / structured patch。
7. 文件写入要经过权限系统。
8. 工具执行结果必须以真实 `tool_result` 回到模型。

Peer Agent 不需要复制 Claude Code 的所有内部模块名，但必须保留这些行为约束。

## 三、设计原则

### 3.1 真实工具优先

只有 provider 原生返回的 tool call / tool use 可以触发本地执行。

assistant 普通文本里的这些内容都只能作为文本：

```text
[Tool call: bash {...}]
[Tool result]
我已经调用 bash...
我现在发起 read_file...
```

这些文本不能被解析成真实工具调用，不能执行，也不能写入“真实工具记录”。

如果需要兼容历史文本，最多只能在 UI 上标记为：

```text
历史文本中的伪工具标记，不是一次真实工具调用。
```

不得再把它转换成可执行工具调用。

### 3.2 编辑已有文件不用 `write_file`

`write_file` 只承担两个场景：

- 创建新文件。
- 用户明确要求完整替换文件，或模型已经有完整文件上下文并通过权限确认。

修改已有源码、配置、文档时默认使用：

```text
read_file -> edit_file -> verify
```

### 3.3 Summary 不能替代 Evidence

模型可以总结工具结果，但不能把总结当成事实本体。

文件读写结果要保留结构化 evidence：

- file path
- mtime
- size
- content hash
- diff artifact
- status
- error reason

### 3.4 失败也是 tool result

任何工具调用都必须有对应 tool result。

包括：

- 权限拒绝
- old_string 未命中
- old_string 多处命中
- 文件被外部修改
- 写入失败
- 用户停止

不能出现 assistant tool call 已经发出，但后续没有 tool result 的状态。

## 四、目标工具集

### 4.1 `read_file`

用途：

- 读取已知路径。
- 生成 bounded preview。
- 建立 read state。

目标返回：

```ts
type ReadFileResult = {
  kind: 'local_file_ref';
  tool: 'read_file';
  path: string;
  chars: number;
  lines: number;
  mtimeMs: number;
  sizeBytes: number;
  contentHash: string;
  fullRead: boolean;
  preview: string;
  contextPreviewTruncated: boolean;
  suggestedRetrieval: string[];
};
```

read state 需要保存：

```ts
type ReadFileState = {
  conversationId: string;
  workspacePath: string;
  filePath: string;
  contentHash: string;
  mtimeMs: number;
  sizeBytes: number;
  fullRead: boolean;
  readAt: string;
};
```

第一阶段可以只保存在本次 `sendMessage` 工具循环内；第二阶段升级为 conversation-scoped state。

### 4.2 `edit_file`

用途：

- 修改已有文件。
- 用精确字符串替换，避免模型生成整文件覆盖。

参数：

```ts
type EditFileArgs = {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};
```

规则：

- `path` 必须解析到允许的 workspace 范围内，除非用户明确授权绝对路径。
- 文件必须存在。
- 文件必须在当前会话中被 `read_file` 完整读取过。
- 当前 mtime / size / hash 必须与 read state 匹配。
- `old_string` 必须非空。
- `replace_all !== true` 时，`old_string` 必须唯一命中。
- `replace_all === true` 时，必须命中至少一次。
- 替换后生成 unified diff 和 structured patch。
- 写入后更新 read state。

目标返回：

```ts
type EditFileResult = {
  kind: 'file_edit_result';
  tool: 'edit_file';
  status: 'success' | 'blocked' | 'failed';
  path: string;
  replacements: number;
  bytesBefore: number;
  bytesAfter: number;
  mtimeBefore: number;
  mtimeAfter?: number;
  contentHashBefore: string;
  contentHashAfter?: string;
  diffPreview: string;
  diffArtifactRef?: string;
  reason?: string;
};
```

### 4.3 `write_file`

用途：

- 创建新文件。
- 完整替换生成物。
- 少数明确的全量重写。

规则：

- 新文件可以直接进入 permission review。
- 已有文件默认拒绝，提示使用 `edit_file`。
- 如果用户明确要求全量替换，仍必须先 `read_file`，并通过 diff permission。
- 写入后返回 file write result，并更新 read state。

目标返回：

```ts
type WriteFileResult = {
  kind: 'file_write_result';
  tool: 'write_file';
  status: 'success' | 'blocked' | 'failed';
  path: string;
  created: boolean;
  bytesWritten?: number;
  diffPreview?: string;
  diffArtifactRef?: string;
  reason?: string;
};
```

### 4.4 `bash`

`bash` 保持现有职责：

- 搜索。
- 构建。
- 测试。
- git inspection。
- 必要的项目脚本。

约束：

- 不允许用 shell redirection / heredoc 绕过 `edit_file` / `write_file` 写源码。
- 明确禁止模型用 `python - <<EOF`、`perl -pi`、`sed -i` 等方式修改用户文件，除非用户显式要求这种命令。
- 后续可以把高风险写 shell 命令接入 PermissionReview。

## 五、执行生命周期

### 5.1 OpenAI 路径

```text
assistant tool_calls
  -> emit chat:stream:tool-call
  -> executeTool
  -> emit chat:stream:tool-result
  -> append role=tool message
  -> continue model loop
```

要求：

- 只接受 API 返回的 `tool_calls`。
- 不解析 assistant text 里的伪工具标记。
- 工具失败也 append `role=tool`。
- stop / abort 时，为正在执行或已声明的 tool call 生成 cancelled result。

### 5.2 Anthropic 路径

```text
assistant content: tool_use
  -> emit chat:stream:tool-call
  -> executeTool
  -> emit chat:stream:tool-result
  -> append user content: tool_result
  -> continue model loop
```

要求：

- 只接受 API 返回的 `tool_use` block。
- 不解析 text block 里的伪工具标记。
- 每个 `tool_use` 必须有配对 `tool_result`。

### 5.3 取消与停止

用户点击停止时：

- abort 当前 stream。
- 如果工具尚未启动，返回 `cancelled before execution`。
- 如果工具正在执行，调用对应 provider 的 stop 逻辑。
- 如果工具无法中断，UI 必须显示 `cancelling`，直到进程退出或超时。
- 已声明 tool call 必须落一个失败或取消 result。

## 六、Permission 与 Diff UI

### 6.1 第一阶段

第一阶段可以不做完整弹窗，但必须返回 diff evidence：

- tool card 展示文件路径。
- tool card 展示 replacements。
- 展开后展示 diff preview。
- diff 太长时写 artifact，只展示前后片段。

### 6.2 第二阶段

接入文件编辑 permission dialog：

```text
edit_file requested
  -> compute patch in memory
  -> renderer shows diff
  -> user approve / deny
  -> main process writes or returns denied result
```

UI 状态：

- `pending_permission`
- `approved`
- `denied`
- `writing`
- `success`
- `failed`

用户拒绝时，模型收到标准 tool result：

```text
File edit denied by user.
```

模型不能把拒绝解释成已经完成。

### 6.3 与现有 Runtime Gateway 的关系

当前 Runtime Gateway 已有 `PermissionReview` 和 local shell provider。文件编辑机制不应另起一套无边界的写入通道。

落地顺序：

1. 先在 LLM 本地工具链内实现 read/edit/write 的安全语义。
2. 再把文件写权限接入统一 PermissionReview。
3. 最后把 file capability provider 化，纳入 Runtime Gateway / Local Tool Host 体系。

## 七、Prompt 改造

系统提示词需要明确：

- 使用 `edit_file` 修改已有文件。
- `write_file` 只用于新文件或明确全量重写。
- 不能描述工具调用，必须真实调用工具。
- 不能用 shell 写文件绕过文件工具。
- 修改后必须尽量验证。

`edit_file` tool description 必须写清：

- 已有文件必须先 `read_file`。
- `old_string` 必须完全匹配。
- 多处替换必须显式 `replace_all`。
- 如果失败，要重新读取文件，不要猜测。

`write_file` tool description 必须降权：

- Prefer `edit_file` for existing files.
- Existing user-authored files require prior `read_file`.
- Full replacement requires user intent or permission.

## 八、Compaction 规则

文件编辑相关消息压缩时，不能丢掉关键 evidence。

可以压缩：

- 大 diff 全文。
- 大文件 preview。
- 长 shell 输出。

不能压缩掉：

- tool call id。
- tool name。
- path。
- status。
- old/new hash。
- mtime before/after。
- diff artifact ref。
- permission decision。

压缩后的摘要至少保留：

```text
edit_file path=...
status=success
replacements=1
hashBefore=...
hashAfter=...
diffArtifact=...
verifiedBy=...
```

## 九、分阶段实施计划

### M0：工具真实性清理

目标：消除伪工具调用造成的混乱。

任务：

- 移除或禁用 assistant text -> executable tool call 的 fallback。
- 保留历史伪标记的 UI 展示，但标明它不是工具记录。
- 确保 provider 没有返回 tool call 时，不执行任何本地动作。
- no-tool 场景只允许重试或报错，不允许自动制造工具调用。

验收：

- assistant 输出 `[Tool call: bash ...]` 时不会执行 bash。
- UI 不把伪标记显示成真实工具成功。
- 单测覆盖 OpenAI / Anthropic 两条路径。

### M1：Read state 与路径安全

目标：为安全编辑建立基础状态。

任务：

- `read_file` 返回 mtime、size、hash、fullRead。
- `executeTool` 引入 per-conversation read state。
- 路径解析统一成 `resolveToolPath`。
- 阻止默认写出 workspace 之外，除非用户明确给绝对路径且配置允许。

验收：

- 读取后可以在 read state 查到文件快照。
- 未读取文件时编辑会失败。
- workspace-relative 和 absolute path 行为一致可测。

### M2：`edit_file` 引擎

目标：实现精确编辑。

任务：

- 新增 tool registry 项：`edit_file`。
- 实现 `old_string` 唯一命中校验。
- 实现 `replace_all`。
- 实现 mtime / size / hash 冲突检测。
- 实现 diff preview 和 diff artifact。
- 写入成功后更新 read state。

验收：

- `old_string` 未命中返回 blocked/failed。
- `old_string` 多处命中且未传 `replace_all` 返回 blocked。
- 文件 read 后被外部改动，编辑返回 stale file error。
- 成功编辑返回 replacements、hash before/after、diff。

### M3：`write_file` 收紧

目标：避免整文件覆盖成为默认编辑路径。

任务：

- 新文件允许 `write_file`。
- 已有文件默认要求 read state。
- 已有源码文件如果没有明确全量替换意图，返回错误并提示使用 `edit_file`。
- 全量替换也生成 diff result。

验收：

- 未读取已有文件时 `write_file` 失败。
- 创建新文件成功。
- 替换已有文件会返回 diff evidence。

### M4：Renderer 工具卡片升级

目标：让用户看清楚真实工具状态。

任务：

- tool card 支持 `read_file` / `edit_file` / `write_file` 专用 summary。
- 展开区支持 diff preview。
- 伪工具文本显示为 synthetic，不混入真实执行链。
- 长 diff 不撑宽窗口，使用 wrapping / scroll-contained code block。

验收：

- `edit_file` 成功后 UI 显示路径、替换次数、状态。
- diff 不导致整个 chat 横向滚动。
- synthetic 工具标记和真实工具调用视觉上可区分。

### M5：Permission dialog

目标：接近 Claude Code 的代码变更确认体验。

任务：

- main process 先计算 patch，不立即写入。
- renderer 弹出 diff permission request。
- 用户 approve 后写入。
- 用户 deny 后返回 denied tool result。
- permission decision 进入 conversation evidence。

验收：

- 用户能在写入前看到 diff。
- deny 后文件不变，模型收到 denied result。
- approve 后文件改变，模型收到 success result。

### M6：验证与回归

目标：防止工具链再退化。

任务：

- 补 `llm-chat-service` 单测。
- 补 edit engine 单测。
- 补 renderer tool card 测试。
- 用真实 Electron dev session 验证：
  - 新会话工具调用。
  - 老会话工具调用。
  - long output compaction 后工具调用。
  - stop/cancel。
  - diff 不溢出窗口。

验收：

- typecheck 通过。
- 单测通过。
- 老会话不会因为历史伪工具文本触发执行。
- 大输出后不会突然清空并只剩几个字。

## 十、测试清单

必须覆盖：

- `read_file` records hash / mtime / size。
- `edit_file` without prior read is rejected。
- `edit_file` with missing `old_string` is rejected。
- `edit_file` with duplicate `old_string` is rejected unless `replace_all`。
- `edit_file` detects stale file after external change。
- `edit_file` writes exact replacement and updates read state。
- `write_file` creates new file。
- `write_file` rejects existing file without read state。
- `write_file` full replacement returns diff。
- OpenAI tool call success appends `role=tool`。
- OpenAI tool call failure still appends `role=tool`。
- Anthropic tool use success appends `tool_result`。
- Anthropic tool use failure still appends `tool_result`。
- Assistant text `[Tool call]` does not execute。
- Renderer shows synthetic marker separately from real tool call。

## 十一、风险与约束

### 11.1 不要再引入文本替换型 stream hack

之前的 `chat:stream:replace` 思路不应恢复。

正确方向是：

```text
真实工具事件驱动 UI
```

而不是：

```text
模型先输出一段错文本，客户端再替换成另一段文本
```

### 11.2 不要让 bash 成为写文件后门

如果 prompt 只要求模型不用 bash 写文件，但 runtime 不拦截，约束是不完整的。

短期可以靠 prompt 降低概率；中期必须在 bash risk classifier 里识别写文件命令。

### 11.3 不要把 preview 当完整文件

如果 `read_file` 只返回 preview，却把 read state 标为 `fullRead=true`，会导致错误编辑。

第一阶段可以让 `read_file` 后端完整读取文件，只给模型 preview，但 read state 保存 hash/mtime/size。大文件需要单独的 range read 设计，不能伪装成完整读取。

### 11.4 不要在 compact 后丢失编辑证据

一旦 compact 删除了 read state 或 diff artifact ref，后续模型会失去可验证上下文。

compact 可以减少文本，但不能删除 evidence 索引。

## 十二、最终验收标准

这套机制完成后，Peer Agent 应满足：

1. 普通 assistant 文本永远不会触发本地工具。
2. 修改已有文件必须先读。
3. 修改已有文件默认走 `edit_file`。
4. 旧内容不匹配时不会猜测写入。
5. 文件被外部改动时不会覆盖。
6. 每次写入都有 diff evidence。
7. 用户可以在 UI 中看清楚真实工具调用和结果。
8. 工具调用失败、拒绝、取消都有标准 tool result。
9. compact 后仍能追踪文件变更证据。
10. 老会话和新会话使用同一套工具真实性规则。

达到这些标准后，才能认为 Peer Agent 的文件编辑机制接近 Claude Code 的安全基线。
