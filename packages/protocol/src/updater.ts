/**
 * 更新通道（Update Channel）契约。
 *
 * 这是「版本号显示 + 检查更新 + 可选更新通道」能力的跨层边界类型：
 *   - 桌面更新适配器依据通道决定使用 latest*.yml / beta*.yml 哪条清单。
 *   - 渲染层（表达）仅消费这些类型展示版本徽标、更新摘要弹窗与设置项。
 *   - settings 存储是通道选择的权限真相（updateChannel 字段）。
 */
export type UpdateChannel = 'beta' | 'stable';

/**
 * 用户对更新通道的偏好。
 *   - 'auto'：未手动选择，回退到「按当前应用版本号语义」推断（含 -beta/-alpha/-rc → beta，否则 stable）。
 *   - 'beta' / 'stable'：用户手动选择，优先于版本号推断。
 */
export type UpdateChannelPreference = 'auto' | UpdateChannel;

/** 更新流程阶段。渲染层据此切换徽标红点 / 摘要弹窗 / 下载进度 / 安装态的表达。 */
export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  /**
   * mac 专用完成态：应用为 ad-hoc 签名，无法走 Squirrel 的「下载→签名校验→原子替换」
   * 自动安装链路，因此主进程自管下载 dmg 后停在此态，由用户在弹窗点击「打开安装包」，
   * 主进程 shell.openPath(dmg) 打开挂载，用户手动拖入「应用程序」覆盖安装。
   * 与 'downloaded'（Windows 重启安装）语义互斥。
   */
  | 'ready-to-open'
  | 'error';

/** 主进程向渲染层广播的更新事件（与 auto-updater 的 onEvent 一一对应）。 */
export interface UpdaterEvent {
  readonly type:
    | 'checking-for-update'
    | 'update-available'
    | 'update-not-available'
    | 'download-progress'
    | 'update-downloaded'
    | 'error';
  /** 目标/可用版本号（available / downloaded / not-available 时携带）。 */
  readonly version?: string;
  /** 下载进度百分比（download-progress 时携带，0–100 整数）。 */
  readonly percent?: number;
  /** 错误信息（error 时携带）。 */
  readonly message?: string;
  /** 更新说明 / release notes（available / downloaded 时可能携带）。 */
  readonly releaseNotes?: string;
}

/** 渲染层订阅 / 主动查询时获得的更新状态快照。 */
export interface UpdaterStatus {
  /** 当前应用版本号（来自 app.getVersion）。 */
  readonly currentVersion: string;
  /** 实际生效的更新通道（preference=auto 时为版本号推断结果）。 */
  readonly channel: UpdateChannel;
  /** 用户偏好（settings 真相）。 */
  readonly preference: UpdateChannelPreference;
  /** 更新能力是否启用（开发态默认禁用）。 */
  readonly enabled: boolean;
  /** 当前流程阶段。 */
  readonly phase: UpdaterPhase;
  /** 可用 / 已下载的新版本号。 */
  readonly availableVersion?: string;
  /** 下载进度百分比（0–100）。 */
  readonly percent?: number;
  /** 最近一次错误信息。 */
  readonly error?: string;
  /** 更新说明 / release notes。 */
  readonly releaseNotes?: string;
  /**
   * mac 自管下载完成的安装包（dmg）本地绝对路径，仅 phase='ready-to-open' 时存在。
   * 渲染层据此启用「打开安装包」按钮（实际打开动作仍在主进程 shell.openPath 执行）。
   */
  readonly installerPath?: string;
  /**
   * 兜底用的 GitHub Release 页面 URL。当 mac 自管下载因资产缺失/命名漂移失败时，
   * 主进程置 phase='error' 并提供此链接，渲染层展示「打开 Release 页面」按钮。
   */
  readonly releaseUrl?: string;
}

/** settings:update / settings:get 中与更新相关的字段。 */
export interface UpdaterSettings {
  /** 更新通道偏好，缺省 'auto'。 */
  readonly updateChannel?: UpdateChannelPreference;
}
