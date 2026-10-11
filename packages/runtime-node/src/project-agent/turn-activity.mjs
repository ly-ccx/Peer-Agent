import { acceptedReplyResult } from './agent-turn-plan.mjs';
import { toolActivityPreview, toolActivitySummary } from '@peer-agent/protocol';

const LIMIT = 32_000;
const INTERVAL = 50;
const eventTime = (value, fallback) => Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : fallback;

/** Bounded presentation projection of an existing TurnSink, independent of persistence. */
export function createTurnActivity({ workspaceId, conversationId, publish = null, now = () => new Date().toISOString() } = {}) {
  let state = null, revision = 0, timer = null, textSequence = 0, textSegmentId = null, visible = false, replyCallId = null, previewChars = 0;
  const snapshot = () => visible && state ? { ...state, replyTo: [...state.replyTo], ...(state.modelSelection ? { modelSelection: { ...state.modelSelection } } : {}), segments: state.segments.map(segment => ({ ...segment,
    ...(segment.input ? { input: { ...segment.input } } : {}), ...(segment.result ? { result: { ...segment.result } } : {}) })) } : null;
  const preview = (value, limit) => {
    const projected = toolActivityPreview(value, Math.max(0, Math.min(limit, LIMIT - previewChars)));
    previewChars += projected.text.length;
    return projected;
  };
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
      timer = null; visible = show; textSequence = 0; textSegmentId = null; replyCallId = null; previewChars = 0;
      state = { workspaceId, conversationId, turnId, replyTo: replyTo.slice(0, 32), startedAt, revision: ++revision,
        phase: 'waiting', segments: [], replyText: '',
        ...(modelSelection?.modelProviderId ? { modelSelection: { modelProviderId: modelSelection.modelProviderId, reasoningEffort: modelSelection.reasoningEffort } } : {}) };
      flush();
    },
    round() { textSegmentId = null; replyCallId = null; if (state) { state.phase = 'waiting'; changed(true); } },
    accept(channel, payload) {
      if (!visible || !state || payload?.streamId !== state.turnId || ['done', 'error', 'stopped', 'disposed'].includes(state.phase)) return;
      if (channel === 'chat:stream:delta' && typeof payload.content === 'string') {
        let segment = state.segments.find(item => item.kind === 'text' && item.id === textSegmentId);
        if (!segment && state.segments.length < 100) {
          textSegmentId = `text-${++textSequence}`;
          segment = { kind: 'text', id: textSegmentId, text: '' }; state.segments.push(segment);
        }
        const used = state.segments.reduce((sum, item) => sum + (item.kind === 'text' ? item.text.length : 0), 0);
        if (segment) segment.text += payload.content.slice(0, Math.max(0, LIMIT - used));
        state.phase = 'responding'; changed();
      } else if (channel === 'chat:stream:thinking') {
        state.phase = 'thinking'; changed();
      } else if (channel === 'chat:stream:tool-progress' && payload.tool === 'post_reply' && typeof payload.replyText === 'string') {
        textSegmentId = null;
        replyCallId = payload.toolCallId;
        state.replyText = payload.replyText.slice(0, 2000);
        state.phase = 'responding'; changed();
      } else if (channel === 'chat:stream:tool-progress' && payload.tool !== 'post_reply' && typeof payload.toolCallId === 'string' && payload.toolCallId) {
        textSegmentId = null;
        let segment = tool(payload.toolCallId);
        if (!segment && state.segments.length < 100) {
          segment = { kind: 'tool', id: payload.toolCallId, name: String(payload.tool || '').slice(0, 80), status: 'preparing', startedAt: now() };
          state.segments.push(segment);
        }
        if (segment?.status === 'preparing') {
          segment.summary = toolActivitySummary({ path: payload.path });
          if (Number.isFinite(payload.receivedChars)) segment.receivedChars = Math.max(0, Math.min(1e9, payload.receivedChars));
          state.phase = 'tool'; changed();
        }
      } else if (channel === 'chat:stream:tool-call') {
        textSegmentId = null;
        if (payload.tool === 'post_reply') {
          replyCallId = payload.toolCallId;
          state.replyText = typeof payload.args?.text === 'string' ? payload.args.text.slice(0, 2000) : '';
          state.phase = 'settling';
        } else if (typeof payload.toolCallId === 'string' && payload.toolCallId) {
          let segment = tool(payload.toolCallId);
          if (!segment && state.segments.length < 100) {
            segment = { kind: 'tool', id: payload.toolCallId, name: String(payload.tool || '').slice(0, 80), status: 'preparing' };
            state.segments.push(segment);
          }
          if (segment?.status === 'preparing') {
            segment.status = 'running'; segment.startedAt = eventTime(payload.startedAtMs, now());
            segment.summary = toolActivitySummary(payload.args);
            segment.input = preview(payload.args ?? null, 2000);
            state.phase = 'tool';
          }
        }
        changed();
      } else if (channel === 'chat:stream:tool-result') {
        textSegmentId = null;
        const result = resultOf(payload.result);
        if (payload.toolCallId === replyCallId && (!acceptedReplyResult(result) || hiddenReply(result))) {
          state.replyText = ''; state.phase = 'thinking'; changed(true);
        }
        const segment = tool(payload.toolCallId);
        if (segment && ['preparing', 'running'].includes(segment.status)) {
          segment.status = failedResult(payload.result) ? 'error' : 'done';
          segment.startedAt = eventTime(payload.startedAtMs, segment.startedAt);
          segment.finishedAt = eventTime(payload.endedAtMs, now()); segment.result = preview(payload.result ?? null, 4000); changed();
        }
      } else if (channel === 'chat:stream:provider-recovery' || channel === 'chat:stream:connection-recovery') {
        if (channel === 'chat:stream:provider-recovery' && payload.toProviderId) state.modelSelection = { modelProviderId: payload.toProviderId };
        state.replyText = ''; state.segments = []; textSegmentId = null; previewChars = 0; state.phase = 'waiting'; changed(true);
      }
    },
    finish(phase) {
      if (!state) return;
      state.phase = phase;
      state.finishedAt = now();
      for (const segment of state.segments) {
        if (segment.kind === 'tool' && ['running', 'preparing'].includes(segment.status)) {
          segment.status = phase === 'stopped' ? 'stopped' : 'error'; segment.finishedAt = state.finishedAt;
          // Display-only. The persisted tool result stays null so retry continuity
          // does not treat an unfinished call as a real tool result.
          if (!segment.result) segment.result = preview(null, 4000);
        }
      }
      if (phase === 'error') state.replyText = '';
      if (phase === 'disposed') { state.replyText = ''; state.segments = []; }
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
