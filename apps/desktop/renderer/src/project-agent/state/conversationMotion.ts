/** Registered CSS time properties may be serialized as seconds by the browser. */
export function motionDurationMs(value: string, fallback = 200): number {
  const time = value.trim();
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(time);
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : fallback;
}

/** RAF can supply a frame timestamp just before the layout effect started. */
export function sendScrollProgress(now: number, started: number, duration: number): number {
  const progress = duration > 0 ? Math.max(0, Math.min(1, (now - started) / duration)) : 1;
  return 1 - (1 - progress) ** 3;
}
