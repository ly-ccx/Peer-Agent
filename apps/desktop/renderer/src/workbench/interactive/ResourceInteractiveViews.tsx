import { useCallback, useLayoutEffect, useState } from 'react';
import type { ResourceInteractiveTab } from '@peer-agent/protocol';
import { useResourceWorkspace } from '../ResourceWorkspaceContext';
import { useDocumentReadingPosition } from '../useDocumentReadingPosition';
import { OpenResourceWindowButton } from '../OpenResourceWindowButton';
import { interactiveSessionKey } from './interactiveSessionRegistry';
import { InteractiveResource } from './InteractiveResource';
import './interactive-resource.css';

function ReadingSurface({ tab, active, isZh }: { readonly tab: ResourceInteractiveTab; readonly active: boolean; readonly isZh: boolean }) {
  const workspace = useResourceWorkspace()!;
  const [ready, setReady] = useState(false);
  const contentReady = useCallback(() => setReady(true), []), contentUnavailable = useCallback(() => setReady(false), []);
  const remember = workspace.rememberInteractive, metadata = workspace.rememberInteractiveTitle;
  const generation = workspace.interactiveReadingGeneration;
  const referenceKey = interactiveSessionKey(tab.reference);
  const onRemember = useCallback((_key: string, point: { top: number; left: number }) => remember(tab.reference, point, generation), [remember, referenceKey, generation]);
  const reading = useDocumentReadingPosition(interactiveSessionKey(tab.reference), 'interactive', active, ready, undefined,
    { key: 'interactive', initial: { interactive: tab.navigation ?? { top: 0, left: 0 } }, onRemember });
  useLayoutEffect(() => { if (!active) setReady(false); }, [active]);
  return <section className="resource-interactive-session">
    <div className="resource-interactive-actions"><OpenResourceWindowButton isZh={isZh} disabled={!active || !ready}
      label={isZh ? '打开独立视图' : 'Open separate view'} request={() => ({ resource: { kind: 'interactive', reference: tab.reference }, sourceTabId: tab.id,
        navigation: reading.capture() })} /></div>
    <div className="resource-interactive-body" ref={reading.ref} onScroll={reading.onScroll}>
      <InteractiveResource reference={tab.reference} api={window.peerAgent?.interactiveResults} active={active} isZh={isZh}
        onReady={contentReady} onUnavailable={contentUnavailable} onMetadata={metadata} />
    </div>
  </section>;
}
function InteractiveTab({ tab, active, isZh }: { readonly tab: ResourceInteractiveTab; readonly active: boolean; readonly isZh: boolean }) {
  const workspace = useResourceWorkspace()!;
  const [settled, setSettled] = useState(workspace.interactiveLayoutState.phase !== 'loading');
  useLayoutEffect(() => { if (workspace.interactiveLayoutState.phase !== 'loading') setSettled(true); }, [workspace.interactiveLayoutState.phase]);
  return <div className="workbench-view resource-interactive-view" data-active={active} inert={!active || workspace.interactiveLayoutTransitioning} aria-hidden={!active}>
    {settled ? <ReadingSurface key={workspace.interactiveReadingGeneration} tab={tab} active={active} isZh={isZh} /> : <p role="status">{isZh ? '正在恢复阅读位置…' : 'Restoring the reading position…'}</p>}
  </div>;
}
export function ResourceInteractiveViews({ visible, active, isZh }: { readonly visible: boolean; readonly active: boolean; readonly isZh: boolean }) {
  const workspace = useResourceWorkspace();
  return workspace?.interactiveTabs.map(tab => <InteractiveTab key={interactiveSessionKey(tab.reference)} tab={tab}
    active={active && visible && workspace.activeInteractiveId === tab.id} isZh={isZh} />);
}
