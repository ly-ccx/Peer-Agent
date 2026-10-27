import { useState } from 'react';
import type { ResourceWindowOpenRequest } from '@peer-agent/protocol';
import { PeerIcon } from '../ui/icons';

export function OpenResourceWindowButton({ request, isZh, disabled = false }: { readonly request: ResourceWindowOpenRequest | (() => ResourceWindowOpenRequest); readonly isZh: boolean; readonly disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = window.peerAgent?.resourceWindowOpen;
  if (!open) return null;
  const label = isZh ? '另开只读窗口' : 'Open read-only window';
  return <span className="resource-window-open"><button type="button" className="ui-button is-compact" disabled={disabled || busy} aria-label={label} title={label} onClick={async () => {
    setBusy(true); setFailure(null);
    try {
      const result = await open(typeof request === 'function' ? request() : request);
      if (!result.ok) setFailure(result.status === 'limit_reached' ? (isZh ? '打开的资源窗口已达上限，请先关闭一个。' : 'Resource window limit reached. Close one first.') : (isZh ? '无法打开此来源。原视图已保留，可重试。' : 'Unable to open this source. The original view is preserved. Retry.'));
    } catch { setFailure(isZh ? '暂时无法打开窗口，可重试。' : 'Unable to open this window. Retry.'); }
    finally { setBusy(false); }
  }}><PeerIcon name="arrowUpRight" size={16} /></button>{failure ? <span className="resource-native-window-error" role="alert">{failure}</span> : null}</span>;
}
