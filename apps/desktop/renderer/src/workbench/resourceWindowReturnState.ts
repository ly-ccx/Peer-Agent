import type { ResourceWindowContext } from '@peer-agent/protocol';
import { activateDocumentTab, createDocumentTabSession, openDocumentTab, type DocumentSessionState } from './documentSessionState.ts';
import { directoryReadingKey, rememberDirectoryReading, type DirectorySession } from './directorySessionState.ts';

/** Returning activates the source view; the copy's later reading never overwrites it. */
export function returnDocumentSession(session: DocumentSessionState, context: ResourceWindowContext) {
  const resource = context.resource;
  const original = session.tabs.find(tab => tab.id === context.sourceTabId && tab.reference?.workspaceId === context.owner.workspaceId
    && JSON.stringify(tab.reference?.task) === JSON.stringify(resource.reference.task)
    && (resource.kind === 'comparison' ? tab.comparison?.fromRef === resource.fromRef && tab.comparison?.toRef === resource.toRef && tab.comparison?.comparison === resource.comparison
      : !tab.comparison && resource.kind === 'document' && tab.reference?.revision?.commit === resource.reference.revision?.commit
        && JSON.stringify(tab.delivery) === JSON.stringify(resource.delivery)));
  if (original) return { session: activateDocumentTab(session, original.id), status: 'returned' as const };
  if (resource.kind !== 'comparison') return { session, status: 'source_tab_closed' as const };
  const tab = createDocumentTabSession(resource.reference.path, { reference: resource.reference, mode: 'diff', comparison: {
    fromRef: resource.fromRef, ...(resource.toRef ? { toRef: resource.toRef } : {}), ...(resource.comparison ? { comparison: resource.comparison } : {}),
  } });
  return { session: openDocumentTab(session, { ...tab, ...(context.sourceNavigation ? { resourceReading: context.sourceNavigation } : {}) }), status: 'returned' as const };
}
export function seedSourceDirectory(session: DirectorySession, context: ResourceWindowContext): DirectorySession {
  const nav = context.sourceNavigation, root = context.resource.reference.path, task = context.resource.reference.task;
  if (!nav || session.readings.some(reading => directoryReadingKey(reading) === directoryReadingKey({ root, task }))) return session;
  return rememberDirectoryReading(session, { root, task, expanded: nav.expanded ?? ['.'], selected: nav.selected ?? null, filter: nav.filter ?? '', top: nav.top, left: nav.left });
}
