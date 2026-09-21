// Pure presentation logic for the remote-access panel. Kept apart from the
// component so the wording rules can be tested directly: the failure a user most
// often hits here is an expired pairing window, and a wrong lookup there shows an
// internal token instead of a way forward.
import type { RemoteAccessIpcResult } from '../../preload/contracts/bootstrapPreloadApi';

export type Status = NonNullable<RemoteAccessIpcResult['status']>;
export type Failure = NonNullable<Status['lastFailure']>;

/** One line for the status row. A failure is reported as a failure, never as a
 * pending connection: "connecting…" for a dial that already gave up hides the
 * only information the user needs to fix it. */
export function connectionSummary(status: Status): string {
  if (status.online) return `已连接${status.deviceId ? ` (${status.deviceId})` : ''}`;
  if (status.pairing) return '等待认领';
  if (status.lastFailure) return '连接失败';
  return status.active ? '正在连接…' : '未连接';
}

/** Transport codes name a root cause precisely, so they win when present. */
const FAILURE_HINTS: Record<string, string> = {
  SELF_SIGNED_CERT_IN_CHAIN: '证书链不受信任。若网络中有 TLS 代理，请把它的根证书加入系统信任，或让 Node 读取系统根证书。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书，可能被中间代理替换。',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器使用了自签证书。',
  CERT_HAS_EXPIRED: '服务器证书已过期。',
  ENOTFOUND: '域名解析失败。请检查 Gateway 地址拼写与网络。',
  ECONNREFUSED: '服务器拒绝连接。请确认 Gateway 正在运行、端口可达。',
  ETIMEDOUT: '连接超时。请检查网络或防火墙。',
};

/** Supervisor categories, keyed by reason rather than code: these describe why the
 * supervisor gave up, and they carry no transport code. Without this table they
 * reached the user as bare English tokens ("timeout", "disconnected"), which say
 * nothing about what to do next. */
const REASON_HINTS: Record<string, string> = {
  // The pairing window closing is the failure a user most often meets, since the
  // challenge expires while they are switching to the web page.
  timeout: '等待认领超时，这次挑战已失效。关闭再打开远程连接可重新获取。',
  disconnected: '连接已断开。关闭再打开远程连接可重试。',
  network_unavailable: '网络不可用。请检查网络后重试。',
  transport_failure: '与服务器的连接失败。请确认 Gateway 地址可达。',
  local_failure: '本机发起连接时出错，请重试。',
  connection_failure: '连接建立后异常中断，请重试。',
  send_failure: '向服务器发送数据失败，请重试。',
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
export function describeFailure(failure: Failure): string {
  const prefix = failure.code ? `[${failure.code}] ` : '';
  const hint = (failure.code ? FAILURE_HINTS[failure.code] : undefined)
    ?? failure.message
    ?? REASON_HINTS[failure.reason];
  return hint ? `${prefix}${hint}` : `${prefix}${failure.reason}`;
}
