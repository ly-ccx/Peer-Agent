import { describe, expect, test } from 'bun:test';

const appSource = await Bun.file(new URL('./app.tsx', import.meta.url)).text();

describe('TUI app layout', () => {
  test('centers the B3 Signal wordmark above the welcome composer', () => {
    expect(appSource).toContain('const isWelcome = snapshot.messages.length === 0');
    expect(appSource).toContain('justifyContent="center" alignItems="center"');
    expect(appSource).toContain('<B3Wordmark variant={wordmarkVariant} />');
    expect(appSource).not.toContain('<ascii-font');
    expect(appSource).not.toContain('wordmarkFont');
  });

  test('switches B3 terminal mappings at the approved width thresholds', () => {
    expect(appSource).toContain('const wordmarkVariant = terminal.width >= 76');
    expect(appSource).toContain(": terminal.width >= 42");
    expect(appSource).toContain("? 'full'");
    expect(appSource).toContain("? 'half'");
    expect(appSource).toContain(": 'narrow';");
  });

  test('gives the wordmark full available width without widening the composer', () => {
    expect(appSource).toContain('<box width="100%" flexDirection="column" alignItems="center" gap={2}>');
    expect(appSource).toContain('<box width="75%" maxWidth={88}>');
  });

  test('keeps the composer free of metadata and shortcut copy', () => {
    expect(appSource).toContain("placeholder={disabled ? 'Resolve the request above…' : 'Ask anything…'}");
    expect(appSource).not.toContain('metadata={composerMetadata}');
    expect(appSource).not.toContain('readonly metadata: string');
    expect(appSource).not.toContain('Ask anything…  / commands');
    expect(appSource).not.toContain('↵ send  ·  / commands');
  });

  test('does not restore the old central instructions or standalone footer', () => {
    expect(appSource).not.toContain('What do you want to build?');
    expect(appSource).not.toContain('Ask a question, inspect a project, or describe a task.');
    expect(appSource).not.toContain('Type / for commands and modes.');
    expect(appSource).not.toContain('ctrl+p commands  ·  ctrl+c');
  });
});
