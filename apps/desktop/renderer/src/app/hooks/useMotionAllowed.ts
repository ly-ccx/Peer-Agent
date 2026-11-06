import { useSyncExternalStore } from 'react';
import { motionAllowed, subscribeMotionEnvironment } from '../state/motionEnvironment';
/** Preference/visibility changes interrupt running effects; restoring a page does not replay them. */
export function useMotionAllowed() {
  return useSyncExternalStore(subscribeMotionEnvironment, motionAllowed, () => false);
}
