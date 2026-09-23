// Intake 期 UI 交付判定（纯函数，无 I/O、无状态）。
//
// 作用：goal 契约建立/修订时，判定“交付物是不是 UI 像素”。命中则由宿主
// （desktop → ui-delivery-authority.requirePreview）前置武装视觉验证门，
// 不再依赖模型自觉截图或用户手动要求（会话 95d2e647 的事故根因）。
//
// 治理：本模块只做分类，不做执行、不落盘、不触发授权；武装动作永远走
// ui-delivery-authority 的既有治理链（require marker / read / evaluate）。
// 判定结果是事实信号（verdict + reasons），不是系统指令。

// UI 表层词汇（权重 2）：出现即强烈暗示交付物是界面像素。
const UI_SURFACE_ZH = [
  '界面', '页面', '布局', '样式', '按钮', '弹窗', '对话框', '表单', '菜单', '导航',
  '侧边栏', '顶栏', '底栏', '工具栏', '状态栏', '标题栏', '这一栏', '图标', '颜色',
  '配色', '主题', '暗色', '深色', '夜间模式', '动画', '过渡效果', '字体', '圆角',
  '阴影', '边框', '背景色', '空状态', '骨架屏', '占位图', '悬浮', '下拉', '开关',
  '滑块', '复选', '单选', '分页', '卡片', '列表渲染', '排版', '间距', '对齐',
];
const UI_SURFACE_EN = [
  'modal', 'dialog', 'button', 'layout', 'css', 'theme', 'dark mode', 'icon',
  'border', 'shadow', 'background', 'empty state', 'skeleton', 'toast', 'banner',
  'navbar', 'sidebar', 'header', 'footer', 'dropdown', 'tooltip', 'checkbox',
  'toggle', 'slider', 'pagination', 'responsive', 'ui element',
];

// 渲染层/文件线索（权重 1）。
const RENDERER_HINTS_ZH = ['组件', '渲染层', '前端', '网页', '视图层', 'webview'];
const RENDERER_HINTS_EN = ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less', '.html', 'component', 'renderer', 'frontend'];

// 预览线索（权重 1）。
const PREVIEW_HINTS_ZH = ['预览', '渲染效果', '页面渲染', '打开页面'];
const PREVIEW_HINTS_EN = ['preview', 'live page'];

// 独立强视觉信号（权重 3）：单独出现即武装（非“验证机制”语义）。
const VISUAL_ACCEPTANCE_ZH = ['看效果', '视觉效果', '视觉验收', '像素级', '还原度', '设计稿'];
const VISUAL_ACCEPTANCE_EN = ['pixel-perfect', 'look and feel', 'visual acceptance'];

// 验证机制元词汇（权重 0）：目标在“造/改验证机制本身”而非交付 UI。
// 只有与表层/渲染层词汇同时命中时才作为佐证，避免“给截图验证加单测”这类
// 元目标误武装。
const META_VERIFICATION_ZH = ['截图', '视觉验证', '截图验证', '视觉修复', '验证门', '完成门'];
const META_VERIFICATION_EN = ['screenshot', 'visual verification', 'visual repair', 'verification gate', 'completion gate'];

// 负向词汇（权重 -1，下限 0）：纯后端/算法/测试类交付削弱 UI 判定。
const NEGATIVE_HINTS_ZH = ['单测', '单元测试', '测试用例', '回归测试', '后端', '数据库', '迁移脚本', '命令行'];
const NEGATIVE_HINTS_EN = ['unit test', 'regression test', 'cli', 'backend', 'database schema', 'migration script'];

function collectMatches(haystack, tokens, mode) {
  const matched = [];
  for (const token of tokens) {
    if (mode === 'en') {
      const pattern = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (pattern.test(haystack)) matched.push(token);
    } else if (haystack.includes(token)) {
      matched.push(token);
    }
  }
  return matched;
}

function collectExtensionMatches(haystack, tokens) {
  return tokens.filter((token) => haystack.includes(token));
}

function summarize(label, matches, limit = 6) {
  if (matches.length === 0) return null;
  return `${label}:${matches.slice(0, limit).join(',')}`;
}

/**
 * 判定一个 goal 契约的交付物是否为 UI 像素。
 *
 * @param {object} input { title, goal, tasks, successCriteria }
 * @returns {{ required: boolean, confidence: 'high'|'medium'|'low', score: number, reasons: string[] }}
 */
export function classifyUiDeliveryIntake(input = {}) {
  const parts = [
    input.title,
    input.goal,
    ...(Array.isArray(input.tasks) ? input.tasks.map((task) => task?.title) : []),
    ...(Array.isArray(input.successCriteria)
      ? input.successCriteria.map((item) => (typeof item === 'string'
        ? item
        : [item?.description, item?.command, item?.path].filter(Boolean).join(' ')))
      : []),
  ].filter((value) => typeof value === 'string');
  const haystack = parts.join('\n').toLowerCase();

  const surface = [...collectMatches(haystack, UI_SURFACE_ZH, 'zh'), ...collectMatches(haystack, UI_SURFACE_EN, 'en')];
  const renderer = [
    ...collectMatches(haystack, RENDERER_HINTS_ZH, 'zh'),
    ...collectMatches(haystack, RENDERER_HINTS_EN, 'en'),
    ...collectExtensionMatches(haystack, ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less', '.html']),
  ];
  const preview = [...collectMatches(haystack, PREVIEW_HINTS_ZH, 'zh'), ...collectMatches(haystack, PREVIEW_HINTS_EN, 'en')];
  const visual = [
    ...collectMatches(haystack, VISUAL_ACCEPTANCE_ZH, 'zh'),
    ...collectMatches(haystack, VISUAL_ACCEPTANCE_EN, 'en'),
  ];
  const meta = [...collectMatches(haystack, META_VERIFICATION_ZH, 'zh'), ...collectMatches(haystack, META_VERIFICATION_EN, 'en')];
  const negative = [...collectMatches(haystack, NEGATIVE_HINTS_ZH, 'zh'), ...collectMatches(haystack, NEGATIVE_HINTS_EN, 'en')];

  // 元目标护栏：若“截图/视觉验证”类词汇只与验证机制词汇共现，而无任何
  // UI 表层/渲染层/预览词汇，则视为在造验证机制本身，不武装。
  const metaOnly = meta.length > 0 && surface.length === 0 && renderer.length === 0 && preview.length === 0 && visual.length === 0;

  let score = surface.length * 2 + renderer.length * 1 + preview.length * 1 + visual.length * 3 - negative.length * 1;
  if (score < 0) score = 0;
  const required = !metaOnly && score >= 2;

  const reasons = [
    summarize('ui-surface', surface),
    summarize('renderer', renderer),
    summarize('preview', preview),
    summarize('visual-acceptance', visual),
    summarize('meta-verification', meta),
    summarize('negative', negative),
  ].filter(Boolean);

  return {
    required,
    confidence: !required ? 'low' : score >= 4 ? 'high' : 'medium',
    score,
    reasons,
  };
}
