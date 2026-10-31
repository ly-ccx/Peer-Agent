import { useState } from 'react';
import { clientApi } from '../../clientApi';

/** System open for formats this workspace does not preview. The path must already be a host-resolved file. */
export function ExternalDocumentActions({ path, workspaceRoot, isZh, className = 'ui-button is-compact' }: {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly isZh: boolean;
  readonly className?: string;
}) {
  const [message, setMessage] = useState('');
  const open = (mode: 'auto' | 'reveal') => {
    setMessage('');
    void clientApi.openPath(path, workspaceRoot, { mode }).then(result => {
      if (!result.ok) setMessage(result.message || (isZh ? '系统未能打开这个文件。' : 'The system could not open this file.'));
    });
  };
  return <>
    <button type="button" className={className} onClick={() => open('auto')}>{isZh ? '用系统默认程序打开' : 'Open with the default app'}</button>
    <button type="button" className={className} onClick={() => open('reveal')}>{isZh ? '在文件夹中显示' : 'Show in folder'}</button>
    {message ? <p role="alert">{message}</p> : null}
  </>;
}
