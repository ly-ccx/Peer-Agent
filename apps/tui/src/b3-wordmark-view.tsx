import {
  renderB3Wordmark,
  type B3ColorRole,
  type B3TerminalLine,
  type B3TerminalVariant,
} from './b3-wordmark.ts';
import { COLOR } from './tui-theme.ts';

/**
 * Map wordmark roles onto the live Frost palette so light mode uses dark ink
 * and dark mode keeps the original light glyphs.
 */
export function resolveB3WordmarkColor(role: B3ColorRole): string {
  switch (role) {
    case 'primary':
      return COLOR.text;
    case 'signal':
      return COLOR.info;
    case 'muted':
      return COLOR.muted;
  }
}

function colorForRole(role: B3ColorRole | undefined): string | undefined {
  return role ? resolveB3WordmarkColor(role) : undefined;
}

function B3WordmarkLine({ line }: { readonly line: B3TerminalLine }) {
  return (
    <text>
      {line.segments.map((segment, index) => (
        <span
          key={`${index}:${segment.text}`}
          fg={colorForRole(segment.fg)}
          bg={colorForRole(segment.bg)}
        >
          {segment.text}
        </span>
      ))}
    </text>
  );
}

export function B3Wordmark({ variant }: { readonly variant: B3TerminalVariant }) {
  const wordmark = renderB3Wordmark(variant);

  return (
    <box
      width={wordmark.width}
      height={wordmark.height}
      flexDirection="column"
      alignItems="flex-start"
    >
      {wordmark.lines.map((line, index) => (
        <B3WordmarkLine key={`${variant}:${index}`} line={line} />
      ))}
    </box>
  );
}
