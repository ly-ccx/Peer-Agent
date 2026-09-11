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
 * Known limitations, stated plainly:
 *   - No credential vault: the Ed25519 key lives in memory and is regenerated on
 *     every launch, so a binding only survives while the process does. Restarting
 *     the app requires re-pairing. Wiring the vault is the next step.
 *   - The delegation (allowed workspaces, read/export flags, expiry) is local
 *     configuration with no settings UI yet; it defaults to a single workspace.
 *   - A delegation is published once per connection. An app left running past its
 *     expiry fails closed (remote reads are refused) until the next reconnect.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRemoteBindingStore, startRemoteDeviceConnector } from '@peer-agent/runtime-node';
import { createRemoteGoalReader } from './remote-goal-read.mjs';

const DELEGATION_MS = 24 * 60 * 60 * 1000;

/** In-memory Ed25519 identity until the credential vault is wired. */
function createEphemeralIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: async (message) => sign(null, Buffer.from(message), privateKey).toString('base64url'),
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
 */
export function setupRemoteAccess({
  userDataPath, gatewayOrigin, deviceName, workspaceId,
  goalPlanStore, sessionStore, buildProjection, host,
  logger = { info() {}, warn() {}, error() {} },
  connectorFactory = startRemoteDeviceConnector,
}) {
  for (const [name, value] of Object.entries({
    userDataPath, gatewayOrigin, deviceName, workspaceId,
  })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`MISSING_${name.toUpperCase()}`);
  }
  if (!goalPlanStore || !sessionStore || !buildProjection || !host) throw new Error('MISSING_DEPENDENCY');

  const bindingStore = createRemoteBindingStore(`${userDataPath}/remote-binding.sqlite`);
  const identity = createEphemeralIdentity();
  // Live connection facts. The reader must echo these exactly; a hardcoded value
  // would be rejected by admitRemoteRead (STALE_CONNECTION / BINDING_CONFLICT).
  let connectionEpoch = 0;
  let online = false;
  let connector = null;

  const delegationOf = () => ({
    version: 1,
    workspaceIds: [workspaceId],
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
    /** Start connecting. Safe to call once; a second call is ignored. */
    start() {
      if (connector) return;
      const binding = bindingStore.load();
      if (binding?.disabled) throw new Error('REMOTE_DISABLED');
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
            logger.info('[remote] online epoch=%s', event.connectionEpoch);
          } else if (event?.status === 'pairing') {
            logger.info('[remote] awaiting pairing claim');
          } else if (event?.status) {
            online = false;
            logger.info('[remote] %s', event.status);
          }
        },
      });
    },
    stop() {
      connector?.stop();
      connector = null;
      online = false;
      connectionEpoch = 0;
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
      };
    },
    bindingStore,
  };
}
