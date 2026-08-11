export interface MessageTargetRetryOptions<T> {
  readonly findTarget: () => T | null;
  readonly scheduleFrame: (callback: () => void) => void;
  readonly isActive: () => boolean;
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 12;

/**
 * Wait for a virtualized message target to mount before applying precise navigation.
 * A newer navigation request can cancel the wait through isActive.
 */
export function findMessageTargetWithRetry<T>({
  findTarget,
  scheduleFrame,
  isActive,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: MessageTargetRetryOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    let attempt = 0;

    const inspect = () => {
      if (!isActive()) {
        resolve(null);
        return;
      }

      const target = findTarget();
      if (target) {
        resolve(target);
        return;
      }

      attempt += 1;
      if (attempt >= maxAttempts) {
        resolve(null);
        return;
      }
      scheduleFrame(inspect);
    };

    inspect();
  });
}
