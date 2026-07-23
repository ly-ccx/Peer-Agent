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
    return (
      <textarea
        ref={ref}
        backgroundColor={COLOR.inputBackground}
        textColor={COLOR.inputForeground}
        placeholderColor={COLOR.inputPlaceholder}
        selectionBg={COLOR.inputSelectionBackground}
        selectionFg={COLOR.inputSelectionForeground}
        cursorColor={COLOR.inputCursor}
        {...props}
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
