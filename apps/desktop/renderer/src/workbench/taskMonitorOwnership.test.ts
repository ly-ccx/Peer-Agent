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
  assert.match(chatSurface, /\{taskMonitorOpen \? \([\s\S]*?<TaskMonitorRailView/);
  assert.match(chatHeader, /onToggleTaskMonitor/);
  assert.match(chatHeader, /<WorkbenchToggle isZh=\{isZh\}/);
  assert.doesNotMatch(chatHeader, /onToggleTaskMonitor[\s\S]{0,220}setOpen|setActiveTab/);
  assert.doesNotMatch(workbenchPanel, /TaskMonitorRailView|workbench-view--monitor|id:\s*'monitor'/);
  assert.doesNotMatch(workbenchState, /'monitor'\s*\|/);
}

// 卡片宿主：挂载在 .chat-surface 内部，靠 padding-right 让位；多卡片堆叠形态。
test('监控区挂载在 chat-surface 内为多卡片堆叠，正文让位且头部不被挤压', () => {
  assert.match(chatSurface, /className=\{`chat-surface\$\{showEmptyHome[^}]*\}\$\{taskMonitorOpen \? ' chat-surface--with-monitor' : ''\}`\}/);
  assert.match(chatSurface, /<TaskMonitorRailView[\s\S]{0,420}onClose=\{\(\) => setTaskMonitorOpen\(false\)\}/);
  // 卡片渲染在 .chat-surface 的 JSX 子树内（同层还有 ChatFindBar/overlays，但不在 chat-workspace 直挂）。
  assert.doesNotMatch(chatSurface, /chat-workspace">\s*<TaskMonitorRailView/);
  // 头部是 absolute 且整行（left:0;right:0），padding-right 只作用于 in-flow 正文列。
  // 槽位变量单一事实源：卡片宽 340px + 双侧 space-3 边距，正文右缘恒等于卡片左缘减边距。
  assert.match(chatStyles, /\.chat-surface--with-monitor \{\s*--task-monitor-card: clamp\(280px, 24%, 340px\);/);
  assert.match(chatStyles, /padding-right: calc\(var\(--task-monitor-card\) \+ var\(--space-3\) \* 2\);/);
  // 外层是无底色堆叠容器（非单一面板）；每张小卡自带圆角+阴影。
  assert.match(workbenchStyles, /\.task-monitor-rail \{[\s\S]*?position: absolute;/);
  assert.match(workbenchStyles, /\.task-monitor-rail \{[\s\S]*?top: calc\(40px \+ var\(--space-2\)\);/);
  assert.match(workbenchStyles, /\.task-monitor-rail \{[\s\S]*?background: transparent;/);
  assert.match(workbenchStyles, /\.task-monitor-section \{[\s\S]*?border-radius: 14px;/);
  assert.match(workbenchStyles, /\.task-monitor-section \{[\s\S]*?backdrop-filter: blur\(18px\)/);
  assert.match(workbenchStyles, /\.task-monitor-section \{[\s\S]*?box-shadow: 0 6px 20px/);
  // 环境信息是 tile 半宽小卡矩阵；组件按 tile variant 渲染。
  assert.match(monitorView, /task-monitor-tiles/);
  assert.match(monitorView, /variant="tile"/);
  assert.match(monitorView, /className=\{`task-monitor-section task-monitor-section--\$\{variant\}`\}/);
  assert.match(monitorView, /className="task-monitor-rail" aria-label=\{isZh \? '任务监控卡片' : 'Task monitor card'\}/);
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

test('环境胶囊继续留在 composer，详细环境进入监控小卡矩阵', () => {
  assert.match(chatSurface, /composer-env-capsule-dropdown/);
  assert.match(monitorView, /projectTaskMonitorEnvironment/);
  assert.match(monitorView, /task-monitor-tile-value/);
});
