import { Menu } from 'electron';

// ── 自定义应用菜单（见方案 B / ADR：⌘R 收归刷新内嵌浏览器页）──
//
// 背景：Electron 在「从未调用 setApplicationMenu」时会挂上一套内置默认菜单，
// 其 View 项自带 Reload(⌘R) / Force Reload(⌘⇧R) / Toggle DevTools——这套菜单
// 不分 dev/prod，所以正式包里 ⌘R 仍会刷新整个渲染进程（整窗刷新）。
//
// 本模块构造一套自定义菜单替换默认菜单，从根上移除「整窗 Reload / Force Reload」
// （生产环境），并把 ⌘R 重新绑定为「刷新内嵌浏览器页」——仅刷新当前活跃 <webview>，
// 无活动浏览器页时置灰禁用（对齐 Codex 正式版行为）。
//
// 设计约束：
// - main 是 .mjs 运行时，不经过 tsc，无法直接 import i18n 包（其 exports 指向 .ts 源），
//   故此处内置极小中英 label map；标准编辑/窗口项一律用 Electron `role`，由系统按
//   语言自动本地化，并保证 macOS 输入框 ⌘C/⌘V/⌘A 等不失效。
// - dev 环境额外保留整窗 Reload / Force Reload / Toggle DevTools，便于调试。

const LABELS = {
  'zh-CN': {
    edit: '编辑',
    view: '视图',
    window: '窗口',
    reloadBrowser: '刷新浏览器页',
    reloadApp: '重新加载（整窗）',
    forceReloadApp: '强制重新加载（整窗）',
    toggleDevTools: '切换开发者工具',
    minimize: '最小化',
    zoom: '缩放',
    close: '关闭窗口',
    services: '服务',
    hide: '隐藏',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出',
    about: '关于',
  },
  en: {
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    reloadBrowser: 'Reload Browser Page',
    reloadApp: 'Reload (Whole Window)',
    forceReloadApp: 'Force Reload (Whole Window)',
    toggleDevTools: 'Toggle Developer Tools',
    minimize: 'Minimize',
    zoom: 'Zoom',
    close: 'Close Window',
    services: 'Services',
    hide: 'Hide',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit',
    about: 'About',
  },
};

function resolveLabels(locale) {
  return locale === 'zh-CN' ? LABELS['zh-CN'] : LABELS.en;
}

/**
 * 构造自定义应用菜单模板。
 * @param {object} opts
 * @param {boolean} opts.isDev          开发环境（保留整窗 reload / devtools）
 * @param {string}  opts.locale         当前语言（'zh-CN' | 其它按 en）
 * @param {boolean} opts.hasActiveBrowser 是否存在活动内嵌浏览器页（决定 ⌘R 是否可用）
 * @param {() => void} opts.onReloadBrowser ⌘R 点击回调：刷新当前活跃 webview
 * @returns {import('electron').Menu}
 */
export function buildAppMenu({ isDev = false, locale = 'en', hasActiveBrowser = false, onReloadBrowser } = {}) {
  const t = resolveLabels(locale);
  const isMac = process.platform === 'darwin';

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [];

  // macOS 应用菜单（关于 / 服务 / 隐藏 / 退出，全部用 role 自动本地化）
  if (isMac) {
    template.push({
      role: 'appMenu',
    });
  }

  // 编辑菜单：全部用 role，保证 macOS 下 ⌘C/⌘V/⌘X/⌘A/撤销/重做正常
  template.push({
    label: t.edit,
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  });

  // 视图菜单：⌘R = 刷新内嵌浏览器页（无活动页时置灰）；dev 额外保留整窗 reload / devtools
  const viewSubmenu = [
    {
      label: t.reloadBrowser,
      accelerator: 'CmdOrCtrl+R',
      enabled: hasActiveBrowser,
      click: () => {
        if (typeof onReloadBrowser === 'function') onReloadBrowser();
      },
    },
  ];

  if (isDev) {
    viewSubmenu.push(
      { type: 'separator' },
      // dev 调试用：整窗 reload / force reload 走自定义加速键，避免与 ⌘R 冲突
      { label: t.reloadApp, accelerator: 'CmdOrCtrl+Shift+R', role: 'reload' },
      { label: t.forceReloadApp, accelerator: 'CmdOrCtrl+Alt+Shift+R', role: 'forceReload' },
      { label: t.toggleDevTools, role: 'toggleDevTools' },
    );
  }

  template.push({
    label: t.view,
    submenu: viewSubmenu,
  });

  // 窗口菜单：最小化 / 缩放 / 关闭，用 role 自动本地化
  template.push({
    label: t.window,
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }, { role: 'close' }]
      : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
  });

  return Menu.buildFromTemplate(template);
}
