/**
 * Browser 溢出菜单模型（P0）——纯数据，便于单测与 i18n。
 * 完整产品面见 peer-knowledge design/product/embedded-browser-surface.md。
 */

export type BrowserMenuActionId =
  | 'find_in_page'
  | 'print'
  | 'zoom_out'
  | 'zoom_in'
  | 'zoom_reset'
  | 'device_toolbar'
  | 'screenshot'
  | 'import_site_session'
  | 'clear_site_data'
  | 'password_manager'
  | 'downloads'
  | 'clear_browsing_data'
  | 'browser_settings';

export type BrowserMenuItem =
  | {
      readonly kind: 'action';
      readonly id: BrowserMenuActionId;
      readonly label: string;
      /** P0 可点；其余可展示但 disabled */
      readonly enabled: boolean;
    }
  | { readonly kind: 'separator' };

export function buildBrowserOverflowMenu(isZh: boolean): readonly BrowserMenuItem[] {
  return [
    {
      kind: 'action',
      id: 'find_in_page',
      label: isZh ? '在页面中查找' : 'Find in page',
      enabled: false,
    },
    {
      kind: 'action',
      id: 'print',
      label: isZh ? '打印…' : 'Print…',
      enabled: false,
    },
    { kind: 'separator' },
    {
      kind: 'action',
      id: 'zoom_out',
      label: isZh ? '缩小' : 'Zoom out',
      enabled: false,
    },
    {
      kind: 'action',
      id: 'zoom_in',
      label: isZh ? '放大' : 'Zoom in',
      enabled: false,
    },
    {
      kind: 'action',
      id: 'zoom_reset',
      label: isZh ? '重置缩放' : 'Reset zoom',
      enabled: false,
    },
    { kind: 'separator' },
    {
      kind: 'action',
      id: 'device_toolbar',
      label: isZh ? '设备工具栏' : 'Show device toolbar',
      enabled: false,
    },
    {
      kind: 'action',
      id: 'screenshot',
      label: isZh ? '截取页面' : 'Take a screenshot',
      enabled: true,
    },
    { kind: 'separator' },
    {
      kind: 'action',
      id: 'import_site_session',
      // 刻意不用 “Import cookies and passwords”
      label: isZh ? '导入站点会话…' : 'Import site session…',
      enabled: true,
    },
    {
      kind: 'action',
      id: 'clear_site_data',
      label: isZh ? '清除此站点数据…' : 'Clear this site data…',
      enabled: true,
    },
    {
      kind: 'action',
      id: 'password_manager',
      label: isZh ? '密码管理…' : 'Password manager…',
      enabled: true,
    },
    { kind: 'separator' },
    {
      kind: 'action',
      id: 'downloads',
      label: isZh ? '下载' : 'Downloads',
      enabled: false,
    },
    {
      kind: 'action',
      id: 'clear_browsing_data',
      label: isZh ? '清除浏览数据…' : 'Clear browsing data…',
      enabled: false,
    },
    {
      kind: 'action',
      id: 'browser_settings',
      label: isZh ? '浏览器设置…' : 'Browser settings…',
      enabled: false,
    },
  ];
}

/** P0 已接线的动作 id 集合（其余仅展示）。 */
export const BROWSER_MENU_P0_ENABLED_IDS: ReadonlySet<BrowserMenuActionId> = new Set([
  'screenshot',
  'import_site_session',
  'clear_site_data',
  'password_manager',
]);

export function importSiteSessionPlaceholder(isZh: boolean): string {
  return isZh
    ? '导入站点会话将在后续版本接通（仅 Cookie，不含密码）。'
    : 'Import site session will be wired in a later build (cookies only, not passwords).';
}
