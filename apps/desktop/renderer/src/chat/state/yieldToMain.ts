/**
 * 把控制权交还浏览器一帧，避免长同步任务卡住滚动/点击。
 * 优先 scheduler.yield；否则用 setTimeout(0)。
 */
export async function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 按批处理数组，每批结束后让出主线程。
 * 用于会话 hydrate：parseSerializedToolSegments / migrateToSegments 可能很重。
 */
export async function mapInChunks<T, R>(
  items: readonly T[],
  mapFn: (item: T, index: number) => R,
  options?: {
    readonly chunkSize?: number;
    readonly yieldFn?: () => Promise<void>;
  },
): Promise<R[]> {
  const chunkSize = Math.max(1, options?.chunkSize ?? 40);
  const yieldFn = options?.yieldFn ?? yieldToMain;
  const out: R[] = [];
  for (let index = 0; index < items.length; index += 1) {
    out.push(mapFn(items[index]!, index));
    const finished = index + 1;
    if (finished < items.length && finished % chunkSize === 0) {
      await yieldFn();
    }
  }
  return out;
}
