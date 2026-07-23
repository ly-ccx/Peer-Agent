import { TextAttributes } from '@opentui/core';

import { MarkdownView } from './markdown-view.tsx';
import { ThemedText } from './themed-primitives.tsx';
import { COLOR } from './tui-theme.ts';

export function ThinkingView({
  content,
  label = 'Thinking',
}: {
  readonly content?: string;
  readonly label?: string;
}) {
  return (
    <box flexDirection="column" marginBottom={content ? 1 : 0}>
      <ThemedText selectable fg={COLOR.muted}>{label}</ThemedText>
      {content ? (
        <box
          flexDirection="column"
          border={['left']}
          borderColor={COLOR.subtle}
          paddingLeft={1}
          flexGrow={1}
          minWidth={0}
        >
          <MarkdownView content={content} tone="muted" textAttributes={TextAttributes.ITALIC} />
        </box>
      ) : null}
    </box>
  );
}
