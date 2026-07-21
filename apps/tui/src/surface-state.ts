export type TuiPickerKind = 'command' | 'mode' | 'model' | 'permission' | 'resume' | 'help' | 'language' | 'theme';

export type TuiSurface =
  | { readonly type: 'composer' }
  | { readonly type: 'slash-suggestions'; readonly query: string; readonly selectedIndex: number }
  | { readonly type: 'picker'; readonly picker: TuiPickerKind; readonly query: string; readonly selectedIndex: number }
  | { readonly type: 'fatal-error'; readonly message: string }
  | { readonly type: 'plan-approval'; readonly selectedIndex: number }
  | { readonly type: 'tool-approval'; readonly selectedIndex: number }
  | { readonly type: 'destructive-confirmation'; readonly actionId: string; readonly selectedIndex: number };

const PRIORITY: Readonly<Record<TuiSurface['type'], number>> = Object.freeze({
  composer: 0,
  'slash-suggestions': 1,
  picker: 2,
  'fatal-error': 3,
  'plan-approval': 4,
  'tool-approval': 5,
  'destructive-confirmation': 6,
});

export function createComposerSurface(): TuiSurface {
  return { type: 'composer' };
}

export function requestTuiSurface(current: TuiSurface, requested: TuiSurface): TuiSurface {
  return PRIORITY[requested.type] >= PRIORITY[current.type] ? requested : current;
}

export function dismissTuiSurface(surface: TuiSurface): TuiSurface {
  if (surface.type === 'tool-approval' || surface.type === 'destructive-confirmation') return surface;
  return createComposerSurface();
}

export function moveTuiSurfaceSelection(surface: TuiSurface, delta: number, itemCount: number): TuiSurface {
  if (!('selectedIndex' in surface) || itemCount <= 0) return surface;
  const selectedIndex = (surface.selectedIndex + delta + itemCount) % itemCount;
  return { ...surface, selectedIndex };
}
