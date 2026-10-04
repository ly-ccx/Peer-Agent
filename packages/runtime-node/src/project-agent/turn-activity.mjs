import { acceptedReplyResult } from './agent-turn-plan.mjs';

const LIMIT = 32_000;
const INTERVAL = 50;

/** Bounded presentation projection of an existing TurnSink, independent of persistence. */
export function createTurnActivity({ workspaceId, conversationId, publish = null } = {}) {
  let state = null, revision = 0, timer = null, round = 0, visible = false, replyCallId = null;
  const snapshot = () => visible && state ? { ...state, replyTo: [...state.replyTo], ...(state.modelSelection ? { modelSelection: { ...state.modelSelection } } : {}), segments: state.segments.map(segment => ({ ...segment })) } : null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (visible && state) publish?.(snapshot());
  };
  const changed = (immediate = false) => {
    if (!state) return;
    state.revision = ++revision;
    if (immediate) flush();
    else if (!timer) { timer = setTimeout(flush, INTERVAL); timer.unref?.(); }
  };
  const tool = id => state?.segments.find(segment => segment.kind === 'tool' && segment.id === id);
  return {
    snapshot,
    begin({ turnId, modelSelection, replyTo = [], startedAt = '', visible: show = false }) {
      if (timer) clearTimeout(timer);
      timer = null; visible = show; round = 0; replyCallId = null;
      state = { workspaceId, conversationId, turnId, replyTo: replyTo.slice(0, 32), startedAt, revision: ++revision,
        phase: 'waiting', segments: [], replyText: '',
        ...(modelSelection?.modelProviderId ? { modelSelection: { modelProviderId: modelSelection.modelProviderId, reasoningEffort: modelSelection.reasoningEffort } } : {}) };
      flush();
    },
    round() { round++; replyCallId = null; if (state) { state.phase = 'waiting'; changed(true); } },
    accept(channel, payload) {
      if (!visible || !state || payload?.streamId !== state.turnId || ['done', 'error', 'stopped', 'disposed'].includes(state.phase)) return;
      if (channel === 'chat:stream:delta' && typeof payload.content === 'string') {
        const id = `text-${round}`;
        let segment = state.segments.find(item => item.id === id);
        if (!segment && state.segments.length < 100) { segment = { kind: 'text', id, text: '' }; state.segments.push(segment); }
        const used = state.segments.reduce((sum, item) => sum + (item.kind === 'text' ? item.text.length : 0), 0);
        if (segment) segment.text += payload.content.slice(0, Math.max(0, LIMIT - used));
        state.phase = 'responding'; changed();
      } else if (channel === 'chat:stream:thinking') {
        state.phase = 'thinking'; changed();
      } else if (channel === 'chat:stream:tool-progress' && payload.tool === 'post_reply' && typeof payload.replyText === 'string') {
        replyCallId = payload.toolCallId;
        state.replyText = payload.replyText.slice(0, 2000);
        state.phase = 'responding'; changed();
      } else if (channel === 'chat:stream:tool-call') {
        if (payload.tool === 'post_reply') {
          replyCallId = payload.toolCallId;
          state.replyText = typeof payload.args?.text === 'string' ? payload.args.text.slice(0, 2000) : '';
          state.phase = 'settling';
        } else if (typeof payload.toolCallId === 'string' && !tool(payload.toolCallId) && state.segments.length < 100) {
          state.segments.push({ kind: 'tool', id: payload.toolCallId, name: String(payload.tool || '').slice(0, 80), status: 'running' });
          state.phase = 'tool';
        }
        changed();
      } else if (channel === 'chat:stream:tool-result') {
        const result = resultOf(payload.result);
        if (payload.toolCallId === replyCallId && (!acceptedReplyResult(result) || hiddenReply(result))) {
          state.replyText = ''; state.phase = 'thinking'; changed(true);
        }
        const segment = tool(payload.toolCallId);
        if (segment) { segment.status = failedResult(payload.result) ? 'error' : 'done'; changed(); }
      } else if (channel === 'chat:stream:provider-recovery' || channel === 'chat:stream:connection-recovery') {
        if (channel === 'chat:stream:provider-recovery' && payload.toProviderId) state.modelSelection = { modelProviderId: payload.toProviderId };
        state.replyText = ''; state.segments = []; state.phase = 'waiting'; changed(true);
      }
    },
    finish(phase) {
      if (!state) return;
      state.phase = phase;
      if (phase === 'error' || phase === 'disposed') { state.replyText = ''; state.segments = []; }
      changed(true);
    },
    dispose() { this.finish('disposed'); if (timer) clearTimeout(timer); timer = null; visible = false; state = null; },
  };
}

function resultOf(value) {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' ? value : null;
}

function hiddenReply(result) {
  if (typeof result === 'string') { try { return hiddenReply(JSON.parse(result)); } catch { return true; } }
  if (!result || typeof result !== 'object') return true;
  if (result.suppressed === true || ['silent', 'digest'].includes(result.surfacing || result.meta?.surfacing)) return true;
  const nested = result.output ?? result.outputPreview?.legacyResult ?? result.legacyResult;
  return nested != null ? hiddenReply(nested) : false;
}

function failedResult(result, depth = 0) {
  if (depth > 8) return true;
  if (typeof result === 'string') { try { return failedResult(JSON.parse(result), depth + 1); } catch { return false; } }
  if (!result || typeof result !== 'object') return false;
  if (result.ok === false || result.success === false || result.error || ['failed', 'denied', 'cancelled'].includes(result.status)) return true;
  const nested = result.output ?? result.outputPreview?.legacyResult ?? result.legacyResult;
  return nested != null ? failedResult(nested, depth + 1) : false;
}
