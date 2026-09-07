export const DROPDOWN_MENU_GAP = 4;
export const DROPDOWN_MENU_MARGIN = 8;

export interface DropdownBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface DropdownPlacementInput {
  readonly trigger: DropdownBox & { readonly width: number };
  readonly menu: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly preferredPlacement: 'down' | 'up';
  readonly gap?: number;
  readonly margin?: number;
  readonly occluders?: readonly DropdownBox[];
}

export interface DropdownPlacement {
  readonly left: number;
  readonly top: number;
  readonly placement: 'down' | 'up';
}

export interface DropdownOccluderStyle {
  readonly visibility: string;
  readonly display: string;
}

function overlapsY(a: { top: number; bottom: number }, b: { top: number; bottom: number }): boolean {
  return a.top < b.bottom && a.bottom > b.top;
}

function resolvePlacement(input: DropdownPlacementInput, gap: number): 'down' | 'up' {
  const menuH = input.menu.height;
  const spaceBelow = input.viewport.height - input.trigger.bottom - gap;
  const spaceAbove = input.trigger.top - gap;
  let placement = input.preferredPlacement;
  if (placement === 'down' && spaceBelow < menuH && spaceAbove > spaceBelow) {
    return 'up';
  }
  if (placement === 'up' && spaceAbove < menuH && spaceBelow > spaceAbove) {
    return 'down';
  }
  return placement;
}

function rightBoundForMenu(
  input: DropdownPlacementInput,
  menuTop: number,
  menuBottom: number,
  margin: number,
): number {
  let rightBound = input.viewport.width - margin;
  for (const occluder of input.occluders ?? []) {
    if (occluder.right <= input.trigger.left) continue;
    if (!overlapsY({ top: menuTop, bottom: menuBottom }, occluder)) continue;
    rightBound = Math.min(rightBound, occluder.left - margin);
  }
  return rightBound;
}

/**
 * Place a portal dropdown against the trigger, then pull it left if it would
 * overflow the viewport or a native occluder such as a visible Electron webview.
 */
export function placeDropdownMenu(input: DropdownPlacementInput): DropdownPlacement {
  const gap = input.gap ?? DROPDOWN_MENU_GAP;
  const margin = input.margin ?? DROPDOWN_MENU_MARGIN;
  const placement = resolvePlacement(input, gap);
  const menuH = Math.max(0, input.menu.height);
  const menuW = Math.max(input.menu.width, input.trigger.width);
  const top = placement === 'down'
    ? input.trigger.bottom + gap
    : Math.max(gap, input.trigger.top - menuH - gap);
  const measuredBottom = top + Math.max(menuH, 1);
  const rightBound = rightBoundForMenu(input, top, measuredBottom, margin);
  const maxLeft = rightBound - menuW;
  let left = input.trigger.left;
  if (left + menuW > rightBound) {
    left = maxLeft;
  }
  // Prefer staying left of the occluder even if that means leaving the
  // viewport; clamping back to margin would slide the menu under a webview.
  left = Math.min(left, maxLeft);
  left = Math.max(Math.min(margin, maxLeft), left);
  return { left, top, placement };
}

export function isVisibleDropdownOccluder(
  box: { readonly width: number; readonly height: number },
  style: DropdownOccluderStyle,
): boolean {
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') {
    return false;
  }
  return box.width > 0 && box.height > 0;
}

function hasHiddenAncestor(
  el: Element,
  computeStyle: (node: Element) => DropdownOccluderStyle,
): boolean {
  let node: Element | null = el.parentElement;
  while (node) {
    const style = computeStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function collectVisibleWebviewOccluders(
  doc: { querySelectorAll(selectors: string): ArrayLike<Element> } = document,
  computeStyle: (el: Element) => DropdownOccluderStyle = (el) => {
    const style = window.getComputedStyle(el);
    return { visibility: style.visibility, display: style.display };
  },
): DropdownBox[] {
  const nodes = doc.querySelectorAll('webview.browser-webview');
  const boxes: DropdownBox[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    const rect = el.getBoundingClientRect();
    if (!isVisibleDropdownOccluder(rect, computeStyle(el))) continue;
    if (hasHiddenAncestor(el, computeStyle)) continue;
    boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return boxes;
}
