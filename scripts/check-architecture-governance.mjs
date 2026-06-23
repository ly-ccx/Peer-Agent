import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function collectFiles(rootRelativePath, extensions) {
  const rootPath = path.join(repoRoot, rootRelativePath);
  if (!existsSync(rootPath)) return [];
  const result = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const stats = statSync(current);
    if (stats.isDirectory()) {
      if (path.basename(current) === 'node_modules') continue;
      for (const entry of readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (extensions.some((ext) => current.endsWith(ext))) {
      result.push(current);
    }
  }
  return result;
}

function relative(filePath) {
  return path.relative(repoRoot, filePath);
}

function assertAgentRules() {
  const agentPath = 'AGENTS.md';
  if (!existsSync(path.join(repoRoot, agentPath))) {
    fail('AGENTS.md is required at the repository root.');
    return;
  }

  const content = readText(agentPath);
  const requiredSnippets = [
    '端云能力代理设计原则',
    '云端负责认知',
    'Capability Provider',
    'Runtime Projection',
    'PermissionGrant',
    'Evidence',
    'System Context Rules',
    'Do not let renderer directly use `fs`, `child_process`',
  ];

  for (const snippet of requiredSnippets) {
    if (!content.includes(snippet)) {
      fail(`AGENTS.md is missing required governance text: ${snippet}`);
    }
  }
}

function assertArchitectureDocsStayLocal() {
  const gitignorePath = '.gitignore';
  if (!existsSync(path.join(repoRoot, gitignorePath))) {
    fail('.gitignore is missing.');
    return;
  }

  const gitignore = readText(gitignorePath);
  if (!/^\s*docs\/architecture\/\*\s*$/m.test(gitignore)) {
    fail('.gitignore must keep docs/architecture/* ignored because architecture docs are local-only.');
  }
  if (/^\s*!docs\/architecture\//m.test(gitignore)) {
    fail('.gitignore must not un-ignore individual docs/architecture files.');
  }

  const trackedArchitectureDocs = execFileSync('git', ['ls-files', 'docs/architecture'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (trackedArchitectureDocs) {
    fail(`docs/architecture files must stay local-only, but git tracks:\n${trackedArchitectureDocs}`);
  }
}

function assertRendererHasNoHighPrivilegeImports() {
  const files = collectFiles('apps/desktop/renderer/src', ['.ts', '.tsx', '.js', '.jsx']);
  const forbiddenPatterns = [
    {
      label: 'fs import',
      pattern: /(?:from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(['"](?:node:)?fs(?:\/promises)?['"]\))/,
    },
    {
      label: 'child_process import',
      pattern: /(?:from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\))/,
    },
    {
      label: 'direct ipcRenderer usage',
      pattern: /\bipcRenderer\b/,
    },
  ];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(content)) {
        fail(`Renderer file ${relative(filePath)} contains forbidden ${label}. Use preload typed APIs instead.`);
      }
    }
  }
}

function assertNoStreamReplaceChannel() {
  const forbiddenChannel = ['chat', 'stream', 'replace'].join(':');
  const files = [
    ...collectFiles('apps/desktop/electron', ['.mjs', '.cjs', '.js']),
    ...collectFiles('apps/desktop/renderer/src', ['.ts', '.tsx', '.js', '.jsx']),
    ...collectFiles('packages', ['.ts', '.tsx', '.js', '.jsx', '.mjs']),
  ];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    if (content.includes(forbiddenChannel)) {
      fail(`${relative(filePath)} references forbidden stream replacement channel ${forbiddenChannel}. Use append-only delta/done/error/tool events.`);
    }
  }
}

function assertSystemContextProtocolContracts() {
  const protocolPath = 'packages/protocol/src/system-context.ts';
  if (!existsSync(path.join(repoRoot, protocolPath))) {
    fail('System Context protocol contracts must live in packages/protocol/src/system-context.ts.');
    return;
  }
  const protocol = readText(protocolPath);
  for (const snippet of [
    'AttachmentContextItem',
    'ConfigInstructionContextItem',
    'ContextExtensionItem',
    'ContinuityContextItem',
    'ChatSendRequest',
    'PromptBaselineRecord',
    'PromptContextEpochRecord',
    'PromptSnapshotIndexEntry',
    'contextEpochId',
  ]) {
    if (!protocol.includes(snippet)) {
      fail(`${protocolPath} is missing required contract ${snippet}.`);
    }
  }

  const preloadContract = readText('apps/desktop/renderer/src/preload/contracts/bootstrapPreloadApi.ts');
  if (!preloadContract.includes('ChatSendRequest')) {
    fail('BootstrapPreloadApi.chatSend must use protocol ChatSendRequest, not an ad hoc inline payload.');
  }

  const main = readText('apps/desktop/electron/main/main.mjs');
  if (!main.includes('configInstructions') || !main.includes('contextExtensions')) {
    fail('main.mjs chat:send must pass protocol configInstructions/contextExtensions into llm-chat-service.');
  }

  const chatSurface = readText('apps/desktop/renderer/src/chat/components/ChatSurface.tsx');
  if (!chatSurface.includes('buildConfigInstructionContext') || !chatSurface.includes('configInstructions')) {
    fail('ChatSurface must lower persisted configured instructions into protocol configInstructions.');
  }

  const projectInstructionsSource = readText('apps/desktop/electron/main/prompt/sources/project-instructions-source.mjs');
  if (!projectInstructionsSource.includes('configInstructions')) {
    fail('project-instructions-source.mjs must admit configured instructions through the project.instructions Context Source.');
  }

  const promptAssembler = readText('apps/desktop/electron/main/prompt/prompt-assembler.mjs');
  if (!promptAssembler.includes('createProviderPromptSource')) {
    fail('Default System Context assembly must register runtime.provider for provider/model prompt selection.');
  }
  if (!promptAssembler.includes('createContextExtensionPromptSource')) {
    fail('Default System Context assembly must register runtime.contextExtensions for controlled Plugin/Skill/MCP context contributions.');
  }
  const providerSourcePath = 'apps/desktop/electron/main/prompt/sources/provider-source.mjs';
  if (!existsSync(path.join(repoRoot, providerSourcePath))) {
    fail(`Provider/model Context Source is missing: ${providerSourcePath}`);
  } else {
    const providerSource = readText(providerSourcePath);
    for (const forbidden of ['fetch(', 'request body', 'messages.create', 'chat/completions']) {
      if (providerSource.includes(forbidden)) {
        fail(`${providerSourcePath} must not own provider wire-format encoding (${forbidden}); keep that in provider encoders/adapters.`);
      }
    }
  }

  const extensionSourcePath = 'apps/desktop/electron/main/prompt/sources/context-extension-source.mjs';
  if (!existsSync(path.join(repoRoot, extensionSourcePath))) {
    fail(`Controlled context extension source is missing: ${extensionSourcePath}`);
  } else {
    const extensionSource = readText(extensionSourcePath);
    for (const snippet of ['ALLOWED_EXTENSION_LAYERS', 'does not grant local execution permission', 'Tool Result or Evidence']) {
      if (!extensionSource.includes(snippet)) {
        fail(`${extensionSourcePath} must keep Plugin/Skill/MCP context contributions bounded (${snippet}).`);
      }
    }
  }
}

function assertProviderAdaptersOwnProviderStreaming() {
  for (const filePath of [
    'apps/desktop/electron/main/provider-adapters/openai-chat-adapter.mjs',
    'apps/desktop/electron/main/provider-adapters/anthropic-messages-adapter.mjs',
  ]) {
    if (!existsSync(path.join(repoRoot, filePath))) {
      fail(`Provider streaming adapter is missing: ${filePath}`);
    }
  }

  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  for (const forbidden of [
    'function consumeOpenAIStream',
    'function consumeAnthropicStream',
    'function consumeOpenAIStreamLine',
    'function consumeAnthropicStreamLine',
  ]) {
    if (chatService.includes(forbidden)) {
      fail(`llm-chat-service.mjs must not own provider stream parser ${forbidden}; use provider-adapters/*.`);
    }
  }
}

function assertLocalFileProviderOwnsFileRuntime() {
  const fileProviderPath = 'apps/desktop/electron/main/runtime-gateway/local-file-provider.mjs';
  if (!existsSync(path.join(repoRoot, fileProviderPath))) {
    fail(`Local file Capability Provider is missing: ${fileProviderPath}`);
    return;
  }
  const fileProvider = readText(fileProviderPath);
  for (const capabilityId of ['local.file.read', 'local.file.edit', 'local.file.write']) {
    if (!fileProvider.includes(capabilityId)) {
      fail(`${fileProviderPath} must declare ${capabilityId}.`);
    }
  }

  const host = readText('apps/desktop/electron/main/runtime-gateway/local-tool-host.mjs');
  if (!host.includes('createLocalFileProvider')) {
    fail('local-tool-host.mjs must register createLocalFileProvider so file capabilities flow through Local Tool Host.');
  }

  const legacyProvider = readText('apps/desktop/electron/main/runtime-gateway/legacy-llm-local-tool-provider.mjs');
  for (const forbidden of [
    "from 'node:fs'",
    'from "node:fs"',
    "from 'node:path'",
    'from "node:path"',
    'readFileSync',
    'writeFileSync',
    'statSync',
    'mkdirSync',
  ]) {
    if (legacyProvider.includes(forbidden)) {
      fail(`legacy-llm-local-tool-provider.mjs must not own file runtime primitive ${forbidden}; delegate to local-file-provider.`);
    }
  }
  if (!legacyProvider.includes('createLocalFileProvider')) {
    fail('legacy-llm-local-tool-provider.mjs must delegate legacy file tools to createLocalFileProvider.');
  }
}

function assertLocalShellProviderOwnsShellRuntime() {
  const shellProviderPath = 'apps/desktop/electron/main/runtime-gateway/local-shell-provider.mjs';
  if (!existsSync(path.join(repoRoot, shellProviderPath))) {
    fail(`Local shell Capability Provider is missing: ${shellProviderPath}`);
    return;
  }
  const shellProvider = readText(shellProviderPath);
  for (const capabilityId of ['local.shell.exec', 'local.shell.stop']) {
    if (!shellProvider.includes(capabilityId)) {
      fail(`${shellProviderPath} must declare ${capabilityId}.`);
    }
  }

  const legacyProvider = readText('apps/desktop/electron/main/runtime-gateway/legacy-llm-local-tool-provider.mjs');
  for (const forbidden of [
    "from 'node:child_process'",
    'from "node:child_process"',
    'execSync',
    'spawnSync',
  ]) {
    if (legacyProvider.includes(forbidden)) {
      fail(`legacy-llm-local-tool-provider.mjs must not own shell runtime primitive ${forbidden}; delegate to local-shell-provider.`);
    }
  }
  if (!legacyProvider.includes('createLocalShellProvider')) {
    fail('legacy-llm-local-tool-provider.mjs must delegate legacy bash to createLocalShellProvider.');
  }
}

function assertToolSchemasMaterializeFromRuntimeProjection() {
  const projectionMaterializerPath = 'apps/desktop/electron/main/tools/runtime-projection-tool-materializer.mjs';
  if (!existsSync(path.join(repoRoot, projectionMaterializerPath))) {
    fail(`Runtime Projection tool materializer is missing: ${projectionMaterializerPath}`);
    return;
  }
  const projectionMaterializer = readText(projectionMaterializerPath);
  for (const snippet of [
    'createRuntimeProjectionFromToolRegistry',
    'buildOpenAIToolsFromRuntimeProjection',
    'buildAnthropicToolsFromRuntimeProjection',
  ]) {
    if (!projectionMaterializer.includes(snippet)) {
      fail(`${projectionMaterializerPath} is missing ${snippet}.`);
    }
  }

  const toolIndex = readText('apps/desktop/electron/main/tools/index.mjs');
  if (!toolIndex.includes('createRuntimeProjectionFromToolRegistry')) {
    fail('tools/index.mjs must create Runtime Projection before materializing provider tools.');
  }
  if (!toolIndex.includes('buildOpenAIToolsFromRuntimeProjection')) {
    fail('tools/index.mjs must materialize OpenAI tools from Runtime Projection.');
  }
  if (!toolIndex.includes('buildAnthropicToolsFromRuntimeProjection')) {
    fail('tools/index.mjs must materialize Anthropic tools from Runtime Projection.');
  }
}

function assertToolPromptsAreAssetBacked() {
  for (const filePath of [
    'apps/desktop/electron/main/tools/prompts/bash.txt',
    'apps/desktop/electron/main/tools/prompts/read_file.txt',
    'apps/desktop/electron/main/tools/prompts/edit_file.txt',
    'apps/desktop/electron/main/tools/prompts/write_file.txt',
  ]) {
    if (!existsSync(path.join(repoRoot, filePath))) {
      fail(`Tool prompt asset is missing: ${filePath}`);
    }
  }

  const legacyDefinitions = readText('apps/desktop/electron/main/tools/legacy-local-tool-definitions.mjs');
  for (const forbidden of [
    'function bashPrompt',
    'function readFilePrompt',
    'function editFilePrompt',
    'function writeFilePrompt',
    'bulletList',
    'joinPromptSections',
  ]) {
    if (legacyDefinitions.includes(forbidden)) {
      fail(`legacy-local-tool-definitions.mjs must not inline tool prompt text or rendering helpers (${forbidden}); use tools/prompts/*.txt.`);
    }
  }
  if (!legacyDefinitions.includes('readPromptAsset')) {
    fail('legacy-local-tool-definitions.mjs must load tool descriptions from tools/prompts/*.txt.');
  }
}

function assertChatRuntimePermissionGateIsModular() {
  const permissionGatePath = 'apps/desktop/electron/main/chat-runtime/permission-gate.mjs';
  if (!existsSync(path.join(repoRoot, permissionGatePath))) {
    fail(`Chat runtime Permission Gate module is missing: ${permissionGatePath}`);
    return;
  }
  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  for (const forbidden of [
    'pendingPermissionRequests',
    'approvedPermissionScopes',
    'function buildFilePermissionCall',
    'function buildShellPermissionCall',
  ]) {
    if (chatService.includes(forbidden)) {
      fail(`llm-chat-service.mjs must not own Permission Gate state or builders (${forbidden}); use chat-runtime/permission-gate.mjs.`);
    }
  }
  if (!chatService.includes('createChatPermissionGate')) {
    fail('llm-chat-service.mjs must compose chat-runtime/permission-gate.mjs for permission request handling.');
  }
}

function assertChatRuntimeToolOrchestratorIsModular() {
  const toolOrchestratorPath = 'apps/desktop/electron/main/chat-runtime/tool-orchestrator.mjs';
  if (!existsSync(path.join(repoRoot, toolOrchestratorPath))) {
    fail(`Chat runtime Tool Orchestrator module is missing: ${toolOrchestratorPath}`);
    return;
  }
  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  for (const forbidden of [
    'executeLegacyLlmLocalTool',
    'createShellArtifactStore',
    'function safeParseJson',
    'executeModelToolCall',
  ]) {
    if (chatService.includes(forbidden)) {
      fail(`llm-chat-service.mjs must not own Tool Orchestrator behavior (${forbidden}); use chat-runtime/tool-orchestrator.mjs.`);
    }
  }
  const agentLoopFiles = [
    'apps/desktop/electron/main/chat-runtime/openai-agent-loop.mjs',
    'apps/desktop/electron/main/chat-runtime/anthropic-agent-loop.mjs',
  ];
  for (const filePath of agentLoopFiles) {
    if (!existsSync(path.join(repoRoot, filePath))) continue;
    const content = readText(filePath);
    if (!content.includes('executeModelToolCall')) {
      fail(`${filePath} must delegate model tool execution to chat-runtime/tool-orchestrator.mjs.`);
    }
  }
}

function assertProjectedToolExecutionUsesRuntimeProjection() {
  const projectedExecutorPath = 'apps/desktop/electron/main/chat-runtime/projected-tool-executor.mjs';
  if (!existsSync(path.join(repoRoot, projectedExecutorPath))) {
    fail(`Projected tool executor is missing: ${projectedExecutorPath}`);
    return;
  }
  const projectedExecutor = readText(projectedExecutorPath);
  for (const snippet of [
    'DEFAULT_RUNTIME_PROJECTION',
    'DEFAULT_TOOL_REGISTRY',
    'createLocalToolHost',
    'resolveProjectedModelToolCall',
  ]) {
    if (!projectedExecutor.includes(snippet)) {
      fail(`${projectedExecutorPath} must route model tools through Runtime Projection and Local Tool Host (${snippet}).`);
    }
  }

  const toolOrchestrator = readText('apps/desktop/electron/main/chat-runtime/tool-orchestrator.mjs');
  if (toolOrchestrator.includes('executeLegacyLlmLocalTool')) {
    fail('tool-orchestrator.mjs must not call executeLegacyLlmLocalTool directly; use projected-tool-executor.mjs.');
  }
  if (toolOrchestrator.includes('export async function executeTool')) {
    fail('tool-orchestrator.mjs must not keep the legacy executeTool compatibility API; use executeProjectedModelTool or executeModelToolCall.');
  }
  if (!toolOrchestrator.includes('projected-tool-executor.mjs')) {
    fail('tool-orchestrator.mjs must delegate model-visible tool execution to projected-tool-executor.mjs.');
  }
  const executeModelToolCallBody = toolOrchestrator.match(/export async function executeModelToolCall[\s\S]*$/)?.[0] ?? '';
  if (executeModelToolCallBody.includes('executeTool(')) {
    fail('executeModelToolCall must call executeProjectedModelTool directly; executeTool has been removed.');
  }
  if (!executeModelToolCallBody.includes('executeProjectedModelTool')) {
    fail('executeModelToolCall must use executeProjectedModelTool for runtime model tool execution.');
  }

  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  if (chatService.includes('executeTool')) {
    fail('llm-chat-service.mjs must not re-export legacy executeTool; chat service does not own tool execution.');
  }
}

function assertChatRuntimeCompactionCoordinatorIsModular() {
  const compactionCoordinatorPath = 'apps/desktop/electron/main/chat-runtime/compaction-coordinator.mjs';
  if (!existsSync(path.join(repoRoot, compactionCoordinatorPath))) {
    fail(`Chat runtime Compaction Coordinator module is missing: ${compactionCoordinatorPath}`);
    return;
  }
  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  for (const forbidden of [
    'compactIfNeeded',
    'microcompactMessagesForContext',
    'estimateTokensFromMessages',
    'COMPACTION_CONFIG',
    'chat:compaction',
  ]) {
    if (chatService.includes(forbidden)) {
      fail(`llm-chat-service.mjs must not own Compaction Coordinator behavior (${forbidden}); use chat-runtime/compaction-coordinator.mjs.`);
    }
  }
  const agentLoopFiles = [
    'apps/desktop/electron/main/chat-runtime/openai-agent-loop.mjs',
    'apps/desktop/electron/main/chat-runtime/anthropic-agent-loop.mjs',
  ];
  for (const filePath of agentLoopFiles) {
    if (!existsSync(path.join(repoRoot, filePath))) continue;
    const content = readText(filePath);
    if (!content.includes('runCompactionCheck')) {
      fail(`${filePath} must delegate compaction checks to chat-runtime/compaction-coordinator.mjs.`);
    }
  }
}

function assertChatRuntimeResponseGuardIsModular() {
  const responseGuardPath = 'apps/desktop/electron/main/chat-runtime/response-guard.mjs';
  if (!existsSync(path.join(repoRoot, responseGuardPath))) {
    fail(`Chat runtime Response Guard module is missing: ${responseGuardPath}`);
    return;
  }
  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  for (const forbidden of [
    'UNSUPPORTED_TOOL_CLAIM_PATTERNS',
    'DANGLING_TOOL_INTENT_PATTERNS',
    'function unsupportedToolResponseCorrection',
    'function emptyModelResponseError',
  ]) {
    if (chatService.includes(forbidden)) {
      fail(`llm-chat-service.mjs must not own Response Guard behavior (${forbidden}); use chat-runtime/response-guard.mjs.`);
    }
  }
  if (!chatService.includes('response-guard.mjs')) {
    fail('llm-chat-service.mjs must compose chat-runtime/response-guard.mjs for model response guarding.');
  }
}

function assertPromptBaselineIsRecorded() {
  const snapshotStorePath = 'apps/desktop/electron/main/prompt/prompt-snapshot-store.mjs';
  if (!existsSync(path.join(repoRoot, snapshotStorePath))) {
    fail(`Prompt snapshot store is missing: ${snapshotStorePath}`);
    return;
  }
  const snapshotStore = readText(snapshotStorePath);
  for (const snippet of [
    'recordBaseline',
    'listBaselines',
    'getLatestBaseline',
    'listContextEpochs',
    'getLatestContextEpoch',
    'listContextEpochEvents',
    'getContextEpochChain',
    'latest-baselines.json',
    'context-epochs.jsonl',
    'latest-context-epochs.json',
    'context-epoch-events.jsonl',
    'epoch_created',
    'epoch_replaced',
    'snapshot_anchored',
  ]) {
    if (!snapshotStore.includes(snippet)) {
      fail(`${snapshotStorePath} must maintain lightweight Context Baseline records (${snippet}).`);
    }
  }

  const baselineRecorderPath = 'apps/desktop/electron/main/prompt/context-baseline-recorder.mjs';
  if (!existsSync(path.join(repoRoot, baselineRecorderPath))) {
    fail(`Context baseline recorder is missing: ${baselineRecorderPath}`);
  } else {
    const baselineRecorder = readText(baselineRecorderPath);
    for (const snippet of ['recordProviderBaseline', 'recordConfiguredInstructionsBaseline', 'buildSystemContext', 'recordBaseline']) {
      if (!baselineRecorder.includes(snippet)) {
        fail(`${baselineRecorderPath} must record provider/instruction context changes as System Context baselines (${snippet}).`);
      }
    }
  }

  const main = readText('apps/desktop/electron/main/main.mjs');
  if (!main.includes('recordBaseline')) {
    fail('manual chat:compact must record a prompt baseline after successful compaction.');
  }
  if (!main.includes('createContextBaselineRecorder') || !main.includes("'model_switch'")) {
    fail('LLM provider default/model changes must record a Context Baseline through context-baseline-recorder.');
  }
  if (!main.includes("'instruction_change'") || !main.includes('systemInstructions')) {
    fail('Configured instruction changes must record an instruction_change Context Baseline.');
  }
  if (!main.includes('getActiveContextEpochId')) {
    fail('Manual compaction prompt snapshots must be anchored to the active Context Epoch.');
  }
  if (
    !main.includes('prompt-context-epochs:list')
    || !main.includes('prompt-context-epochs:events')
    || !main.includes('prompt-context-epochs:chain')
  ) {
    fail('Durable Context Epoch ledger must be queryable through typed IPC handlers.');
  }
  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  if (!chatService.includes('getActiveContextEpochId') || !chatService.includes('contextEpochId')) {
    fail('Chat prompt snapshots must be anchored to the active Context Epoch so retries reuse the same baseline.');
  }

  const preloadContract = readText('apps/desktop/renderer/src/preload/contracts/bootstrapPreloadApi.ts');
  for (const snippet of ['PromptContextEpochEventRecord', 'promptContextEpochEvents', 'promptContextEpochChain']) {
    if (!preloadContract.includes(snippet)) {
      fail(`Renderer preload contract must expose Context Epoch ledger query API (${snippet}).`);
    }
  }
}

function assertChatRuntimeAgentLoopsAreModular() {
  const loopPaths = [
    'apps/desktop/electron/main/chat-runtime/openai-agent-loop.mjs',
    'apps/desktop/electron/main/chat-runtime/anthropic-agent-loop.mjs',
  ];
  for (const loopPath of loopPaths) {
    if (!existsSync(path.join(repoRoot, loopPath))) {
      fail(`Chat runtime Agent Loop module is missing: ${loopPath}`);
    }
  }

  const chatService = readText('apps/desktop/electron/main/llm-chat-service.mjs');
  for (const forbidden of [
    'async function agentLoopOpenAI',
    'async function agentLoopAnthropic',
    'sendOpenAIChatStream',
    'sendAnthropicMessagesStream',
    'runCompactionCheck',
  ]) {
    if (chatService.includes(forbidden)) {
      fail(`llm-chat-service.mjs must not own provider Agent Loop behavior (${forbidden}); use chat-runtime/*-agent-loop.mjs.`);
    }
  }
  if (!chatService.includes('agentLoopOpenAI') || !chatService.includes('agentLoopAnthropic')) {
    fail('llm-chat-service.mjs must compose provider Agent Loop modules instead of owning provider loops.');
  }

  const loopKernelPath = 'apps/desktop/electron/main/chat-runtime/agent-loop-kernel.mjs';
  const loopKernel = readText(loopKernelPath);
  if (!loopKernel.includes('handleTerminalTextResponse')) {
    fail(`${loopKernelPath} must own provider-neutral terminal text response transitions.`);
  }

  if (existsSync(path.join(repoRoot, loopPaths[0]))) {
    const openaiLoop = readText(loopPaths[0]);
    for (const snippet of ['sendOpenAIChatStream', 'runCompactionCheck', 'executeModelToolCall', 'createAgentLoopKernel', 'handleTerminalTextResponse']) {
      if (!openaiLoop.includes(snippet)) {
        fail(`${loopPaths[0]} is missing required provider loop dependency ${snippet}.`);
      }
    }
    if (
      openaiLoop.includes('unsupportedToolClaimRetries')
      || openaiLoop.includes('inputTokens: 0')
      || openaiLoop.includes('claimUnsupportedToolRetry')
      || openaiLoop.includes('emptyModelResponseError(')
    ) {
      fail(`${loopPaths[0]} must use chat-runtime/agent-loop-kernel.mjs for shared loop usage/retry state.`);
    }
  }
  if (existsSync(path.join(repoRoot, loopPaths[1]))) {
    const anthropicLoop = readText(loopPaths[1]);
    for (const snippet of ['sendAnthropicMessagesStream', 'runCompactionCheck', 'executeModelToolCall', 'createAgentLoopKernel', 'handleTerminalTextResponse']) {
      if (!anthropicLoop.includes(snippet)) {
        fail(`${loopPaths[1]} is missing required provider loop dependency ${snippet}.`);
      }
    }
    if (
      anthropicLoop.includes('unsupportedToolClaimRetries')
      || anthropicLoop.includes('inputTokens: 0')
      || anthropicLoop.includes('claimUnsupportedToolRetry')
      || anthropicLoop.includes('emptyModelResponseError(')
    ) {
      fail(`${loopPaths[1]} must use chat-runtime/agent-loop-kernel.mjs for shared loop usage/retry state.`);
    }
  }
}

function assertOverlayMotionAdmission() {
  // 设计语言：14-product-design-language.md §11.3「弹出层动效准入」。
  // 所有模态浮层必须经由统一基座 Overlay 挂载，从而默认获得 backdrop 淡入 +
  // 面板入场动效，避免每处手写 backdrop 而漏掉过渡（治理 "为什么每次都要提醒"）。
  const overlayComponent = 'apps/desktop/renderer/src/app/components/Overlay.tsx';
  const overlayStyles = 'apps/desktop/renderer/src/styles/overlay.css';
  if (!existsSync(path.join(repoRoot, overlayComponent))) {
    fail(`Overlay modal base is missing: ${overlayComponent}`);
    return;
  }
  if (!existsSync(path.join(repoRoot, overlayStyles))) {
    fail(`Overlay base styles are missing: ${overlayStyles}`);
  } else {
    const css = readText(overlayStyles);
    for (const token of ['.pa-overlay-backdrop', '.pa-overlay-panel', 'za-panel-in']) {
      if (!css.includes(token)) {
        fail(`${overlayStyles} must define ${token} so overlays inherit unified motion.`);
      }
    }
  }

  // overlay.css 必须经由 styles.css 注册，否则基座动效不会生效。
  const stylesEntry = readText('apps/desktop/renderer/src/styles.css');
  if (!stylesEntry.includes('styles/overlay.css')) {
    fail('apps/desktop/renderer/src/styles.css must @import "./styles/overlay.css" to register the overlay base.');
  }

  // 文档准入锚点必须存在。
  const designDoc = readText('docs/architecture/14-product-design-language.md');
  if (!designDoc.includes('弹出层动效准入')) {
    fail('docs/architecture/14-product-design-language.md §11.3 must document the 弹出层动效准入 rule.');
  }

  // 防漏核心：renderer 中任何声明 aria-modal="true" 的模态，都必须经由 Overlay 基座。
  const overlayAbsolute = path.join(repoRoot, overlayComponent);
  const componentFiles = collectFiles('apps/desktop/renderer/src', ['.tsx']);
  for (const filePath of componentFiles) {
    if (filePath === overlayAbsolute) continue;
    const content = readFileSync(filePath, 'utf8');
    const declaresModal = content.includes('aria-modal="true"') || content.includes("aria-modal='true'");
    if (!declaresModal) continue;
    const usesOverlay = /from ['"]\.+\/(?:.*\/)?Overlay['"]/.test(content) || content.includes('<Overlay');
    if (!usesOverlay) {
      fail(`${relative(filePath)} declares a modal (aria-modal) but does not mount via the Overlay base. Route it through components/Overlay.tsx so it inherits §11.3 弹出层动效准入.`);
    }
  }
}

assertAgentRules();
assertArchitectureDocsStayLocal();
assertOverlayMotionAdmission();
assertRendererHasNoHighPrivilegeImports();
assertNoStreamReplaceChannel();
assertSystemContextProtocolContracts();
assertProviderAdaptersOwnProviderStreaming();
assertLocalFileProviderOwnsFileRuntime();
assertLocalShellProviderOwnsShellRuntime();
assertToolSchemasMaterializeFromRuntimeProjection();
assertToolPromptsAreAssetBacked();
assertChatRuntimePermissionGateIsModular();
assertChatRuntimeToolOrchestratorIsModular();
assertProjectedToolExecutionUsesRuntimeProjection();
assertChatRuntimeCompactionCoordinatorIsModular();
assertChatRuntimeResponseGuardIsModular();
assertPromptBaselineIsRecorded();
assertChatRuntimeAgentLoopsAreModular();

if (failures.length > 0) {
  console.error('Architecture governance check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Architecture governance check passed.');
