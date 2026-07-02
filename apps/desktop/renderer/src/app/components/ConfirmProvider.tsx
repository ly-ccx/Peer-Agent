import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Overlay } from './Overlay';

/**
 * ConfirmProvider —— 统一的危险操作确认弹窗（命令式）。
 *
 * 背景：此前删除凭证等危险操作直接用 window.confirm()，弹出的是操作系统原生对话框，
 * 视觉与 Peer Frost 设计语言割裂、按钮文案不可定制、无法表达「危险态」。
 * 本 Provider 提供 useConfirm() → confirm(options): Promise<boolean>，
 * 调用体验与 window.confirm 一样是一行 await，但渲染的是复用 Overlay 基座的自绘弹窗。
 *
 * 挂载位置：main.tsx 中 AppearanceProvider 与 App 之间（在主题内、App 外），
 * 使确认弹窗继承主题变量。
 *
 * 能力真相不在此层；本组件仅负责「询问用户 yes/no」这一表达与交互编排。
 */

export type ConfirmTone = 'default' | 'danger';

export type ConfirmOptions = {
  /** 标题，可选。缺省时只显示 message。 */
  readonly title?: string;
  /** 主体描述文案，必填。 */
  readonly message: string;
  /** 确认按钮文案，默认「确认」。 */
  readonly confirmText?: string;
  /** 取消按钮文案，默认「取消」。 */
  readonly cancelText?: string;
  /** 语气：danger 时确认按钮走危险色（朱砂红）。 */
  readonly tone?: ConfirmTone;
};

type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/**
 * useConfirm —— 获取命令式确认函数。
 * 用法：const confirm = useConfirm(); const ok = await confirm({ message, tone: 'danger' });
 */
export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用');
  return ctx;
}

export function ConfirmProvider({ children }: { readonly children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  // 本次询问的 resolve 引用；关闭时读取并回传结果。
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  // 关闭前记录用户是否点了「确认」；遮罩 / ESC / 取消均视为 false。
  const resultRef = useRef(false);

  const confirm = useCallback<ConfirmContextValue>((options) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      resultRef.current = false;
      setRequest(options);
    });
  }, []);

  // Overlay 退场动画结束后真正卸载：回传结果并清理。
  const handleClosed = useCallback(() => {
    const resolve = resolverRef.current;
    const value = resultRef.current;
    resolverRef.current = null;
    resultRef.current = false;
    setRequest(null);
    resolve?.(value);
  }, []);

  const tone: ConfirmTone = request?.tone ?? 'default';
  const confirmText = request?.confirmText ?? '确认';
  const cancelText = request?.cancelText ?? '取消';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? (
        <Overlay
          onClose={handleClosed}
          ariaLabel={request.title ?? request.message}
          panelClassName="pa-confirm-dialog"
        >
          {({ requestClose }) => (
            <div className="pa-confirm-body">
              {request.title ? <h2 className="pa-confirm-title">{request.title}</h2> : null}
              <p className="pa-confirm-message">{request.message}</p>
              <div className="pa-confirm-actions">
                <button type="button" className="pa-confirm-btn ghost" onClick={requestClose}>
                  {cancelText}
                </button>
                <button
                  type="button"
                  className={tone === 'danger' ? 'pa-confirm-btn danger' : 'pa-confirm-btn primary'}
                  onClick={() => {
                    // 标记为确认，再走 Overlay 统一退场动画；结果在 handleClosed 回传。
                    resultRef.current = true;
                    requestClose();
                  }}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          )}
        </Overlay>
      ) : null}
    </ConfirmContext.Provider>
  );
}
