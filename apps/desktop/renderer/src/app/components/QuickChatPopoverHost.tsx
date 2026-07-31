import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import type { QuickChatPopoverState } from '../../preload/contracts/bootstrapPreloadApi';
import { QuickChatPopover } from './QuickChatPopover';

/**
 * Independent Electron window host for Quick Chat menus (ADR 60).
 * Main process positions this window; content fills the window (no absolute offset).
 */
export function QuickChatPopoverHost() {
  const [state, setState] = useState<QuickChatPopoverState | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('quick-chat-popover-window');
    document.body.classList.add('quick-chat-popover-window');
    return () => {
      document.documentElement.classList.remove('quick-chat-popover-window');
      document.body.classList.remove('quick-chat-popover-window');
    };
  }, []);

  useEffect(() => {
    const unsubscribe = clientApi.onQuickChatPopoverState?.((next) => {
      setState(next ?? null);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  if (!state) {
    return <main className="quick-chat-popover-host" aria-hidden="true" />;
  }

  return (
    <main className="quick-chat-popover-host">
      <QuickChatPopover
        state={state}
        layout="host"
        onDismiss={() => {
          void clientApi.quickChatHidePopover?.().catch(() => {});
        }}
        onSelect={(value) => {
          void clientApi.quickChatSelectPopoverValue?.(value).catch(() => {});
        }}
      />
    </main>
  );
}
