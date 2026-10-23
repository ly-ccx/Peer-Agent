import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { isImeKey } from '../../chat/state/compositionGuard';
import { interactionLayers, synchronizeModalBoundary } from '../components/interactionLayers';

let activeResize: (() => void) | null = null;

/** One reversible resize session: capture, frame coalescing, guest shield and all exit paths. */
export function usePointerResize() {
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  const start = useCallback((event: ReactPointerEvent<HTMLElement>, options: {
    onMove: (clientX: number) => void; onEnd: (committed: boolean) => void;
  }) => {
    if (event.button !== 0 || event.isPrimary === false) return false;
    activeResize?.(); event.preventDefault();
    const target = event.currentTarget, pointerId = event.pointerId;
    const before = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    const shield = document.createElement('div');
    shield.dataset.peerResizeShield = 'true'; shield.setAttribute('aria-hidden', 'true');
    Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'col-resize', pointerEvents: 'auto' });
    document.body.append(shield);
    const removeLayer = interactionLayers.add({ roots: () => [shield], trigger: target, modal: false });
    synchronizeModalBoundary();
    target.focus({ preventScroll: true });
    let frame = 0, latestX = event.clientX, done = false;
    const flush = () => { frame = 0; options.onMove(latestX); };
    const finish = (committed: boolean) => {
      if (done) return; done = true;
      if (frame) cancelAnimationFrame(frame);
      let accepted = false;
      try { if (committed) flush(); accepted = committed; }
      finally {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', abortPointer);
        window.removeEventListener('blur', abort);
        window.removeEventListener('keydown', key, true);
        target.removeEventListener('lostpointercapture', abort);
        try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch { /* capture unavailable */ }
        removeLayer(); shield.remove(); synchronizeModalBoundary();
        document.body.style.cursor = before.cursor; document.body.style.userSelect = before.userSelect;
        if (activeResize === abort) activeResize = null;
        if (cancel.current === abort) cancel.current = null;
        options.onEnd(accepted);
      }
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      latestX = next.clientX;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) { latestX = next.clientX; finish(true); } };
    const abort = () => finish(false);
    const abortPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) abort(); };
    const key = (next: KeyboardEvent) => {
      if (isImeKey(next)) return;
      if (next.key === 'Escape') { next.preventDefault(); next.stopImmediatePropagation(); abort(); }
      else if (next.key === 'Tab' || next.metaKey || next.ctrlKey) abort();
    };
    cancel.current = abort; activeResize = abort;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', abortPointer);
    window.addEventListener('blur', abort);
    window.addEventListener('keydown', key, true);
    target.addEventListener('lostpointercapture', abort);
    try { target.setPointerCapture(pointerId); } catch { /* the shield/window listeners still own the session */ }
    return true;
  }, []);
  return { start, cancel: () => cancel.current?.() };
}
