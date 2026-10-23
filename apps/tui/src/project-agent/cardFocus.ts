import { isEnterKeyName } from '../runtime-controls.ts';

/** Presentation focus only. The existing card action path rechecks runtime authority. */
export function cardFocusIntent(key: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; eventType?: string; isComposing?: boolean }, focused: boolean, hasCards: boolean) {
  if (key.isComposing) return 'none';
  if (key.name === 'tab' && hasCards) return focused ? 'leave' : 'enter';
  if (!focused) return 'none';
  if (!hasCards || key.name === 'escape') return 'leave';
  if (['up', 'down'].includes(key.name)) return 'card';
  if (['left', 'right'].includes(key.name)) return 'option';
  if (isEnterKeyName(key.name) && (!key.eventType || key.eventType === 'press')) return 'act';
  const text = key.sequence ?? key.name;
  if (!key.ctrl && !key.meta && (!key.eventType || key.eventType === 'press')
    && Array.from(text).length === 1 && !/[\u0000-\u001f\u007f]/.test(text)) return 'type';
  return 'none';
}
