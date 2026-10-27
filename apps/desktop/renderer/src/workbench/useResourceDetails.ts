import { useCallback, useRef, useState } from 'react';
import type { WorkbenchTabId } from './workbenchTabState';
import { sameResourceDetail, type ResourceDetailDescriptor, type ResourceDetailRef } from './resourceDetailState';

/** One bounded return destination, while each domain continues owning its own state. */
export function useResourceDetails(ports: {
  readonly workspaceId: string | null; readonly ready: boolean; readonly visible: boolean;
  readonly activeTab: WorkbenchTabId; readonly setTab: (tab: WorkbenchTabId) => void; readonly reveal: () => void;
}) {
  const latest = useRef(ports); latest.current = ports;
  const [target, bindDetailTarget] = useState<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<ResourceDetailDescriptor | null>(null);
  const [origin, setOrigin] = useState<ResourceDetailRef | null>(null);
  const lastResource = useRef<WorkbenchTabId>('launcher');
  const previousOwner = useRef(ports.workspaceId);
  if (previousOwner.current !== ports.workspaceId) {
    previousOwner.current = ports.workspaceId; lastResource.current = 'launcher'; setDetail(null); setOrigin(null);
  }
  if (ports.activeTab !== 'details') lastResource.current = ports.activeTab;
  const current = detail?.target.workspaceId === ports.workspaceId ? detail : null;
  const currentRef = useRef(current); currentRef.current = current;
  const detailActive = ports.activeTab === 'details';
  const registerDetail = useCallback((next: ResourceDetailDescriptor) => {
    if (next.target.workspaceId !== latest.current.workspaceId) return;
    setDetail(previous => sameResourceDetail(previous?.target, next.target) && previous?.title === next.title ? previous : next);
  }, []);
  const showDetails = useCallback(() => {
    if (!latest.current.ready) return;
    setOrigin(null); latest.current.setTab('details'); latest.current.reveal();
  }, []);
  const rememberDetailSource = useCallback(() => {
    if (latest.current.visible && latest.current.activeTab === 'details' && currentRef.current) setOrigin(currentRef.current.target);
  }, []);
  const returnToResources = useCallback(() => {
    if (!latest.current.ready) return;
    if (currentRef.current) setOrigin(currentRef.current.target);
    latest.current.setTab(lastResource.current); latest.current.reveal();
  }, []);
  const canReturn = !!current && sameResourceDetail(origin, current.target) && origin?.workspaceId === ports.workspaceId;
  return { detailTarget: target, bindDetailTarget, detail: current, detailActive,
    detailsVisible: ports.ready && ports.visible && detailActive, registerDetail, showDetails, rememberDetailSource, returnToResources,
    returnDetail: canReturn ? origin : null,
    returnToDetail: showDetails };
}
