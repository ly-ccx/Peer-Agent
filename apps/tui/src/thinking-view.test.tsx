import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { TextAttributes } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { ThinkingView } from './thinking-view.tsx';
import { COLOR } from './tui-theme.ts';

const renderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of renderers.splice(0)) setup.renderer.destroy();
});

function rgb(hexColor: string): number[] {
  const hex = hexColor.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

describe('ThinkingView', () => {
  test('renders a full-height rail and italic muted Markdown body below the label', async () => {
    const setup = await testRender(
      <ThinkingView content={'Inspecting **runtime events** before answering.\n\nChecking `tool output` next.'} />,
      { width: 72, height: 10 },
    );
    renderers.push(setup);
    await setup.flush();
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    const contentLines = frame.split('\n').filter((line) => line.trim());
    expect(contentLines).toHaveLength(4);
    expect(contentLines[0]).toContain('Thinking');
    expect(contentLines[0]).not.toContain('THINKING');
    expect(contentLines[0]).not.toContain('│');
    expect(contentLines.slice(1).every((line) => line.startsWith('│ '))).toBe(true);
    expect(frame).toContain('Inspecting runtime events before answering.');
    expect(frame).toContain('Checking tool output next.');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`tool output`');

    const bodySpans = setup.captureSpans().lines
      .flatMap((line) => line.spans)
      .filter((span) => span.text.includes('Inspecting') || span.text.includes('runtime events') || span.text.includes('Checking'));
    expect(bodySpans.length).toBeGreaterThan(0);
    expect(bodySpans.every((span) => span.fg.toInts().slice(0, 3).join(',') === rgb(COLOR.muted).join(','))).toBe(true);
    expect(bodySpans.every((span) => (span.attributes & TextAttributes.ITALIC) !== 0)).toBe(true);
  });

  test('renders a status-only thinking marker without empty body content', async () => {
    const setup = await testRender(<ThinkingView label="⠋ Thinking" />, { width: 40, height: 4 });
    renderers.push(setup);
    await setup.flush();
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain('⠋ Thinking');
    expect(setup.captureCharFrame()).not.toContain('│');
  });
});
