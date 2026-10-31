import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { createInputPredictionController, type PredictionInput, type PredictionView } from '@peer-agent/runtime-core';
import type { InputPredictionSurface } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { isImeKey } from '../state/compositionGuard';
import { createComposerEditTransactions, type ComposerEditValue } from '../state/composerEditTransactions';
import { inputPredictionPreferences } from '../state/inputPredictionPreferences';

interface Options {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly surface: InputPredictionSurface;
  readonly contextVersion: string;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly eligible: boolean;
  readonly quoteMessageId?: string;
}

export function useInputPrediction(options: Options) {
  const current = useRef(options); current.current = options;
  const controller = useRef<ReturnType<typeof createInputPredictionController> | null>(null);
  const history = useRef(createComposerEditTransactions());
  const before = useRef<ComposerEditValue | null>(null), composition = useRef<ComposerEditValue | null>(null);
  const preferences = useSyncExternalStore(inputPredictionPreferences.subscribe, inputPredictionPreferences.getSnapshot);
  const preferenceRef = useRef(preferences); preferenceRef.current = preferences;
  const presented = useRef(false), pendingSelection = useRef<ComposerEditValue | null>(null);
  const knownText = useRef(options.text);
  const [view, setView] = useState<PredictionView>({ status: 'idle', candidate: null });
  const [isPresented, setPresented] = useState(false);
  const read = (node: HTMLTextAreaElement): ComposerEditValue => ({ text: node.value, start: node.selectionStart, end: node.selectionEnd });
  function sync() {
    const value = current.current, node = value.textareaRef.current, settings = preferenceRef.current;
    if (!node) return;
    const active = document.hasFocus() && document.visibilityState === 'visible'
      && (document.activeElement === node || !!document.activeElement?.closest('[data-prediction-accept]')
        && document.activeElement.closest('[data-prediction-accept]')?.getAttribute('data-prediction-instance') === controller.current?.composerInstanceId);
    controller.current?.update({ workspaceId: value.workspaceId, conversationId: value.conversationId, surface: value.surface,
      text: node.value, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd,
      contextVersion: value.contextVersion, quoteMessageId: value.quoteMessageId,
      eligible: value.eligible && settings.enabled && !settings.disabledWorkspaceIds.includes(value.workspaceId)
        && (!node.value || settings.continuationEnabled), active, composing: !!composition.current });
  }
  function apply(value: ComposerEditValue) {
    pendingSelection.current = value;
    knownText.current = value.text;
    controller.current?.invalidate();
    current.current.setText(value.text);
  }
  useLayoutEffect(() => {
    const pending = pendingSelection.current, node = options.textareaRef.current;
    if (pending && node && node.value === pending.text) { node.setSelectionRange(pending.start, pending.end); pendingSelection.current = null; }
    if (node && options.text !== knownText.current) { history.current.reset(read(node)); knownText.current = options.text; }
  }, [options.text, options.textareaRef]);
  useEffect(() => {
    const node = options.textareaRef.current;
    if (!node) return;
    history.current.reset(read(node));
    const instance = createInputPredictionController({
      port: { request: request => clientApi.inputPredictionRequest(request), cancel: ref => clientApi.inputPredictionCancel(ref),
        validate: ref => clientApi.inputPredictionValidate(ref) },
      createId: () => crypto.randomUUID(),
      apply(text, input: PredictionInput) {
        const editor = current.current.textareaRef.current;
        if (!editor || editor.value !== input.text || composition.current) return;
        const next = { text, start: text.length, end: text.length };
        history.current.record(read(editor), next, 'prediction');
        apply(next);
      },
    });
    controller.current = instance;
    const unsubscribe = instance.subscribe(() => { presented.current = false; setPresented(false); setView(instance.getSnapshot()); });
    const beforeInput = (event: Event) => {
      const input = event as InputEvent;
      if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
        const value = input.inputType === 'historyUndo' ? history.current.undo(node.value) : history.current.redo(node.value);
        event.preventDefault();
        if (value) { controller.current?.suppressDraft(value.text); apply(value); }
      } else before.current = read(node);
    };
    const start = () => { composition.current = read(node); sync(); };
    const end = () => {
      if (composition.current) history.current.record(composition.current, read(node), 'composition');
      composition.current = null; before.current = read(node); sync();
    };
    const focus = () => { void inputPredictionPreferences.refresh(); sync(); };
    const blur = () => { queueMicrotask(sync); };
    node.addEventListener('beforeinput', beforeInput); node.addEventListener('compositionstart', start);
    node.addEventListener('compositionend', end); node.addEventListener('select', sync);
    node.addEventListener('focus', focus); node.addEventListener('blur', blur);
    document.addEventListener('selectionchange', sync); document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', focus); window.addEventListener('blur', sync);
    void inputPredictionPreferences.refresh(); sync();
    return () => {
      unsubscribe(); instance.dispose(); if (controller.current === instance) controller.current = null;
      node.removeEventListener('beforeinput', beforeInput); node.removeEventListener('compositionstart', start);
      node.removeEventListener('compositionend', end); node.removeEventListener('select', sync);
      node.removeEventListener('focus', focus); node.removeEventListener('blur', blur);
      document.removeEventListener('selectionchange', sync); document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', focus); window.removeEventListener('blur', sync);
    };
  }, [options.workspaceId, options.conversationId, options.surface]);
  useEffect(sync, [options.text, options.contextVersion, options.eligible, options.quoteMessageId, preferences]);
  return {
    view, isPresented, textareaRef: options.textareaRef,
    markPresented(value: boolean) { presented.current = value; setPresented(value); },
    onChange(event: ChangeEvent<HTMLTextAreaElement>) {
      const node = event.currentTarget;
      knownText.current = node.value;
      if (!composition.current) history.current.record(before.current ?? { text: current.current.text,
        start: current.current.text.length, end: current.current.text.length }, read(node),
        (event.nativeEvent as InputEvent).inputType === 'insertText' ? 'typing' : 'edit');
      before.current = null; controller.current?.invalidate(); current.current.setText(node.value); sync();
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (isImeKey(event.nativeEvent)) return false;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        const value = event.shiftKey ? history.current.redo(event.currentTarget.value) : history.current.undo(event.currentTarget.value);
        event.preventDefault(); event.stopPropagation();
        if (value) { controller.current?.suppressDraft(value.text); apply(value); }
        return true;
      }
      if (event.key === 'Enter') { controller.current?.invalidate(); return false; }
      if (event.key === 'Escape' && view.candidate) { event.preventDefault(); event.stopPropagation(); controller.current?.dismiss(); return true; }
      if (event.key !== 'Tab' && event.key !== 'ArrowRight') return false;
      if (event.repeat || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !presented.current || view.status !== 'visible') return false;
      if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd || event.currentTarget.selectionEnd !== event.currentTarget.value.length) return false;
      event.preventDefault(); event.stopPropagation(); void controller.current?.accept(); return true;
    },
    editText(text: string) {
      const node = current.current.textareaRef.current;
      const next = { text, start: text.length, end: text.length };
      if (node) history.current.record(read(node), next, 'edit');
      apply(next);
    },
    accept() { if (presented.current) void controller.current?.accept(); },
    invalidate() { controller.current?.invalidate(); },
  };
}
