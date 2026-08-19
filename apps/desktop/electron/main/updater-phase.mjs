/**
 * 更新状态机相位锁定（phase locking）纯函数模块。
 *
 * 背景（修复「离开一会回来后安装按钮消失」）：
 *   主进程更新状态机存在多个并发触发源——每小时定时重查、窗口聚焦/激活
 *   重查（update-check-schedule 5 分钟节流）、弹窗 recheck、以及
 *   electron-updater 内部事件回调。它们都会写 state.phase：
 *   checkForUpdates() 无条件 setPhase('checking')，wireEvents 的
 *   update-available 处理器无条件 setPhase('available')。于是在
 *   downloading / downloaded / ready-to-open 期间发生的任何一次重查，
 *   都会把相位打回 available——渲染层 isReady 失效，安装按钮消失。
 *
 * 契约（本模块是「哪些相位不可被打断」的唯一决策点）：
 *   - LOCKED_PHASES：受保护相位。处于这些相位时，迟到/并发的检查类事件
 *     （update-available / update-not-available / checking-for-update）
 *     必须被丢弃，不能改写状态机。
 *   - shouldSkipStaleUpdateEvent(phase, eventType)：给定当前相位与到来的
 *     事件类型，返回是否应跳过该事件的状态写入与广播。
 *     * check 类事件（checking-for-update / update-available /
 *       update-not-available）在 LOCKED_PHASES 下一律跳过；
 *     * download-progress / update-downloaded / error 事件不被过滤——
 *       它们本身就是下载链路的一部分（error 事件还应能在锁定相位下
 *       正常落地，以便渲染层看到失败并提供 Release 页面兜底）。
 *   - isLockedPhase(phase)：相位是否处于保护集，供 checkForUpdates 入口
 *     守卫与 downloadUpdate 防重入守卫复用。
 *
 * 纯函数、无 IO、无依赖，方便对「相位 × 事件」交叉矩阵做穷举测试。
 */

/** 受保护相位：下载中 / 已下载 / 等待用户打开安装包。 */
export const LOCKED_PHASES = [
  'downloading',
  'downloaded',
  'ready-to-open',
];

/**
 * check 类事件：来源于「检查更新」这条链路（启动检查、定时重查、
 * 激活重查、手动 recheck、毕业探查回退）。这些事件在锁定相位下
 * 属于迟到事件，必须丢弃。
 */
const CHECK_EVENT_TYPES = new Set([
  'checking-for-update',
  'update-available',
  'update-not-available',
]);

/**
 * 判断相位是否处于保护集（不可被重查打断）。
 *
 * @param {string | undefined} phase 当前更新流程相位。
 * @returns {boolean}
 */
export function isLockedPhase(phase) {
  return LOCKED_PHASES.includes(phase);
}

/**
 * 判断一个 wireEvents 事件在当前相位下是否应被跳过。
 *
 * 规则：
 *   - 相位未锁定（idle / checking / available / not-available / error）：
 *     一切事件正常处理，返回 false。
 *   - 相位锁定（downloading / downloaded / ready-to-open）：
 *     check 类事件（checking-for-update / update-available /
 *     update-not-available）返回 true（迟到事件，丢弃）；
 *     其余事件（download-progress / update-downloaded / error）返回
 *     false（下载链路自身的事件，正常落地）。
 *
 * @param {string | undefined} phase 当前更新流程相位。
 * @param {string} eventType electron-updater 事件名。
 * @returns {boolean} true 表示跳过该事件（不改状态、不广播）。
 */
export function shouldSkipStaleUpdateEvent(phase, eventType) {
  if (!isLockedPhase(phase)) return false;
  return CHECK_EVENT_TYPES.has(eventType);
}

/**
 * 判断一次新的更新检查是否应该被相位锁定挡下。
 *
 * checkForUpdates() 的入口守卫：处于锁定相位时，任何来源的检查
 * （定时 / 激活 / 手动 / 毕业探查）都直接返回当前快照，既不改写
 * 相位，也不真正发起网络检查——避免「重查打断下载」以及「重查
 * 产生的迟到事件链」。
 *
 * @param {string | undefined} phase 当前更新流程相位。
 * @returns {boolean} true 表示跳过这次检查。
 */
export function shouldSkipUpdateCheck(phase) {
  return isLockedPhase(phase);
}
