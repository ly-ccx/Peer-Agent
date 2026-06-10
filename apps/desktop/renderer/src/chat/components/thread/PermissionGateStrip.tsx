import type { I18nRuntime } from '@peer-agent/i18n';
import type { ClientToolCall } from '@peer-agent/protocol';
import { useExitAnimation } from '../../hooks/useExitAnimation';

interface PermissionGateStripProps {
  readonly pendingCalls: readonly ClientToolCall[];
  readonly onApprove: (call: ClientToolCall) => void;
  /** M3·G「一直允许」：请求 main runtime 生成 scope grant，后续同 scope 由 main 自动放行。 */
  readonly onApproveAlways: (call: ClientToolCall) => void;
  readonly onReject: (call: ClientToolCall) => void;
  readonly showApproveAlways?: boolean;
  readonly i18n: I18nRuntime;
}

/**
 * Peer Vellum：紧贴 ChatComposer 上方的单行授权 strip。
 * 设计依据：[[feedback-tool-approval-inline-with-composer]] —— 待授权请求是用户的下一个动作，
 * 必须出现在视觉路径终点（输入框旁），不能在 thread 顶部。
 * surface 归属 control 层（暖灰），跟 composer 同家族保证视觉连续。
 */
export function PermissionGateStrip({
  pendingCalls,
  onApprove,
  onApproveAlways,
  onReject,
  showApproveAlways = true,
  i18n,
}: PermissionGateStripProps) {
  const { exiting, exit } = useExitAnimation(180);

  if (pendingCalls.length === 0 && !exiting) return null;
  if (pendingCalls.length === 0) return null;

  const head = pendingCalls[0];
  const extra = pendingCalls.length - 1;
  const preview = extractCommandPreview(head);

  const handleAction = (action: (call: ClientToolCall) => void) => {
    exit(() => action(head));
  };

  const handleApproveAlways = () => {
    exit(() => {
      for (const call of pendingCalls) {
        onApproveAlways(call);
      }
    });
  };

  return (
    <aside className={`permission-gate-strip ${exiting ? 'exiting' : ''}`} role="region" aria-live="polite">
      <span className="badge">{i18n.t('review.badge')}</span>
      <span className="capability">{head.capabilityId}</span>
      <span className="separator" aria-hidden="true">·</span>
      {preview ? <span className="preview">{preview}</span> : null}
      {extra > 0 ? (
        <span className="more">{i18n.t('review.morePending', { count: extra })}</span>
      ) : null}
      <div className="actions">
        <button type="button" className="deny" onClick={() => handleAction(onReject)}>
          {i18n.t('review.deny')}
        </button>
        <button type="button" className="allow" onClick={() => handleAction(onApprove)}>
          {i18n.t('review.allow')}
        </button>
        {showApproveAlways ? (
          <button type="button" className="allow-always" onClick={handleApproveAlways}>
            {i18n.t('review.allowAlways')}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

const PREVIEW_MAX = 80;

function extractCommandPreview(call: ClientToolCall): string {
  const args = call.argumentsPreview;
  if (!args || typeof args !== 'object') return '';
  const command =
    typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : typeof args.script === 'string'
          ? args.script
          : pickFirstString(args);
  if (!command) return '';
  return command.length > PREVIEW_MAX ? `${command.slice(0, PREVIEW_MAX)}…` : command;
}

function pickFirstString(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
