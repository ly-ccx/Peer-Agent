export { motionDurationMs } from '../../app/state/visualMotion.ts';

/** RAF can supply a frame timestamp just before the layout effect started. */
export function sendScrollProgress(now: number, started: number, duration: number): number {
  const progress = duration > 0 ? Math.max(0, Math.min(1, (now - started) / duration)) : 1;
  return 1 - (1 - progress) ** 3;
}
