import { describe, expect, test } from 'bun:test';

const appSource = await Bun.file(new URL('./app.tsx', import.meta.url)).text();
const statusViewSource = await Bun.file(new URL('./composer-status-view.tsx', import.meta.url)).text();

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

  test('gives the wordmark full width while keeping the composer dock restrained', () => {
    expect(appSource).toContain('<box width="100%" flexDirection="column" alignItems="center" gap={2}>');
    expect(appSource).toContain('<box width={layout.welcomeWidth} maxWidth={112}>');
  });

  test('keeps the composer input pure and places status outside its border', () => {
    expect(appSource).toContain("placeholder={disabled ? 'Resolve the request above…' : 'Ask anything…'}");
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );
    expect(dockSource).toContain('<ComposerStatusBar status={status} layout={statusLayout} />');
    expect(dockSource.indexOf('<ComposerStatusBar status={status} layout={statusLayout} />'))
      .toBeGreaterThan(dockSource.indexOf('<Composer'));
    expect(appSource).not.toContain('metadata={composerMetadata}');
    expect(appSource).not.toContain('readonly metadata: string');
    expect(appSource).not.toContain('Ask anything…  / commands');
    expect(appSource).not.toContain('↵ send  ·  / commands');
  });

  test('shows one shared three-level responsive status bar in welcome and conversation layouts', () => {
    expect(appSource).toContain('const composerStatusLayout: ComposerStatusLayout = terminal.width >= 160');
    expect(appSource).toContain(': terminal.width >= 72');
    expect(appSource).toContain("? 'wide'");
    expect(appSource).toContain("? 'compact'");
    expect(appSource).toContain(": 'narrow';");
    expect(appSource.match(/<ComposerDock/g)?.length).toBe(2);
    expect(statusViewSource).toContain("if (layout === 'narrow')");
    expect(statusViewSource).toContain("if (layout === 'compact')");
    expect(statusViewSource).toContain('flexDirection="column"');
    expect(statusViewSource).toContain('justifyContent="space-between"');
  });

  test('adapts picker density and stacks approval actions on narrow terminals', () => {
    expect(appSource).toContain('const layout = responsiveLayout(terminal.width)');
    expect(appSource).toContain("flexDirection={layout.stackActions ? 'column' : 'row'}");
    expect(appSource).toContain('layout.showDescriptions ?');
    expect(appSource).toContain('layout.showHints ?');
    expect(appSource).toContain('paddingLeft={layout.outerPadding}');
  });

  test('covers workspace, mode, permission, model, reasoning and context', () => {
    expect(statusViewSource).toContain('label="workspace"');
    expect(statusViewSource).toContain('label="mode"');
    expect(statusViewSource).toContain('label="access"');
    expect(statusViewSource).toContain('{status.model}');
    expect(statusViewSource).toContain('{status.reasoning}');
    expect(statusViewSource).toContain('status.contextShort : status.context');
  });

  test('does not restore the old central instructions or standalone footer', () => {
    expect(appSource).not.toContain('What do you want to build?');
    expect(appSource).not.toContain('Ask a question, inspect a project, or describe a task.');
    expect(appSource).not.toContain('Type / for commands and modes.');
    expect(appSource).not.toContain('ctrl+p commands  ·  ctrl+c');
  });
});
