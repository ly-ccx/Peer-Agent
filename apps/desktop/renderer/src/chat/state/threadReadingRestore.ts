import { findMessageTargetWithRetry } from './messageNavigation';
export interface ThreadScrollSnapshot {
  readonly top: number; readonly atBottom: boolean; readonly turnId: string | null; readonly turnOffset: number;
}
/** Rebind a saved viewport to a real turn; interrupted/obsolete navigation cannot apply later. */
export function restoreThreadReading(input: {
  container: HTMLElement; snapshot: ThreadScrollSnapshot; locateTurn: (id: string) => void;
  isActive: () => boolean; finish: () => void;
}) {
  let active = true;
  if (input.snapshot.turnId) input.locateTurn(input.snapshot.turnId);
  void findMessageTargetWithRetry({
    findTarget: () => input.snapshot.turnId ? input.container.querySelector<HTMLElement>(`[data-chat-turn-id="${CSS.escape(input.snapshot.turnId)}"]`) : input.container,
    scheduleFrame: requestAnimationFrame,
    isActive: () => active && input.isActive(),
  }).then(target => {
    if (!active || !input.isActive()) return;
    input.container.scrollTop = target && input.snapshot.turnId ? target.offsetTop + input.snapshot.turnOffset : input.snapshot.top;
    input.finish();
  });
  return () => { active = false; };
}
