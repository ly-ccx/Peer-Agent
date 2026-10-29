// Pure presentation logic for the remote-access panel. Kept apart from the
// component so the wording rules can be tested directly: the failure a user most
// often hits here is an expired pairing window, and a wrong lookup there shows an
// internal token instead of a way forward.
import { createI18n, type I18nRuntime, type TranslationKey } from '@peer-agent/i18n';
import type { RemoteAccessIpcResult } from '../../preload/contracts/bootstrapPreloadApi';

export type Status = NonNullable<RemoteAccessIpcResult['status']>;
export type Failure = NonNullable<Status['lastFailure']>;

/** One line for the status row. A failure is reported as a failure, never as a
 * pending connection: "connecting…" for a dial that already gave up hides the
 * only information the user needs to fix it. */
export function connectionSummary(status: Status, i18n: I18nRuntime = createI18n()): string {
  if (status.online) return `${i18n.t('remoteAccess.connected')}${status.deviceId ? ` (${status.deviceId})` : ''}`;
  if (status.pairing) return i18n.t('remoteAccess.pairing');
  if (status.lastFailure) return i18n.t('remoteAccess.failed');
  return i18n.t(status.active ? 'remoteAccess.connecting' : 'remoteAccess.disconnected');
}

/** Transport codes name a root cause precisely, so they win when present. */
const FAILURE_HINTS: Record<string, TranslationKey> = {
  SELF_SIGNED_CERT_IN_CHAIN: 'remoteAccess.failure.certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'remoteAccess.failure.leaf',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'remoteAccess.failure.selfSigned',
  CERT_HAS_EXPIRED: 'remoteAccess.failure.expiredCertificate',
  ENOTFOUND: 'remoteAccess.failure.dns',
  ECONNREFUSED: 'remoteAccess.failure.refused',
  ETIMEDOUT: 'remoteAccess.failure.timedOut',
};
const REASON_HINTS: Record<string, TranslationKey> = {
  timeout: 'remoteAccess.failure.timeout',
  disconnected: 'remoteAccess.failure.disconnected',
  network_unavailable: 'remoteAccess.failure.network',
  transport_failure: 'remoteAccess.failure.transport',
  local_failure: 'remoteAccess.failure.local',
  connection_failure: 'remoteAccess.failure.connection',
  send_failure: 'remoteAccess.failure.send',
};

/** Turn a structured failure into something a person can act on. Ordered from
 * most specific to least: a known code names the root cause, the dialer's own
 * message says what actually broke, the category hint says what to try, and the
 * bare reason is the last resort so an unrecognised category still shows
 * something truthful rather than an empty string.
 *
 * The category hints deliberately sit below `message`: a generic "请重试" must not
 * mask the concrete detail (e.g. "options.publicKey must be a string") that makes
 * the failure diagnosable. */
export function describeFailure(failure: Failure, i18n: I18nRuntime = createI18n()): string {
  const prefix = failure.code ? `[${failure.code}] ` : '';
  const codeKey = failure.code ? FAILURE_HINTS[failure.code] : undefined;
  const reasonKey = REASON_HINTS[failure.reason];
  const hint = codeKey ? i18n.t(codeKey) : failure.message ?? (reasonKey ? i18n.t(reasonKey) : undefined);
  return hint ? `${prefix}${hint}` : `${prefix}${failure.reason}`;
}
