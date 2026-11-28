export interface ProviderMenuPlacement {
  readonly below: boolean;
  readonly alignBottom: boolean;
  readonly top?: number;
  readonly maxHeight?: number;
}

/** Keep the provider submenu inside the viewport; align flush with the panel bottom when opening near the bottom edge. */
export function positionProviderMenu(
  panel: { readonly left: number; readonly top: number; readonly bottom: number; readonly height: number },
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  options: { readonly embedded?: boolean; readonly margin?: number; readonly gap?: number; readonly maxHeight?: number } = {},
): ProviderMenuPlacement {
  if (options.embedded) return { below: true, alignBottom: false };
  const margin = options.margin ?? 12;
  const gap = options.gap ?? 6;
  const maxAllowed = Math.min(options.maxHeight ?? 280, Math.max(96, viewport.height - margin * 2));
  const menuWidth = menu.width > 0 ? menu.width : 220;
  const menuHeight = Math.min(Math.max(0, menu.height), maxAllowed);

  const fitsLeft = panel.left >= menuWidth + gap + margin;
  if (!fitsLeft) {
    const belowTop = panel.top + 44;
    const spaceBelow = viewport.height - margin - belowTop;
    if (spaceBelow >= Math.min(menuHeight, 160) || spaceBelow >= panel.top - margin) {
      return {
        below: true,
        alignBottom: false,
        top: 44,
        maxHeight: Math.min(maxAllowed, Math.max(96, spaceBelow)),
      };
    }
    const availableAbove = Math.max(96, panel.top - margin);
    const height = Math.min(menuHeight, Math.min(maxAllowed, availableAbove));
    return {
      below: true,
      alignBottom: true,
      top: Math.max(margin, panel.top - gap - height) - panel.top,
      maxHeight: Math.min(maxAllowed, availableAbove),
    };
  }

  const preferredViewportTop = panel.top + 6;
  if (preferredViewportTop + menuHeight <= viewport.height - margin) {
    return {
      below: false,
      alignBottom: false,
      top: 6,
      maxHeight: maxAllowed,
    };
  }

  const targetViewportBottom = Math.min(panel.bottom, viewport.height - margin);
  let viewportTop = targetViewportBottom - menuHeight;
  if (viewportTop < margin) {
    viewportTop = Math.max(margin, viewport.height - margin - menuHeight);
  }
  const availableHeight = Math.max(96, viewport.height - margin - viewportTop);
  return {
    below: false,
    alignBottom: true,
    top: viewportTop - panel.top,
    maxHeight: Math.min(maxAllowed, availableHeight),
  };
}
