type Key = { readonly key: string; readonly keyCode?: number; readonly isComposing?: boolean; readonly target?: EventTarget | null };
const composing = new WeakSet<EventTarget>();
const held = new WeakSet<EventTarget>();
export function isImeKey(event: Key): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.key === 'Process'
    || Boolean(event.target && (composing.has(event.target) || (event.key === 'Enter' && held.has(event.target))));
}
/** A physical composition Enter stays consumed until keyup; there is no timed swallow window. */
export function createCompositionGuard() {
  let target: EventTarget | null = null;
  return {
    start(node: EventTarget) { target = node; composing.add(node); },
    end(node: EventTarget) { composing.delete(node); },
    keyDown(event: Key) {
      if (event.target && isImeKey(event)) {
        target = event.target;
        if (event.key === 'Enter' || event.keyCode === 229) held.add(event.target);
        return true;
      }
      if (event.target && event.key !== 'Enter') held.delete(event.target);
      return false;
    },
    keyUp(event: Key) { if (event.target && (event.key === 'Enter' || event.keyCode === 229)) held.delete(event.target); },
    reset() { if (target) { composing.delete(target); held.delete(target); } target = null; },
    active() { return Boolean(target && composing.has(target)); },
  };
}
