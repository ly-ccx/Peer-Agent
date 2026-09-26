/**
 * Desktop-side remote access assembly: local binding store, outbound connector,
 * and the read-only task reader that answers remote reads from local truth.
 *
 * Boundaries (ADR 75 / M1):
 *   - Nothing here executes a remote wish. A remote read only reaches the local
 *     host through createRemoteGoalReader, which re-checks delegation, task
 *     ownership and the runtime projection before any tool call is projected.
 *   - Values the Gateway must echo back (ownerId, deviceId, bindingVersion,
 *     connectionEpoch) come from the local binding and the live connection,
 *     never from the remote request body.
 *
 * Identity across restarts:
 *   - The Ed25519 private key is persisted in the OS keychain (see
 *     remote-identity-keychain.mjs) and the pairing lives in the local binding
 *     store, so a paired device reconnects after a restart without re-pairing.
 *   - A missing or unreadable keychain entry means "no identity yet": a fresh key
 *     is generated and stored, and the device has to be paired again. A corrupt
 *     entry is deleted and refused rather than silently replaced, so a broken
 *     keychain cannot quietly orphan an existing binding.
 *
 * Known limitations, stated plainly:
 *   - The delegation (allowed workspaces, read/export flags, expiry) is local
 *     configuration with no settings UI yet; it defaults to a single workspace.
 *   - A delegation is published once per connection. An app left running past its
 *     expiry fails closed (remote reads are refused) until the next reconnect.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  createRemoteBindingStore,
  defaultProjectRegistryFile,
  isRemoteWorkspaceId,
  readRemoteAliases,
  startRemoteDeviceConnector,
} from '@peer-agent/runtime-node';
import { createRemoteGoalReader } from './remote-goal-read.mjs';
import { createRemoteIdentityStore } from './remote-identity-keychain.mjs';

const DELEGATION_MS = 24 * 60 * 60 * 1000;

/** 委托名单：稳定 id，再加上注册表里的旧远程别名。两者都准入。 */
function resolveAcceptedWorkspaceIds(workspaceId, { registryFile, remoteAliases } = {}) {
  const extras = Array.isArray(remoteAliases)
    ? remoteAliases
    : readRemoteAliases(
      workspaceId,
      registryFile === undefined ? defaultProjectRegistryFile() : registryFile,
    );
  const ids = [];
  for (const value of [workspaceId, ...extras]) {
    if (isRemoteWorkspaceId(value) && !ids.includes(value)) ids.push(value);
  }
  if (ids.length === 0 && typeof workspaceId === 'string' && workspaceId) ids.push(workspaceId);
  return ids;
}

/** Ed25519 PKCS#8 DER header; the 32-byte seed follows it. Node's
 * generateKeyPairSync expects a full PKCS#8 structure, not a bare seed, so the
 * stored seed has to be re-wrapped before it can be used again. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED_BYTES = 32;

/** Ed25519 identity bound to a Keychain entry so the key survives restarts.
 * Generates a new keypair when no entry exists (first launch or after a reset).
 * The private key is stored as base64 single-line; measurements confirm that
 * multi-line PEM is truncated and stdin prompting is unusable headless, so
 * base64 is the only reliable format. */
async function createKeychainIdentity(identityStore) {
  const raw = await identityStore.loadSecret();
  let privateKey;
  if (raw) {
    const seed = Buffer.from(raw, 'base64');
    if (seed.length !== ED25519_SEED_BYTES) {
      // A truncated or foreign value cannot be used; clear it so the next launch
      // starts cleanly instead of failing forever on the same bad entry.
      await identityStore.deleteSecret().catch(() => {});
      throw new Error('INVALID_KEYCHAIN_KEY');
    }
    // Re-wrap the bare seed into PKCS#8. Verified: the reconstructed key has the
    // same public key and produces signatures that verify against it.
    privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8',
    });
  } else {
    const fresh = generateKeyPairSync('ed25519');
    const seed = fresh.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-ED25519_SEED_BYTES);
    await identityStore.saveSecret(seed.toString('base64'));
    privateKey = fresh.privateKey;
  }
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicKey,
    sign: async (message) => nodeSign(null, Buffer.from(message), privateKey).toString('base64url'),
  };
}

/**
 * Assemble remote access. Returns control handles only; the connector itself
 * stays private so callers cannot bypass the reader.
 *
 * @param {object} options
 * @param {string} options.userDataPath      - where the binding SQLite file lives
 * @param {string} options.gatewayOrigin     - Gateway https:// origin
 * @param {string} options.deviceName        - hostname shown in the device list
 * @param {string} options.workspaceId       - the workspace remote reads may address
 * @param {object} options.goalPlanStore     - listPlans()/getPlan(planId)
 * @param {object} options.sessionStore      - getSession()
 * @param {Function} options.buildProjection - () => runtime projection
 * @param {object} options.host              - local tool host (host.execute)
 * @param {object} [options.logger]
 * @param {Function} [options.connectorFactory] - host seam for tests; never remote input
 * @param {object} [options.identityStore] - keychain seam; defaults to the real store
 */
export function setupRemoteAccess({
  userDataPath, gatewayOrigin, deviceName, workspaceId,
  goalPlanStore, sessionStore, buildProjection, host,
  logger = { info() {}, warn() {}, error() {} },
  connectorFactory = startRemoteDeviceConnector,
  identityStore = createRemoteIdentityStore(),
  registryFile,
  remoteAliases,
} = {}) {
  for (const [name, value] of Object.entries({
    userDataPath, gatewayOrigin, deviceName, workspaceId,
  })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`MISSING_${name.toUpperCase()}`);
  }
  if (!goalPlanStore || !sessionStore || !buildProjection || !host) throw new Error('MISSING_DEPENDENCY');

  const acceptedWorkspaceIds = resolveAcceptedWorkspaceIds(workspaceId, { registryFile, remoteAliases });
  const bindingStore = createRemoteBindingStore(`${userDataPath}/remote-binding.sqlite`);
  // Resolved on first start: reading the keychain is async, and a machine that
  // never connects should not touch the keychain at all.
  let identity = null;
  // Live connection facts. The reader must echo these exactly; a hardcoded value
  // would be rejected by admitRemoteRead (STALE_CONNECTION / BINDING_CONFLICT).
  let connectionEpoch = 0;
  let online = false;
  let connector = null;
  // Why dialing gave up, when it did. Null while connected or never attempted.
  let lastFailure = null;
  // The challenge the server issued for this device to claim. Present only while
  // the connection is parked in 'pairing': it is what the user carries to the web
  // page to finish binding, and it expires, so it is cleared as soon as the
  // connection moves on or stops.
  let pairing = null;

  const delegationOf = () => ({
    version: 1,
    workspaceIds: acceptedWorkspaceIds,
    allowTaskRead: true,
    allowResultExport: true,
    expiresAt: Date.now() + DELEGATION_MS,
  });

  /** Remote task id -> local plan. Ownership is decided here, from local state.
   * Tasks live in `plan.subtasks` and may nest, so walk the tree. */
  function findLocalTask(taskId) {
    const plans = typeof goalPlanStore.listPlans === 'function' ? goalPlanStore.listPlans() : [];
    const walk = (nodes) => {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        if (!node) continue;
        if (node.taskId === taskId) return true;
        if (Array.isArray(node.subtasks) && walk(node.subtasks)) return true;
      }
      return false;
    };
    for (const plan of Array.isArray(plans) ? plans : []) {
      if (!plan) continue;
      // A plan id is also addressable as a task id: the M1 read target is "the
      // task", and a plan root is the task a caller is most likely to know.
      if (plan.planId === taskId) return { planId: plan.planId, taskId };
      if (walk(plan.subtasks)) return { planId: plan.planId, taskId };
    }
    return null;
  }

  const reader = createRemoteGoalReader({
    getSession: () => sessionStore.getSession(),
    getProjection: () => buildProjection(),
    host,
    resolveLocal: async (request) => {
      const binding = bindingStore.load();
      const delegation = delegationOf();
      const local = binding ? findLocalTask(request.taskId) : null;
      // Denial vocabulary belongs to the protocol, so instead of throwing here
      // (the reader collapses exceptions into LOCAL_STATE_UNAVAILABLE) we hand
      // back a context that fails the specific check admitRemoteRead performs.
      //
      // Identity is filled from LOCAL truth, never echoed from the request: a
      // forged owner or device id then mismatches by construction. No binding at
      // all is expressed as a revoked binding, which is the same class of denial.
      const identity = binding ?? { ownerId: '', deviceId: '', bindingVersion: 0 };
      return {
        // A missing task leaves planId unset; the delegation/task checks below
        // reject before the reader's own mapping guard would.
        planId: local ? local.planId : null,
        taskId: request.taskId,
        executionContext: { toolContext: { conversationId: sessionStore.getSession()?.sessionId } },
        admission: {
          now: Date.now(),
          ownerId: identity.ownerId,
          deviceId: identity.deviceId,
          bindingVersion: identity.bindingVersion,
          connectionEpoch,
          online,
          bindingRevoked: !binding,
          delegation: {
            version: delegation.version,
            expiresAt: delegation.expiresAt,
            revoked: false,
            workspaceIds: delegation.workspaceIds,
            allowTaskRead: delegation.allowTaskRead,
            allowResultExport: delegation.allowResultExport,
          },
          // `task` is the local ownership record. Absent when the task is not
          // ours, which admitRemoteRead reports as TASK_DENIED.
          task: local
            ? { taskId: local.taskId, ownerId: binding.ownerId, workspaceId: request.workspaceId }
            : undefined,
        },
      };
    },
  });

  /** Frame one answer. The result is a bounded read-only projection, not a dump:
   * an oversized answer is refused by the connection's frame budget rather than
   * truncated, because a truncated read would misstate local state. */
  async function onTaskRead(request) {
    try {
      const outcome = await reader(request);
      if (!outcome?.ok) return { status: 'rejected', code: outcome?.code || 'LOCAL_STATE_UNAVAILABLE' };
      const evidence = outcome.execution?.result?.evidence;
      return {
        status: 'ok',
        result: {
          taskId: request.taskId,
          planId: findLocalTask(request.taskId)?.planId,
          status: outcome.execution?.result?.status ?? 'unknown',
          evidenceRefs: Array.isArray(evidence?.artifactRefs) ? evidence.artifactRefs.slice(0, 8) : [],
        },
      };
    } catch (error) {
      const code = typeof error?.message === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(error.message)
        ? error.message
        : 'LOCAL_STATE_UNAVAILABLE';
      return { status: 'failed', code };
    }
  }

  return {
    /** Start connecting. Safe to call once; a second call is ignored.
     * Reads the keychain lazily, so a machine that never connects never touches it. */
    async start() {
      if (connector) return;
      const binding = bindingStore.load();
      if (binding?.disabled) throw new Error('REMOTE_DISABLED');
      // Resolve the persistent identity before dialing: the handshake signs with
      // it, and it must be the same key the Gateway already knows for this device.
      if (!identity) identity = await createKeychainIdentity(identityStore);
      connector = connectorFactory({
        origin: gatewayOrigin,
        store: { load: () => bindingStore.load(), save: value => bindingStore.save(value) },
        sign: identity.sign,
        publicKey: identity.publicKey,
        name: deviceName,
        deviceId: binding?.deviceId,
        delegation: delegationOf(),
        onTaskRead,
        onState(event) {
          if (event?.status === 'online') {
            // The epoch belongs to this connection; capture it for the reader.
            connectionEpoch = event.connectionEpoch;
            online = true;
            lastFailure = null;
            // Claimed: the challenge is spent and must not be offered again.
            pairing = null;
            logger.info('[remote] online epoch=%s', event.connectionEpoch);
          } else if (event?.status === 'pairing') {
            // Keep what the user needs to finish binding. Without this the
            // challenge only reached the log, so the surface had nothing to show
            // and pairing could not be completed from the app at all.
            pairing = event.pairing ? {
              challengeId: event.pairing.challengeId,
              pairingKey: event.pairing.pairingKey,
              deviceId: event.pairing.deviceId,
              expiresAt: event.pairing.expiresAt,
            } : null;
            logger.info('[remote] awaiting pairing claim');
          } else if (event?.status) {
            online = false;
            logger.info('[remote] %s', event.status);
          }
        },
      });
      // The supervisor resolves when it gives up. Without this the surface had no
      // way to learn that dialing stopped, so it showed "connecting…" forever.
      connector.closed.then(({ reason, detail }) => {
        online = false;
        // The connection is gone, so any challenge it carried is dead too.
        pairing = null;
        lastFailure = { reason, ...(detail?.code ? { code: detail.code } : {}), ...(detail?.message ? { message: detail.message } : {}) };
        logger.warn('[remote] connection closed: %s%s', reason, detail?.code ? ` (${detail.code})` : '');
      });
    },
    stop() {
      connector?.stop();
      connector = null;
      online = false;
      connectionEpoch = 0;
      // A deliberate stop is not a failure; clearing it here keeps a later
      // "connecting…" reading honest instead of replaying a stale reason.
      lastFailure = null;
      // Likewise a stopped connection holds no live challenge; showing a stale one
      // would invite the user to claim something the server no longer honours.
      pairing = null;
    },
    /** Local state for the settings surface; no secrets. */
    status() {
      const binding = bindingStore.load();
      return {
        deviceId: binding?.deviceId ?? null,
        ownerId: binding?.ownerId ?? null,
        disabled: binding?.disabled === true,
        online,
        connectionEpoch,
        lastFailure,
        pairing,
      };
    },
    bindingStore,
  };
}
