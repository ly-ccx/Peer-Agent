import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BackgroundRunsProvider, useBackgroundRunsContext } from '../renderer/src/workbench/GlobalBackgroundTasksButton';
import { BackgroundRuntimePanel } from '../renderer/src/workbench/BackgroundRuntimePanel';

// Test-only entry: production now exposes runs through the task monitor.
// Runtime, reader, stop state and panel remain the production implementations.
function Entry() {
  const context = useBackgroundRunsContext()!;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={anchor} type="button" className="chat-header-action-btn background-runtime-trigger"
      aria-label="后台运行" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" />
      </svg>
    </button>
    {open && anchor.current && <BackgroundRuntimePanel {...context} anchor={anchor.current}
      id="background-smoke-panel" onClose={() => setOpen(false)} />}
  </>;
}

function Fixture() {
  const [generation, setGeneration] = useState(0);
  Object.assign(globalThis, { remountBackgroundHeader: () => setGeneration(value => value + 1) });
  return <BackgroundRunsProvider isZh={true}>
    <header key={generation} data-generation={generation} className="chat-header" style={{ position: 'fixed', top: 0, left: 0, width: '100%' }}>
      <span>对话</span><div className="chat-header-right"><Entry />
        <button type="button" className="chat-header-action-btn" aria-label="搜索">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" />
          </svg>
        </button>
      </div>
    </header>
    <div className="sidebar-bottom" style={{ position: 'fixed', bottom: 0, left: 0, width: 264 }}>
      <button type="button" className="sidebar-nav-btn">设置</button><span data-testid="version">Fixture</span>
    </div>
  </BackgroundRunsProvider>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
