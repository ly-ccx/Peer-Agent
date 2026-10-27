import type { LocalDocumentReadResult, ResourceEditSource, ResourceEditTarget } from '@peer-agent/protocol';
import { validResourceEditText } from '@peer-agent/protocol';
import { feedbackDigest } from '../feedback/resourceSelection';
import { clientApi } from '../../clientApi';
/** Explicit current read keeps the original resource identity and the host's existing scope. */
export async function readEditCurrent(target: ResourceEditTarget, source?: ResourceEditSource) {
  const expectedObservation = { resourceId: target.base.resourceId };
  let value: LocalDocumentReadResult | undefined;
  if (source?.kind === 'native') {
    const result = await window.peerResource!.read({ identity: source.identity, operation: 'content', ...(source.path ? { path: source.path } : {}), expectedObservation, loadCurrent: true });
    if (result.ok && result.document?.media === 'text') value = result.document;
  } else value = await clientApi.readFile('', undefined, undefined, { ...target.reference, expectedObservation });
  if (!value?.ok || !value.observation || value.observation.resourceId !== target.base.resourceId || !validResourceEditText(value.content)) throw new Error('RESOURCE_EDIT_SOURCE_CHANGED');
  if (await feedbackDigest(value.content) !== value.observation.contentVersion) throw new Error('RESOURCE_EDIT_UNSUPPORTED_TEXT');
  const observed = { resourceId: value.observation.resourceId, contentVersion: value.observation.contentVersion };
  const next: ResourceEditSource = source?.kind === 'native' ? { ...source, observed }
    : { kind: 'document', reference: { ...target.reference, expectedObservation: observed }, observed };
  return { text: value.content, source: next };
}
