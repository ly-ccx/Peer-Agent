import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const chatSurface = readFileSync(new URL('../chat/components/ChatSurface.tsx', import.meta.url), 'utf8');
const chatHeader = readFileSync(new URL('../chat/components/thread/ChatHeader.tsx', import.meta.url), 'utf8');
const workbenchPanel = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const workbenchState = readFileSync(new URL('./workbenchTabState.ts', import.meta.url), 'utf8');
const chatStyles = readFileSync(new URL('../chat/styles/chat-surface.css', import.meta.url), 'utf8');
const monitorView = readFileSync(new URL('./views/TaskMonitorRailView.tsx', import.meta.url), 'utf8');
const workbenchStyles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');

function assertIndependentControls(): void {
  assert.match(chatSurface, /const \[taskMonitorOpen, setTaskMonitorOpen\] = useState\(false\)/);
  assert.match(chatSurface, /\{taskMonitorPresent \? \([\s\S]*?<TaskMonitorRailView/);
  assert.match(chatHeader, /onToggleTaskMonitor/);
  assert.match(chatHeader, /<WorkbenchToggle isZh=\{isZh\}/);
  assert.doesNotMatch(chatHeader, /onToggleTaskMonitor[\s\S]{0,220}setOpen|setActiveTab/);
  assert.doesNotMatch(workbenchPanel, /TaskMonitorRailView|workbench-view--monitor|id:\s*'monitor'/);
  assert.doesNotMatch(workbenchState, /'monitor'\s*\|/);
}

// 卡片宿主：挂载在 .chat-surface 内部，靠 padding-right 让位；单卡+内部分区形态。
test('监控卡片挂载在 chat-surface 内为单卡分区，正文让位且头部不被挤压', () => {
  assert.match(chatSurface, /className=\{`chat-surface\$\{showEmptyHome[^}]*\}\$\{taskMonitorOpen \? ' chat-surface--with-monitor' : ''\}`\}/);
  assert.match(chatSurface, /<TaskMonitorRailView[\s\S]{0,1600}onClose=\{\(\) => setTaskMonitorOpen\(false\)\}/);
  // 卡片渲染在 .chat-surface 的 JSX 子树内（同层还有 ChatFindBar/overlays，但不在 chat-workspace 直挂）。
  assert.doesNotMatch(chatSurface, /chat-workspace">\s*<TaskMonitorRailView/);
  // 头部是 absolute 且整行（left:0;right:0），padding-right 只作用于 in-flow 正文列。
  assert.match(chatStyles, /\.chat-surface--with-monitor \{\s*--task-monitor-card: clamp\(280px, 24%, 340px\);/);
  assert.match(chatStyles, /padding-right: calc\(var\(--task-monitor-card\) \+ var\(--space-3\) \* 2\);/);
  // 裸内容形态：监控区无背景色、无边框、无圆角、无阴影（不是一块完整卡片）。
  assert.match(workbenchStyles, /\.task-monitor-rail \{[\s\S]*?position: absolute;/);
  assert.match(workbenchStyles, /\.task-monitor-rail \{[\s\S]*?top: calc\(40px \+ var\(--space-2\)\);/);
  // .task-monitor-card 不得再携带面样式（背景/边框/圆角/阴影全部移除）。
  const cardBlock = workbenchStyles.match(/\.task-monitor-card \{[\s\S]*?\}/)?.[0] ?? '';
  assert.match(cardBlock, /background:/);
  assert.match(cardBlock, /border: 1px solid/);
  assert.match(cardBlock, /box-shadow:/);
  assert.match(cardBlock, /flex: 0 1 auto/);
  assert.match(chatStyles, /\.chat-surface--with-monitor > \.message-rail\s*\{\s*right: calc\(var\(--task-monitor-card\)/);
  // 置顶条跟消息列同宽居中；宽窗给侧栏让位，窄窗浮层不改变消息列。
  // 只检查独立规则，禁止跨越后续选择器误匹配，也不能匹配 selection-child-banner 的后代规则。
  const pinnedRule = chatStyles.match(/^\.current-turn-context \{([^}]*)\}/m)?.[1] ?? '';
  assert.match(pinnedRule, /max-width: min\(100%, var\(--chat-content-max\)\);/);
  assert.match(pinnedRule, /margin-inline: auto;/);
  assert.match(pinnedRule, /left: var\(--space-6\);/);
  assert.match(pinnedRule, /right: var\(--space-6\);/);
  assert.match(pinnedRule, /width: auto;/);
  assert.match(chatStyles, /\.chat-surface--with-monitor > \.current-turn-context \{\s*right: calc\(var\(--task-monitor-card\) \+ var\(--space-3\) \* 2 \+ var\(--space-6\)\);/);
  assert.match(chatStyles, /@container conversation-space \(max-width: 640px\) \{[\s\S]*?\.chat-surface--with-monitor > \.current-turn-context \{\s*right: var\(--space-6\);/);
  const narrowRules = chatStyles.slice(chatStyles.indexOf('@container conversation-space (max-width: 640px)')).split('/* batch_search')[0];
  const narrowSurface = narrowRules.match(/\.chat-surface--with-monitor \{([^}]*)\}/)?.[1] ?? '';
  const narrowPinned = narrowRules.match(/\.chat-surface--with-monitor > \.current-turn-context \{([^}]*)\}/)?.[1] ?? '';
  const narrowRail = narrowRules.match(/\.chat-surface--with-monitor > \.message-rail \{([^}]*)\}/)?.[1] ?? '';
  assert.match(narrowSurface, /padding-right: 0;/);
  assert.doesNotMatch(narrowRules, /padding-top:|\.chat-thread|\.chat-composer/);
  assert.doesNotMatch(narrowPinned, /top:|margin/);
  assert.doesNotMatch(narrowRail, /top:/);
  assert.match(narrowRail, /right: var\(--space-2\);/);
  const floatingCard = narrowRules.match(/\.chat-surface--with-monitor > \.task-monitor-rail \{([^}]*)\}/)?.[1] ?? '';
  assert.match(floatingCard, /z-index: 31;/); // 高于置顶条，而不是把置顶条下推。
  assert.match(floatingCard, /width: auto;/);
  assert.match(floatingCard, /animation: none;/); // Ancestor must not isolate backdrop sampling.
  assert.match(narrowRules, /\.motion-enter-slide-inline > \.task-monitor-card \{\s*animation: motion-enter-slide-inline[^;]*backwards;/);
  assert.match(narrowRules, /\.motion-exit-slide-inline > \.task-monitor-card \{\s*animation: motion-exit-slide-inline/);
  assert.match(narrowRules, /backdrop-filter: blur\(var\(--blur-popover\)\) saturate\(var\(--blur-saturate\)\)/);
  assert.match(monitorView, /className="task-monitor-card" onAnimationEnd=/);
  // 分区：留白 + 28% 透明度细分隔线；行静止时无背景，hover 才有极轻底色。
  assert.match(workbenchStyles, /\.task-monitor-section \+ \.task-monitor-section \{[\s\S]*?border-top: 1px solid color-mix\(in srgb, var\(--za-line[^)]*\) 28%, transparent\)/);
  assert.match(workbenchStyles, /\.task-monitor-row--action:hover \{[\s\S]*?color-mix\(in srgb, var\(--za-line[^)]*\) 32%, transparent\)/);
  assert.doesNotMatch(workbenchStyles, /\.task-monitor-section \{[\s\S]{0,320}backdrop-filter/);
  assert.doesNotMatch(workbenchStyles, /task-monitor-tiles|task-monitor-section--tile/);
  // 分区数据源：技能与 MCP + 网页查阅 + 环境四行 + 查看更多。
  assert.match(monitorView, /来源与工具/);
  assert.match(monitorView, /projectMonitorSources\(messages/);
  assert.match(monitorView, /workbench\?\.conversationId === conversationId/);
  assert.doesNotMatch(monitorView, /listSkills\(|listCapabilities\(|mcpListCapabilities\(/);
  assert.match(monitorView, /browserSession\.tabs/);
  assert.match(monitorView, /查看更多 \(\$\{total - limit\}\)/);
  assert.doesNotMatch(monitorView, /setActiveTab\('documents'\)/);
  assert.match(monitorView, /aria-label=\{isZh \? '任务监控卡片' : 'Task monitor card'\}/);
});

// 轴：监控卡片开关 × 独立 Workbench 开关（四格共用同一结构证据，真机逐格点击验证 DOM）。
for (const cell of [
  { monitor: false, workbench: false, name: '监控关 × Workbench关：仅会话正文' },
  { monitor: true, workbench: false, name: '监控开 × Workbench关：卡片占位，正文左移，头部不变' },
  { monitor: false, workbench: true, name: '监控关 × Workbench开：仅独立工作区' },
  { monitor: true, workbench: true, name: '监控开 × Workbench开：并存钳制互不替换' },
] as const) {
  test(cell.name, () => {
    assertIndependentControls();
    assert.equal(Boolean(cell.monitor), cell.monitor);
    assert.equal(Boolean(cell.workbench), cell.workbench);
  });
}

// 并存钳制：选择器匹配 .chat-surface 内的卡片，为卡片保留 372px、正文 360px。
test('并存宽度钳制按卡片宿主选择且不改持久化宽度', () => {
  assert.match(workbenchStyles, /:has\(\.chat-surface > \.task-monitor-rail\)/);
  assert.match(workbenchStyles, /calc\(100vw[\s\S]{0,140}- 372px - 360px\)/);
});

test('输入框只留环境状态，源头和 Worktree 控制集中在监控栏', () => {
  assert.match(chatSurface, /composer-env-status/);
  assert.doesNotMatch(chatSurface, /composer-env-capsule-dropdown/);
  assert.match(monitorView, /projectTaskMonitorEnvironment/);
  assert.match(monitorView, /环境信息/);
  assert.match(monitorView, /当前工作区/);
  assert.match(monitorView, /任务源头/);
  assert.match(monitorView, /task-monitor-env-dropdown/);
});

test('切会话或新建任务时收起任务监控，避免把上一会话的开栏带到空草稿', () => {
  assert.match(
    chatSurface,
    /useEffect\(\(\) => \{\s*setTaskMonitorOpen\(false\);\s*setTaskMonitorPresent\(false\);\s*\}, \[conversationId\]\);/,
  );
});

test('卡片开关与挂载分离，关闭后播退场再卸载，快速重开换新节点', () => {
  assert.match(chatSurface, /const \[taskMonitorPresent, setTaskMonitorPresent\] = useState\(false\)/);
  assert.match(chatSurface, /setTaskMonitorEpoch\(\(epoch\) => epoch \+ 1\);\s*setTaskMonitorPresent\(true\);\s*setTaskMonitorOpen\(true\)/);
  assert.match(chatSurface, /key=\{taskMonitorEpoch\}/);
  assert.match(chatSurface, /visible=\{taskMonitorOpen\}/);
  assert.match(chatSurface, /onExitComplete=\{\(\) => setTaskMonitorPresent\(false\)\}/);
  assert.match(monitorView, /if \(!visible\) \{\s*if \(prefersReducedMotion\(\)\) onExitComplete\(\);\s*else startExit\(\)/);
  assert.match(monitorView, /event\.target === event\.currentTarget && event\.animationName === 'motion-exit-slide-inline'/);
});

test('横向进入/退出动效复用通用基元，减少动态效果时立即完成退场', () => {
  const motionStyles = readFileSync(new URL('../styles/motion.css', import.meta.url), 'utf8');
  assert.match(monitorView, /exiting \? 'motion-exit-slide-inline' : 'motion-enter-slide-inline'/);
  assert.match(workbenchStyles, /\.task-monitor-rail\.motion-exit-slide-inline \{\s*pointer-events: none;/);
  assert.doesNotMatch(workbenchStyles, /task-monitor-card-in/);
  assert.match(motionStyles, /\.motion-enter-slide-inline \{\s*animation: motion-enter-slide-inline/);
  assert.match(motionStyles, /\.motion-exit-slide-inline \{\s*animation: motion-exit-slide-inline/);
  assert.match(monitorView, /if \(prefersReducedMotion\(\)\) onExitComplete\(\)/);
});

test('监控栏分行投影当前工作区 HEAD 与任务源头', () => {
  assert.match(chatSurface, /currentHead=\{workspaceGit\?\.ok \? workspaceGit\.current : null\}/);
  assert.match(chatSurface, /sourceBranch=\{gitChrome\.taskLine\?\.value \?\? null\}/);
  assert.doesNotMatch(
    chatSurface,
    /branch=\{gitChrome\.taskLine\?\.value \?\? \(workspaceGit\?\.ok \? workspaceGit\.current : null\)\}/,
  );
});
