/**
 * Appshot（前台应用窗口快照）协议类型。
 *
 * 依据：peer-knowledge ADR 59（Appshots 能力边界与 Evidence 链）、
 * design/product/appshots-window-context-capture.md §5.4 产品语义模型、
 * design/product/appshots-engineering-task-breakdown.md §3.1 spike 实测定案。
 *
 * 约束（ADR 59 决策 3）：
 * - `visual.artifactRef` 引用本地落盘 PNG；整图禁止以 dataUrl 内联进会话存储。
 * - `visual.thumbnailDataUrl` 仅允许小缩略图（用于卡片即时渲染）。
 * - 失败必须结构化为 AppshotFailureCode 四类；permission_denied 由 preflight 判定。
 */

/** 结构化失败码（ADR 59 决策 3）。 */
export type AppshotFailureCode =
  | 'permission_denied'
  | 'peer_frontmost'
  | 'no_window'
  | 'window_not_capturable';

/** 捕获来源窗口的元数据（P0a：来自 CGWindowList / osascript）。 */
export interface AppshotSource {
  appName: string;
  bundleId?: string;
  pid?: number;
  windowId?: number;
  /** 默认不进日志（ADR 59 决策 4），仅进 payload。 */
  windowTitle?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
  displayId?: string | number;
}

/** 视觉通道：本地 artifact 引用 + 可选内联缩略图。 */
export interface AppshotVisual {
  /** `local-appshot-artifact://<id>` 形式的本地产物引用。 */
  artifactRef: string;
  /** 落盘文件绝对路径（主进程内部使用；不随消息跨端同步语义）。 */
  filePath?: string;
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg';
  byteSize: number;
  /** 仅允许小缩略图内联（≤64KB 级），供卡片即时渲染。 */
  thumbnailDataUrl?: string;
}

/** 文本通道占位（P0a 固定 mode:'none'；P0b 起启用其余模式）。 */
export interface AppshotText {
  mode: 'none' | 'visible_or_accessible' | 'includes_offscreen';
  contentRef?: string;
  preview?: string;
  truncated?: boolean;
}

/** 一次成功捕获的完整 payload。 */
export interface AppshotPayload {
  appshotId: string;
  capturedAt: string;
  source: AppshotSource;
  visual: AppshotVisual;
  text: AppshotText;
  /** 捕获耗时（毫秒），用于性能验收（产品文档 §12.4）。 */
  captureDurationMs?: number;
}

/** 结构化失败结果。 */
export interface AppshotFailure {
  ok: false;
  code: AppshotFailureCode;
  /** 面向日志/调试的简短说明；禁止包含窗口标题或图像数据（ADR 59 决策 4）。 */
  detail?: string;
}

/** 成功结果。 */
export interface AppshotSuccess {
  ok: true;
  payload: AppshotPayload;
}

export type AppshotResult = AppshotSuccess | AppshotFailure;
