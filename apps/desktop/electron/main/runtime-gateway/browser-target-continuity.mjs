/** Identity policy around asynchronous reveal. No execution, Registry mutation, or fallback here. */
export function browserTargetContinuity({ captured, current, reveal, revealFailure }) {
  if (captured?.surface !== 'native' && current?.surface !== 'native' && !reveal?.windowId) return { pinned: false };
  if (revealFailure || current?.available === false) return { pinned: true, reason: 'browser_instance_unavailable' };
  if (captured?.surface === 'native' && (!current || captured.windowId !== current.windowId || captured.generation !== current.generation || captured.webContentsId !== current.webContentsId)) return { pinned: true, reason: 'browser_target_changed' };
  if (reveal?.windowId && (current?.windowId !== reveal.windowId || current?.generation !== reveal.generation)) return { pinned: true, reason: 'browser_target_changed' };
  return { pinned: true };
}
