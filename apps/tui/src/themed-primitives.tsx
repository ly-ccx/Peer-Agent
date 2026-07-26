import { forwardRef } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import type { TextareaProps, TextProps } from '@opentui/react';

import { COLOR, type TuiPalette } from './tui-theme.ts';

/**
 * Theme-controlled OpenTUI text. Selection colors are mandatory even when the
 * text is not currently selectable, so adding `selectable` can never fall back
 * to terminal defaults.
 */
export function ThemedText(props: TextProps) {
  return (
    <text
      {...props}
      selectionBg={COLOR.textSelectionBackground}
      selectionFg={COLOR.textSelectionForeground}
    />
  );
}

/** Theme-controlled editable surface for the multiline composer. */
export const ThemedTextarea = forwardRef<TextareaRenderable, TextareaProps>(
  function ThemedTextarea(props, ref) {
    // Apply theme colors AFTER props so a live palette mutation always wins for
    // semantic input chrome. Callers may still override via props, but those
    // overrides must also be re-evaluated each render (no mount-only defaults).
    return (
      <textarea
        ref={ref}
        {...props}
        backgroundColor={props.backgroundColor ?? COLOR.inputBackground}
        textColor={props.textColor ?? COLOR.inputForeground}
        focusedTextColor={props.focusedTextColor ?? props.textColor ?? COLOR.inputForeground}
        placeholderColor={props.placeholderColor ?? COLOR.inputPlaceholder}
        selectionBg={props.selectionBg ?? COLOR.inputSelectionBackground}
        selectionFg={props.selectionFg ?? COLOR.inputSelectionForeground}
        cursorColor={props.cursorColor ?? COLOR.inputCursor}
      />
    );
  },
);

/** Semantic props for third-party/native controls that cannot use a wrapper. */
export function themedTextSelectionProps(palette: TuiPalette = COLOR) {
  return {
    selectionBg: palette.textSelectionBackground,
    selectionFg: palette.textSelectionForeground,
  } as const;
}

export function themedTextareaStateProps(palette: TuiPalette = COLOR) {
  return {
    backgroundColor: palette.inputBackground,
    textColor: palette.inputForeground,
    placeholderColor: palette.inputPlaceholder,
    selectionBg: palette.inputSelectionBackground,
    selectionFg: palette.inputSelectionForeground,
    cursorColor: palette.inputCursor,
  } as const;
}

// Compatibility aliases for native control adapters.
export const textSelectionThemeProps = themedTextSelectionProps;
export const inputThemeProps = themedTextareaStateProps;
