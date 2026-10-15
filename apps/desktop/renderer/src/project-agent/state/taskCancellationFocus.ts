/** Preserve keyboard focus until the host fact actually removes the cancel action. */
export function taskCancellationFocus(trigger: HTMLButtonElement): (accepted: boolean) => void {
  const document = trigger.ownerDocument;
  if (document.activeElement !== trigger) return () => {};
  const detail = trigger.closest('.bot-task-detail');
  const returnTo = detail?.querySelector<HTMLElement>('.bot-task-back')
    ?? trigger.closest('.bot-work-row')?.querySelector<HTMLElement>('summary');
  let accepted = false;
  let disposed = false;
  const observer = new MutationObserver(restore);
  function dispose() {
    disposed = true;
    observer.disconnect();
    document.removeEventListener('focusin', moved);
  }
  function moved(event: FocusEvent) {
    if (event.target !== trigger && event.target !== document.body) dispose();
  }
  function restore() {
    if (disposed || !accepted || trigger.isConnected) return;
    dispose();
    if (document.activeElement !== document.body) return;
    // Closing the drawer must not move focus into the background conversation.
    const target = returnTo?.isConnected ? returnTo : detail ? null
      : document.querySelector<HTMLElement>('.bot-background-work > summary, .bot-composer textarea');
    if (target?.getClientRects().length && !target.closest('[inert]')) target.focus({ preventScroll: true });
  }
  document.addEventListener('focusin', moved);
  observer.observe(document.body, { childList: true, subtree: true });
  return result => {
    accepted = result;
    if (!accepted) dispose();
    else restore();
  };
}
