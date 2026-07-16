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

  test('renders the composer with OpenTUI rounded corners without changing its height', () => {
    const composerSource = appSource.slice(
      appSource.indexOf('function Composer('),
      appSource.indexOf('function ComposerDock'),
    );

    expect(composerSource).toContain('borderStyle="rounded"');
    expect(composerSource).toContain('height={5}');
  });

  test('lets long chat history shrink and scroll without compressing the composer dock', () => {
    const historySource = appSource.slice(
      appSource.indexOf('function ChatHistory'),
      appSource.indexOf('function ErrorBanner'),
    );
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );

    expect(historySource).toContain('flexGrow={1}');
    expect(historySource).toContain('flexShrink={1}');
    expect(historySource).toContain('minHeight={0}');
    expect(historySource).toContain('stickyScroll');
    expect(dockSource).toContain('flexShrink={0}');
  });

  test('keeps an empty chat history spacer so the resume composer stays at the bottom', () => {
    const historySource = appSource.slice(
      appSource.indexOf('function ChatHistory'),
      appSource.indexOf('function ErrorBanner'),
    );

    expect(historySource).toContain('flexGrow={1}');
    expect(historySource).not.toContain('if (snapshot.messages.length === 0) return null');
  });

  test('docks the resume picker above the composer and windows rows around selection', () => {
    const resumeSource = appSource.slice(
      appSource.indexOf('function ResumePickerMenu'),
      appSource.indexOf('interface ModelPickerRow'),
    );

    expect(resumeSource).toContain('selectionWindow(rows, selectedIndex, maxVisible)');
    expect(resumeSource).toContain('visibleRows.map(({ item: row, index })');
    expect(resumeSource).toContain('flexShrink={0}');
    expect(resumeSource).not.toContain('position="absolute"');
    expect(resumeSource).not.toContain('bottom={5}');
    expect(resumeSource).not.toContain('rows.slice(0, 8)');
    expect(appSource.indexOf('<ResumePickerMenu'))
      .toBeLessThan(appSource.lastIndexOf('<ComposerDock'));
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

  test('keeps slash suggestions as a bounded overlay anchored above the composer', () => {
    const slashMenuSource = appSource.slice(
      appSource.indexOf('function SlashCommandMenu'),
      appSource.indexOf('function Composer('),
    );
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );

    expect(slashMenuSource).toContain('position="absolute"');
    expect(slashMenuSource).toContain('left={0}');
    expect(slashMenuSource).toContain('right={0}');
    expect(slashMenuSource).toContain('bottom={5}');
    expect(slashMenuSource).toContain('zIndex={100}');
    expect(slashMenuSource).toContain('flexDirection="row"');
    expect(slashMenuSource).toContain('height={1}');
    expect(dockSource).toContain('<box position="relative" width="100%" height={5} overflow="visible">');
    expect(dockSource).toContain('<SlashCommandMenu');
    expect(dockSource.indexOf('<SlashCommandMenu')).toBeLessThan(dockSource.indexOf('<Composer'));
    expect(appSource).toContain("experience.surface.type === 'slash-suggestions'");
    expect(appSource).toContain('slashMaxVisible={slashMaxVisible}');
    expect(appSource).toContain('slashMaxVisible={Math.min(3, slashMaxVisible)}');
    expect(appSource).toContain(': slashSurface');
    expect(appSource).toContain('? -Math.min(3, slashMaxVisible)');
    expect(appSource).toContain("layout.density === 'wide' || layout.density === 'compact'");
    expect(appSource).toContain("layout.density === 'narrow'");
    expect(appSource).not.toContain('shouldOpenCommandPanel');
    expect(appSource).not.toContain('{slashSurface ? (');
  });

  test('constrains long errors to a separate row so slash suggestions keep their reserved space', () => {
    const errorBannerSource = appSource.slice(
      appSource.indexOf('function ErrorBanner'),
      appSource.indexOf('function SlashCommandMenu'),
    );

    expect(errorBannerSource).toContain('<box height={1} flexShrink={0}');
    expect(errorBannerSource).toContain('wrapMode="none"');
    expect(appSource).toContain('<ErrorBanner message={snapshot.error} />');
    expect(appSource).toContain('const menuReserve = slashOpen');
    expect(appSource).toContain('paddingTop={menuReserve}');
  });

  test('auto-dismisses transient command notices and cancels superseded timers', () => {
    expect(appSource).toContain('const COMMAND_NOTICE_DURATION_MS = 3_000;');
    expect(appSource).toContain('if (!commandNotice) return;');
    expect(appSource).toContain(
      'const timeout = setTimeout(() => setCommandNotice(null), COMMAND_NOTICE_DURATION_MS);',
    );
    expect(appSource).toContain('return () => clearTimeout(timeout);');
    expect(appSource).toContain('}, [commandNotice]);');
  });

  test('keeps the model picker in the composer dock instead of restoring the top-level surface', () => {
    const modelPickerSource = appSource.slice(
      appSource.indexOf('function ModelPickerMenu'),
      appSource.indexOf('function Composer('),
    );
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );
    const appRenderSource = appSource.slice(appSource.indexOf('export function App'));

    expect(modelPickerSource).toContain('position="absolute"');
    expect(modelPickerSource).toContain('left={0}');
    expect(modelPickerSource).toContain('right={0}');
    expect(modelPickerSource).toContain('bottom={5}');
    expect(modelPickerSource).toContain('zIndex={100}');
    expect(modelPickerSource).toContain('<strong>Model &amp; reasoning</strong>');
    expect(dockSource).toContain('<ModelPickerMenu');
    expect(dockSource.indexOf('<ModelPickerMenu')).toBeLessThan(dockSource.indexOf('<Composer'));
    expect(dockSource).toContain('focused={!modelPickerOpen}');
    expect(appSource).toContain('focused={focused && !disabled}');
    expect(appSource.match(/modelPickerOpen=\{Boolean\(modelSurface\)\}/g)?.length).toBe(2);
    expect(appSource).toContain('|| Boolean(modelSurface)');
    expect(appSource).toContain('const welcomeModelMaxVisible =');
    expect(appSource).toContain('? 4');
    expect(appSource).toContain('modelPickerMaxVisible={welcomeModelMaxVisible}');
    expect(appSource).toContain('const welcomeModelVisibleRows = Math.min(welcomeModelMaxVisible');
    expect(appSource).toContain('top={modelSurface');
    expect(appSource).toContain('? -(welcomeModelVisibleRows + 2)');
    expect(appRenderSource).not.toContain('{modelSurface ? (');
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
  });

  test('renders the wide status as one non-wrapping text flow so long model names cannot overlap other fields', () => {
    const wideStatusSource = statusViewSource.slice(statusViewSource.lastIndexOf('return ('));

    expect(wideStatusSource.match(/<text /g)?.length).toBe(1);
    expect(wideStatusSource).toContain('<text fg={MUTED} wrapMode="none">');
    expect(wideStatusSource).not.toContain('justifyContent="space-between"');
    expect(wideStatusSource).toContain('<StatusPair label="workspace" value={status.workspace} />');
    expect(wideStatusSource).toContain('<StatusPair label="mode" value={status.mode} accent />');
    expect(wideStatusSource).toContain('<StatusPair label="access" value={status.permissionShort} />');
    expect(wideStatusSource).toContain('{status.model}');
    expect(wideStatusSource).toContain('{status.reasoning}');
    expect(wideStatusSource).toContain('<ContextStatus status={status} />');
  });

  test('adapts picker density and keeps approval choices on separate rows', () => {
    expect(appSource).toContain('const layout = responsiveLayout(terminal.width)');
    expect(appSource).toContain('<box flexDirection="column" gap={0} flexShrink={0}>');
    expect(appSource).toContain('Action  {details.action}');
    expect(appSource).toContain('Where   {details.location}');
    expect(appSource).toContain('Reason  {details.reason}');
    expect(appSource).toContain("{index === approvalSelection ? '▶' : ' '} {option.shortcut}. {option.label}");
    expect(appSource).toContain('pickerLayout.showDescriptions ?');
    expect(appSource).toContain('pickerLayout.showHints ?');
    expect(appSource).toContain('paddingLeft={layout.outerPadding}');
  });

  test('prevents short-terminal picker rows from collapsing onto each other', () => {
    const modePickerSource = appSource.slice(
      appSource.indexOf('{modeSurface ? ('),
      appSource.indexOf('{commandSurface ? ('),
    );
    const commandPickerSource = appSource.slice(
      appSource.indexOf('{commandSurface ? ('),
      appSource.indexOf('<ComposerDock', appSource.indexOf('{commandSurface ? (')),
    );

    expect(appSource).toContain('responsivePickerLayout(');
    expect(modePickerSource).toContain('height={pickerLayout.modePanelRows}');
    expect(modePickerSource).toContain('flexShrink={0}');
    expect(modePickerSource).toContain('pickerLayout.showDescriptions');
    expect(modePickerSource).toContain('pickerLayout.showHints');
    expect(commandPickerSource).toContain('commandWindow.map');
    expect(commandPickerSource).toContain('flexShrink={0}');
  });

  test('covers workspace, mode, permission, model, reasoning and context', () => {
    expect(statusViewSource).toContain('label="workspace"');
    expect(statusViewSource).toContain('label="mode"');
    expect(statusViewSource).toContain('label="access"');
    expect(statusViewSource).toContain('{status.model}');
    expect(statusViewSource).toContain('{status.reasoning}');
    expect(statusViewSource).toContain('status.contextShort : status.context');
    expect(appSource).toContain('host.setAccessLevel(nextPolicy)');
  });

  test('renders assistant content through the terminal-frame-tested Markdown view', () => {
    expect(appSource).toContain("import { MarkdownView } from './markdown-view.tsx'");
    expect(appSource).toContain("<MarkdownView content={message.content || ' '} />");
    expect(appSource).not.toContain('<markdown');
    expect(appSource).not.toContain('MARKDOWN_STYLE');
  });

  test('keeps user and tool messages visually distinct without repeated speaker headings', () => {
    expect(appSource).toContain('<strong>› </strong>');
    expect(appSource).toContain("{toolExpanded ? '▼' : '▶'} tool");
    expect(appSource).not.toContain("message.role === 'user' ? 'You'");
    expect(appSource).not.toContain('<strong>peer</strong>');
    expect(appSource).not.toContain('show details');
  });

  test('does not restore the old central instructions or standalone footer', () => {
    expect(appSource).not.toContain('What do you want to build?');
    expect(appSource).not.toContain('Ask a question, inspect a project, or describe a task.');
    expect(appSource).not.toContain('Type / for commands and modes.');
    expect(appSource).not.toContain('ctrl+p commands  ·  ctrl+c');
  });
});
