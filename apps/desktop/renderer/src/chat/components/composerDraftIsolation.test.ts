import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('draft input stays in the composer leaf and never becomes context token authority', async () => {
  const [surface, controls, tokenUsage, attachmentStrip] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('./ComposerDraftControls.tsx'),
    readSource('./ComposerTokenUsageDisplay.tsx'),
    readSource('./thread/AttachmentStrip.tsx'),
  ]);

  assert.match(surface, /<ComposerDraftControls[\s\S]*?conversationId=\{conversationId\}/);
  assert.match(surface, /onPrimaryAction=\{stableHandlePrimaryAction\}/);
  assert.doesNotMatch(surface, /estimateDraftTokens|estimateStreamDeltaTokens/);
  // 壳层不订阅 draft；唯一订阅点在 ComposerDraftField 叶子，避免附件条随逐字重渲。
  assert.match(controls, /const ComposerDraftField = memo\(function ComposerDraftField/);
  assert.match(controls, /const draft = useConversationDraft\(conversationId\)/);
  assert.match(controls, /conversationStore\.setDraft\(conversationId, value\)/);
  assert.match(controls, /attachmentSlot/);
  // 附件条必须是壳层兄弟节点，不能再作为 ComposerDraftField 的子树。
  assert.match(controls, /\{attachmentSlot\}\s*<ComposerDraftField/);
  assert.doesNotMatch(
    controls.split('const ComposerDraftField')[1] ?? '',
    /attachmentSlot/,
    'ComposerDraftField leaf must not receive or render attachmentSlot',
  );
  assert.equal(
    (controls.match(/useConversationDraft/g) ?? []).length,
    2,
    'useConversationDraft should appear only as import + one leaf subscription',
  );
  // 附件条必须 memo，并使用小缩略图缓存，避免 2MB 原图 dataUrl 随输入闪刷。
  assert.match(attachmentStrip, /export const AttachmentStrip = memo\(function AttachmentStrip/);
  assert.match(attachmentStrip, /attachmentThumbCache|AttachmentThumb|downscaleDataUrl/);
  assert.match(tokenUsage, /useConversationContextAccounting\(conversationId\)/);
  assert.match(tokenUsage, /contextAccounting=\{contextAccounting\}/);
  assert.match(tokenUsage, /emptyContext=\{conversationId == null\}/);
  assert.doesNotMatch(tokenUsage, /useConversationDraft|estimateDraftTokens|estimateStreamDeltaTokens/);
});

test('composer auto-sizing stays in CSS and does not force layout on every draft character', async () => {
  const [controls, styles] = await Promise.all([
    readSource('./ComposerDraftControls.tsx'),
    readSource('../styles/chat-composer.css'),
  ]);

  assert.doesNotMatch(controls, /scrollHeight|style\.height|textareaResizeCoalescer/);
  assert.match(styles, /field-sizing:\s*content/);
  assert.match(styles, /\.cloud-chat-composer\.thread textarea\s*\{[\s\S]*?min-height:\s*40px[\s\S]*?max-height:\s*200px/);
});

test('send actions read the latest draft from the conversation bucket', async () => {
  const surface = await readSource('./ChatSurface.tsx');

  assert.match(
    surface,
    /const text = conversationStore\.getSnapshot\(conversationId\)\.draft\.trim\(\)/,
  );
  assert.match(surface, /conversationStore\.setDraft\(conversationId, ''\)/);
  assert.doesNotMatch(surface, /\}, \[draft, attachments,/);
});

test('context ring renders the shared accounting snapshot without a local fallback', async () => {
  const display = await readSource('./thread/TokenUsageDisplay.tsx');

  assert.match(
    display,
    /contextAccounting\?\.authoritativeInputTokens/,
  );
  assert.match(display, /contextAccounting\?\.percent/);
  assert.match(display, /contextAccounting\?\.usageBreakdown/);
  assert.match(display, /contextAccounting\?\.counterStatus === 'degraded'/);
  assert.match(display, /Exact count drifted from provider usage/);
  assert.match(display, /<ContextUsagePanel/);
  assert.doesNotMatch(display, /包含尚未计量的草稿|Includes uncounted draft/);
  assert.doesNotMatch(display, /contextPending\s*\?\s*'\+'\s*:/);
  assert.doesNotMatch(display, /lifetimeUsage|resolveContextOccupancyTokens|estimateDraftTokens/);
  assert.doesNotMatch(display, /contextTokens \?\? billedTokens/);
  assert.doesNotMatch(display, /composeContextUsageBreakdown|estimateContextTextTokens/);
});

test('send path does not seed or estimate context occupancy', async () => {
  const surface = await readSource('./ChatSurface.tsx');

  assert.doesNotMatch(surface, /seedAuthoritativeContextOnSend|seedContextAccountingOnSend/);
  assert.doesNotMatch(surface, /estimateDraftTokens\(text, sentAttachments\)/);
  assert.doesNotMatch(surface, /contextReady=/);
});

test('new task starts in main and stays on the first-run chat path', async () => {
  const [surface, app] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('../../App.tsx'),
  ]);

  assert.match(surface, /await clientApi\.chatStartTask\(\{[\s\S]*text,[\s\S]*attachments: sentAttachments/);
  assert.match(surface, /onTaskStarted\?\.\(started\.conversationId\)/);
  assert.match(app, /onTaskStarted=\{\(conversationId\) => \{[\s\S]*setActivePage\('chat'\)/);
  assert.match(surface, /chat-empty-primary-btn/);
  assert.match(surface, /连接 AI 服务/);
  assert.doesNotMatch(surface, /FirstRunSetupPanel|first-run-setup/);
  assert.doesNotMatch(app, /Gate A[\s\S]*openSettings\('providers'\)/);
  assert.doesNotMatch(surface, /pendingFirstSendRef|onInitialMessageSubmitted|onEnsureConversation/);
  assert.doesNotMatch(app, /const ensureConversation/);
});

test('Fast mode is a ChatGPT/Grok subscription composer control and follows both send paths', async () => {
  const [surface, display, composer, settings] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('./thread/TokenUsageDisplay.tsx'),
    readSource('./thread/TokenUsageDisplay.tsx'),
    readSource('../../app/components/LlmSettingsPanel.tsx'),
  ]);

  assert.match(display, /defaultProvider\?\.authMethod === 'oauth_chatgpt' \|\| defaultProvider\?\.authMethod === 'oauth_grok'/);
  assert.match(composer, /isZh \? '快速' : 'Fast'/);
  assert.match(composer, /aria-pressed=\{fastMode\}/);
  assert.match(surface, /chatStartTask\(\{[\s\S]*fastMode/);
  assert.match(surface, /chatSend\(\{[^}]*fastMode/);
  assert.match(surface, /persistDraftComposer\(\{ fastMode: enabled \}\)/);
  assert.match(surface, /loadComposerEntry\(composerId\)[\s\S]*fastMode: persisted\?\.fastMode === true/);
  assert.doesNotMatch(settings, /fastMode|Fast mode|快速模式/);
});

test('sending a new task clears shared draft text while keeping isolation preference', async () => {
  const surface = await readSource('./ChatSurface.tsx');
  assert.match(surface, /persistDraftComposer\(\{ draft: '', queue: \[\] \}\)/);
  assert.match(surface, /persistDraftComposer\(\{ draft: text, queue: \[\] \}\)/);
  assert.match(surface, /draft: patch\.draft \?\? draftComposer\.draft/);
  assert.match(surface, /queue: \[\.\.\.\(patch\.queue \?\? draftComposer\.messageQueue\)\]/);
});

test('new tasks can opt into worktree isolation from the draft composer', async () => {
  const [surface, main, service, panel] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('../../../../electron/main/main.mjs'),
    readSource('../../../../electron/main/llm-chat-service.mjs'),
    readSource('./GoalPlanPanel.tsx'),
  ]);

  assert.match(surface, /composer-worktree-toggle/);
  assert.match(surface, /isZh \? '隔离执行' : 'Worktree'/);
  assert.match(surface, /preferredExecutionIsolation: preferredWorktree && workspaceIsGit !== false \? 'worktree' : 'none'/);
  assert.match(surface, /\{workspacePath \? \(/);
  assert.match(surface, /conversationsUpdatePreferredExecutionIsolation/);
  assert.match(surface, /下次任务是否在独立 Worktree 里执行/);
  assert.match(main, /preferredExecutionIsolation = 'none'/);
  assert.match(main, /preferredExecutionIsolation,/);
  assert.match(main, /originWorkspacePath: conversationWorkspacePath,\s*targetWorkspacePath: conversationWorkspacePath/);
  assert.match(main, /preparePlanExecutionWorkspace/);
  assert.match(service, /preparePlanExecutionWorkspace/);
  assert.match(panel, /goalPlansIsolate/);
  assert.match(surface, /planComposerGitChrome/);
  assert.match(surface, /composer-workspace-head/);
  assert.match(surface, /composer-task-line/);
  assert.match(surface, /GitWorktreeGlyph/);
  assert.match(surface, /composer-write-mismatch/);
  assert.match(surface, /composer-bound-branch/);
  assert.match(surface, /canSelectComposerSourceBranch/);
  assert.match(surface, /buildComposerBranchOptions/);
  assert.match(surface, /workspaceUpdate\(\{ path: workspacePath, baseBranch: next \}\)/);
  assert.match(surface, /searchable/);
  assert.match(surface, /gitCreateBranch/);
  assert.match(surface, /本地分支/);
  assert.match(surface, /远程分支/);
  assert.doesNotMatch(surface, /gitCheckout|git checkout/);
  assert.match(surface, /onActiveDeliveryChange=\{handleActiveDeliveryChange\}/);
  assert.match(panel, /onActiveDeliveryChange/);
  assert.doesNotMatch(surface, /executionIsolation:\s*'worktree'/);
});

test('external conversation reload replaces or clears the shared accounting snapshot', async () => {
  const surface = await readSource('./ChatSurface.tsx');

  assert.match(
    surface,
    /loadConversationMessages\(conversationId\)\.then\(\(\{[\s\S]*contextAccounting: storedContextAccountingSnapshot/,
  );
  assert.match(
    surface,
    /convActions\.commitLoad\(\{[\s\S]*contextAccounting: storedContextAccountingSnapshot/,
  );
});

test('unknown restored context renders as unknown, never zero percent', async () => {
  const [display, panel] = await Promise.all([
    readSource('./thread/TokenUsageDisplay.tsx'),
    readSource('./thread/ContextUsagePanel.tsx'),
  ]);

  assert.match(display, /resolveStickyContextDisplay/);
  assert.match(display, /lastKnown/);
  assert.match(display, /const liveCtxPercent =[\s\S]*contextAccounting\?\.percent/);
  assert.match(display, /const ctxPercent = stickyDisplay\.percent/);
  assert.match(display, /Context pending measurement/);
  assert.match(display, /emptyContext && contextAccounting == null/);
  assert.match(panel, /percent == null \? '\?' : `\$\{Math\.round\(percent\)\}%`/);
});
