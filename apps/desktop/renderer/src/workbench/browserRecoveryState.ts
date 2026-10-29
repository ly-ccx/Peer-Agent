import { BROWSER_HOME_URL, type BrowserTabSession } from './browserSessionState.ts';

export function browserReopensFromUrl(tab: BrowserTabSession): boolean {
  return tab.visited === true && tab.url !== BROWSER_HOME_URL;
}
export function browserRecoveryDescription(isZh: boolean): string {
  return isZh
    ? '此网页按保存的网址重新打开。原表单、页内阅读位置和前进后退历史未恢复；登录状态取决于当前浏览器会话。'
    : 'This page was reopened from its saved URL. Forms, page position and navigation history were not restored; sign-in depends on the current browser session.';
}
export function browserGuestFailure(reason: unknown, url: string, isZh = false) {
  return { code: -1, desc: isZh ? (reason === 'oom' ? '页面内存不足，请重试。' : '页面进程已停止，请重试。')
    : (reason === 'oom' ? 'Page ran out of memory' : 'Page process stopped'), url };
}
