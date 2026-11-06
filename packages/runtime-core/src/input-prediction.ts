import { INPUT_PREDICTION_LIMITS, type InputCandidate, type InputPredictionPort, type InputPredictionSurface } from '@peer-agent/protocol';

export interface PredictionInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly surface: InputPredictionSurface;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly contextVersion: string;
  readonly quoteMessageId?: string;
  readonly eligible: boolean;
  readonly active: boolean;
  readonly composing: boolean;
}
export interface PredictionView {
  readonly status: 'idle' | 'waiting' | 'requesting' | 'visible' | 'accepting';
  readonly candidate: InputCandidate | null;
}

/** Owns every asynchronous generation; the editor retains all draft ownership. */
export function createInputPredictionController({ port, createId, now = Date.now,
  apply, debounceMs = { next_turn: 300, continuation: 500 }, validationMs = INPUT_PREDICTION_LIMITS.validationMs,
}: { port: InputPredictionPort; createId: () => string; now?: () => number;
  apply: (text: string, input: PredictionInput) => void;
  debounceMs?: { next_turn: number; continuation: number }; validationMs?: number;
}) {
  let input: PredictionInput | null = null, fingerprint = '', dismissed = '', acceptedText: string | null = null;
  let version = 0, generation = 0, requestId: string | null = null, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let view: PredictionView = { status: 'idle', candidate: null };
  const listeners = new Set<() => void>();
  function publish(next: PredictionView) { view = next; for (const listener of listeners) listener(); }
  function cancel() {
    generation++;
    clearTimeout(timer); clearTimeout(expiry);
    if (requestId) void port.cancel({ requestId, composerInstanceId }).catch(() => {});
    requestId = null;
    publish({ status: 'idle', candidate: null });
  }
  const composerInstanceId = createId();
  const eligible = (value: PredictionInput) => value.eligible && value.active && !value.composing
    && !!value.workspaceId && !!value.conversationId && !!value.contextVersion
    && value.selectionStart === value.selectionEnd && value.selectionEnd === value.text.length
    && value.text.length <= INPUT_PREDICTION_LIMITS.draftLength;
  async function request() {
    if (!input || disposed || !eligible(input)) return;
    const captured = input, ticket = generation, draftVersion = version;
    requestId = createId();
    const id = requestId;
    publish({ status: 'requesting', candidate: null });
    try {
      const result = await port.request({ requestId: id, composerInstanceId,
        workspaceId: captured.workspaceId, conversationId: captured.conversationId, surface: captured.surface,
        mode: captured.text ? 'continuation' : 'next_turn', draftVersion,
        draftText: captured.text, selectionStart: captured.selectionStart, selectionEnd: captured.selectionEnd,
        ...(captured.quoteMessageId ? { quoteMessageId: captured.quoteMessageId } : {}),
      });
      if (disposed || generation !== ticket || version !== draftVersion || !input || !eligible(input)) return;
      const candidate = result.kind === 'candidate' ? result.candidate : null;
      if (!candidate || candidate.requestId !== id || candidate.composerInstanceId !== composerInstanceId
        || candidate.workspaceId !== captured.workspaceId || candidate.conversationId !== captured.conversationId
        || candidate.draftVersion !== draftVersion || candidate.mode !== (captured.text ? 'continuation' : 'next_turn')
        || typeof candidate.insertionText !== 'string' || !candidate.insertionText.trim()
        || !Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= now()) {
        publish({ status: 'idle', candidate: null }); return;
      }
      publish({ status: 'visible', candidate });
      expiry = setTimeout(cancel, Math.max(0, Date.parse(candidate.expiresAt) - now()));
    } catch { if (!disposed && generation === ticket) publish({ status: 'idle', candidate: null }); }
  }
  function update(next: PredictionInput) {
    if (disposed) return;
    const key = JSON.stringify(next);
    if (key === fingerprint) return;
    const sameContext = input?.contextVersion === next.contextVersion && input?.conversationId === next.conversationId;
    if (!sameContext || (next.text !== input?.text && next.text !== acceptedText)) acceptedText = null;
    input = next; fingerprint = key; version++; cancel();
    const semanticKey = JSON.stringify([next.workspaceId, next.conversationId, next.contextVersion, next.text, next.quoteMessageId]);
    if (!eligible(next) || dismissed === semanticKey || acceptedText === next.text) return;
    publish({ status: 'waiting', candidate: null });
    timer = setTimeout(() => { void request(); }, next.text ? debounceMs.continuation : debounceMs.next_turn);
  }
  async function accept(): Promise<boolean> {
    if (!input || !eligible(input) || view.status !== 'visible' || !view.candidate) return false;
    const captured = input, candidate = view.candidate, ticket = generation, draftVersion = version;
    if (Date.parse(candidate.expiresAt) <= now()) { cancel(); return false; }
    publish({ status: 'accepting', candidate });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([port.validate({ requestId: candidate.requestId,
        candidateId: candidate.candidateId, composerInstanceId }),
      new Promise<{ kind: 'unavailable' }>(resolve => { timeout = setTimeout(() => resolve({ kind: 'unavailable' }), validationMs); })]);
      if (disposed || generation !== ticket || version !== draftVersion || !input || !eligible(input)) return false;
      if (result.kind !== 'valid' || Date.parse(candidate.expiresAt) <= now()) { cancel(); return false; }
      acceptedText = captured.text + candidate.insertionText;
      cancel();
      apply(acceptedText, captured);
      return true;
    } catch { if (generation === ticket) cancel(); return false; }
    finally { clearTimeout(timeout); }
  }
  return { composerInstanceId, update, accept, invalidate: cancel,
    suppressDraft(text: string) { acceptedText = text; cancel(); },
    dismiss() { if (input) dismissed = JSON.stringify([input.workspaceId, input.conversationId, input.contextVersion, input.text, input.quoteMessageId]); cancel(); },
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; cancel(); listeners.clear(); },
  };
}
