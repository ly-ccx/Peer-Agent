import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, RequestError, type Agent, type SessionConfigOption, type SessionNotification } from '@agentclientprotocol/sdk';

export interface AcpSessionRuntime {
  getConfigOptions?(): SessionConfigOption[];
  setConfigOption?(configId: string, value: string): SessionConfigOption[];
  prompt(text: string, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
export type AcpRuntimeFactory = (cwd: string, update: (update: SessionNotification['update']) => Promise<void>, sessionId: string) => Promise<AcpSessionRuntime>;

/** Protocol routing only; execution and authorization remain behind the runtime port. */
export function createPeerAcpAgent(factory: AcpRuntimeFactory, notify: (event: SessionNotification) => Promise<void>) {
  const sessions = new Map<string, { runtime: AcpSessionRuntime; active?: AbortController; done?: Promise<void> }>();
  let initialized = false;
  let closed = false;
  function session(id: string) {
    if (closed || !initialized) throw RequestError.invalidRequest(null, 'Connection is not initialized');
    const value = sessions.get(id);
    if (!value) throw RequestError.invalidParams(null, 'Unknown session');
    return value;
  }
  const agent: Agent = {
    async initialize(params) {
      if (closed || initialized) throw RequestError.invalidRequest(null, 'Already initialized or closed');
      if (params.protocolVersion !== PROTOCOL_VERSION) throw RequestError.invalidParams(null, 'Unsupported protocol version');
      initialized = true;
      return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'peer', version: '0.0.12' }, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [] };
    },
    async authenticate() { throw RequestError.methodNotFound('authenticate'); },
    async newSession(params) {
      if (!initialized || closed) throw RequestError.invalidRequest(null, 'Initialize first');
      if (params.mcpServers.length) throw RequestError.invalidParams(null, 'Client MCP servers are not supported');
      if (!isAbsolute(params.cwd) || !(await stat(params.cwd).catch(() => null))?.isDirectory()) throw RequestError.invalidParams(null, 'cwd must be an existing absolute directory');
      const sessionId = randomUUID();
      const runtime = await factory(params.cwd, async (update) => {
        if (!closed) await notify({ sessionId, update });
      }, sessionId);
      if (closed) { await runtime.dispose(); throw RequestError.invalidRequest(null, 'Connection closed'); }
      sessions.set(sessionId, { runtime });
      return { sessionId, configOptions: runtime.getConfigOptions?.() ?? [] };
    },
    async setSessionConfigOption(params) {
      const entry = session(params.sessionId);
      if (entry.active) throw RequestError.invalidRequest(null, 'Cannot change model while a prompt is active');
      if (!entry.runtime.setConfigOption) throw RequestError.invalidParams(null, 'Session configuration is unavailable');
      if (typeof params.value !== 'string') throw RequestError.invalidParams(null, 'Model selection must be a string');
      return { configOptions: entry.runtime.setConfigOption(params.configId, params.value) };
    },
    async prompt(params) {
      const entry = session(params.sessionId);
      if (entry.active) throw RequestError.invalidRequest(null, 'Session already has an active prompt');
      if (!params.prompt.length || params.prompt.some((block) => block.type !== 'text')) throw RequestError.invalidParams(null, 'Only text prompts are supported');
      const text = params.prompt.map((block) => block.type === 'text' ? block.text : '').join('\n');
      if (!text.trim()) throw RequestError.invalidParams(null, 'Prompt must not be empty');
      const abort = new AbortController();
      entry.active = abort;
      try {
        entry.done = Promise.resolve().then(() => entry.runtime.prompt(text, abort.signal));
        await entry.done;
        return { stopReason: abort.signal.aborted ? 'cancelled' : 'end_turn' };
      } catch {
        if (abort.signal.aborted) return { stopReason: 'cancelled' };
        throw RequestError.internalError(null, 'Peer runtime failed');
      } finally { entry.active = undefined; entry.done = undefined; }
    },
    async cancel(params) { session(params.sessionId).active?.abort(); },
  };
  return { agent, async close() {
    closed = true;
    const entries = [...sessions.values()];
    for (const entry of entries) entry.active?.abort();
    await Promise.allSettled(entries.map(async (entry) => { await entry.done?.catch(() => {}); await entry.runtime.dispose(); }));
    sessions.clear();
  } };
}
