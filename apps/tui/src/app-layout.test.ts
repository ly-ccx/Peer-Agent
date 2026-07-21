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
      appSource.indexOf('function ModelPickerMenu'),
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

  test('wires resume picker keyboard selection, resume and escape close', () => {
    const keyboardSource = appSource.slice(
      appSource.indexOf('useKeyboard((key) => {'),
      appSource.indexOf('if (helpSurface) {'),
    );
    expect(keyboardSource).toContain('if (resumeSurface) {');
    expect(keyboardSource).toContain('moveTuiSurfaceSelection(current.surface, -1, resumeItems.length)');
    expect(keyboardSource).toContain('moveTuiSurfaceSelection(current.surface, 1, resumeItems.length)');
    expect(keyboardSource).toContain('resumeTuiConversation(controller, persistence, conversation)');
    expect(keyboardSource).toContain("key.name === 'escape'");
    expect(keyboardSource).toContain("key.name === 'return' || key.name === 'enter'");
  });

  test('keeps the composer input pure and places controls above and status below', () => {
    expect(appSource).toContain('placeholder={composerPlaceholder(locale, disabled)}');
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );
    expect(dockSource).toContain('<ComposerControlsBar status={status} layout={statusLayout} />');
    expect(dockSource).toContain('<ComposerStatusBar status={status} layout={statusLayout} />');
    const controlsAt = dockSource.indexOf('<ComposerControlsBar status={status} layout={statusLayout} />');
    const inputAt = dockSource.indexOf('<Composer\n');
    const statusAt = dockSource.indexOf('<ComposerStatusBar status={status} layout={statusLayout} />');
    expect(controlsAt).toBeGreaterThanOrEqual(0);
    expect(inputAt).toBeGreaterThan(controlsAt);
    expect(statusAt).toBeGreaterThan(inputAt);
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
    expect(dockSource.indexOf('<SlashCommandMenu')).toBeLessThan(dockSource.indexOf('<Composer\n'));
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
    expect(appSource).toContain('<ErrorBanner message={snapshot.error} layout={layout} />');
    expect(appSource).toContain('const menuReserve = slashOpen');
    expect(appSource).toContain('paddingTop={menuReserve}');
  });

  test('makes chat history text selectable and copies active selection on Ctrl/Cmd+C', () => {
    const chatHistorySource = appSource.slice(
      appSource.indexOf('function ChatHistory'),
      appSource.indexOf('function ErrorBanner'),
    );
    expect(chatHistorySource).toContain('selectable');
    expect(appSource).toContain('useSelectionHandler');
    expect(appSource).toContain("control === 'copy-selection'");
    expect(appSource).toContain('copyTextToClipboard');
    expect(appSource).toContain('renderer.copyToClipboardOSC52');
    expect(appSource).toContain('hasSelection');
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
    expect(modelPickerSource).toContain('<strong>{title}</strong>');
    // Group chips must wrap so later providers are not clipped off-screen.
    expect(modelPickerSource).toContain('wrapMode="word"');
    // Active group should stand out with accent color + bold brackets.
    expect(modelPickerSource).toContain('fg={active ? PICKER_CHROME.selectedForeground : PICKER_CHROME.mutedForeground}');
    expect(modelPickerSource).toContain('<strong>[{group}]</strong>');
    expect(dockSource).toContain('<ModelPickerMenu');
    expect(dockSource.indexOf('<ModelPickerMenu')).toBeLessThan(dockSource.indexOf('<Composer\n'));
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

  test('shows one shared three-level responsive composer chrome in welcome and conversation layouts', () => {
    expect(appSource).toContain('const composerStatusLayout: ComposerStatusLayout = terminal.width >= 160');
    expect(appSource).toContain(': terminal.width >= 72');
    expect(appSource).toContain("? 'wide'");
    expect(appSource).toContain("? 'compact'");
    expect(appSource).toContain(": 'narrow';");
    expect(appSource.match(/<ComposerDock/g)?.length).toBe(2);
    expect(statusViewSource).toContain("if (layout === 'narrow')");
    expect(statusViewSource).toContain("short={layout === 'compact'}");
    expect(statusViewSource).toContain('flexDirection="column"');
  });

  test('renders wide controls above and wide status below as non-wrapping text flows', () => {
    const controlsSource = statusViewSource.slice(
      statusViewSource.indexOf('export function ComposerControlsBar'),
      statusViewSource.indexOf('export function ComposerStatusBar'),
    );
    const wideControlsSource = controlsSource.slice(controlsSource.lastIndexOf('return ('));
    const statusSource = statusViewSource.slice(statusViewSource.indexOf('export function ComposerStatusBar'));
    const wideStatusSource = statusSource.slice(statusSource.lastIndexOf('return ('));

    expect(wideControlsSource).toContain('justifyContent="space-between"');
    expect(wideControlsSource.match(/<text /g)?.length).toBe(2);
    expect(wideControlsSource).toContain('<StatusPair label="mode" value={status.mode} accent />');
    expect(wideControlsSource).toContain('value={layout === \'compact\' ? status.permissionShort : status.permission}');
    expect(wideControlsSource).toContain('<StatusPair label="workspace" value={workspaceValue} />');
    expect(wideStatusSource).toContain('justifyContent="space-between"');
    expect(wideStatusSource.match(/<text /g)?.length).toBe(2);
    expect(wideStatusSource).toContain('{status.model}');
    expect(wideStatusSource).toContain('{status.reasoning}');
    expect(wideStatusSource).toContain('<ContextStatus status={status} short={layout === \'compact\'} />');
    expect(wideStatusSource).not.toContain('label="workspace"');
    expect(wideStatusSource).not.toContain('label="mode"');
    expect(wideStatusSource).not.toContain('label="access"');
  });

  test('adapts picker density and keeps approval choices on separate rows', () => {
    expect(appSource).toContain('const layout = responsiveLayout(terminal.width)');
    expect(appSource).toContain('<box flexDirection="column" gap={0} flexShrink={0}>');
    expect(appSource).toContain('Action  {details.action}');
    expect(appSource).toContain('Where   {details.location}');
    expect(appSource).toContain('Reason  {details.reason}');
    expect(appSource).toContain('selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle');
    expect(appSource).toContain('{option.shortcut}. {option.label}');
    expect(appSource).toContain('pickerLayout.showDescriptions ?');
    expect(appSource).toContain('pickerLayout.showHints ?');
    expect(appSource).toContain('paddingLeft={layout.outerPadding}');
    expect(appSource).toContain('<ChatHistory snapshot={snapshot} layout={layout} />');
    expect(appSource).toContain('paddingRight={layout.outerPadding}');
    expect(appSource).toContain('paddingTop={layout.outerPaddingY}');
    expect(appSource).toContain('paddingBottom={layout.outerPaddingY}');
    expect(appSource).not.toContain('paddingLeft={2}');
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

  test('covers mode/access above with workspace right, model/context below, and no top bar', () => {
    expect(statusViewSource).toContain('export function ComposerControlsBar');
    expect(statusViewSource).toContain('export function ComposerStatusBar');
    expect(statusViewSource).not.toContain('export function WorkspaceTopBar');
    expect(statusViewSource).toContain('label="mode"');
    expect(statusViewSource).toContain('label="access"');
    expect(statusViewSource).toContain('label="workspace"');
    expect(statusViewSource).toContain('justifyContent="space-between"');
    expect(statusViewSource).toContain('{status.model}');
    expect(statusViewSource).toContain('{status.reasoning}');
    expect(statusViewSource).toContain('short ? status.contextShort : status.context');
    expect(appSource).not.toContain('<WorkspaceTopBar');
    expect(appSource).toContain('<ComposerControlsBar status={status} layout={statusLayout} />');
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
    expect(appSource).toContain('resolveToolPresentation(message)');
    expect(appSource).toContain('toolStatusGlyph(presentation.status)');
    expect(appSource).toContain('toolHeadline(presentation.toolName, presentation.argumentSummary)');
    expect(appSource).toContain('index === 0 ? TOOL_CHROME.branchFirst : TOOL_CHROME.branchRest');
    expect(appSource).toContain('toolStatusColor(presentation.status)');
    expect(appSource).not.toContain("{toolExpanded ? '▼' : '▶'} tool");
    expect(appSource).not.toContain("message.role === 'user' ? 'You'");
    expect(appSource).not.toContain('<strong>peer</strong>');
    expect(appSource).not.toContain('show details');
  });

  test('uses the shared theme module for chrome colors and picker selection', () => {
    expect(appSource).toContain("from './tui-theme.ts'");
    expect(appSource).toContain('PICKER_CHROME.selectedBackground');
    expect(appSource).toContain('PICKER_CHROME.selectedForeground');
    expect(appSource).toContain('PICKER_CHROME.caretSelected');
    expect(statusViewSource).toContain("from './tui-theme.ts'");
    expect(statusViewSource).toContain('contextUsageColor(status.contextPercent, COLOR.muted)');
  });

  test('renders the help picker opened by /help', () => {
    expect(appSource).toContain("experience.surface.picker === 'help'");
    expect(appSource).toContain('buildTuiHelpSections({ goalStatus }, locale)');
    expect(appSource).toContain('<strong>Help</strong>');
    expect(appSource).toContain('helpSections.map((section)');
  });

  test('does not restore the old central instructions or standalone footer', () => {
    expect(appSource).not.toContain('What do you want to build?');
    expect(appSource).not.toContain('Ask a question, inspect a project, or describe a task.');
    expect(appSource).not.toContain('Type / for commands and modes.');
    expect(appSource).not.toContain('ctrl+p commands  ·  ctrl+c');
  });

  test('every bordered box uses rounded borders', () => {
    const lines = appSource.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!/\bborder\b/.test(line) || /borderStyle|borderColor|COLOR\.border/.test(line)) continue;
      // standalone `border` prop line — next few lines must declare rounded style
      const window = lines.slice(i, i + 4).join('\n');
      expect(window).toContain('borderStyle="rounded"');
    }
    // inline `border borderColor` without style should not exist
    expect(appSource).not.toMatch(/\bborder\s+borderColor=/);
  });


});

describe('TUI compact progress and separator rendering', () => {
  test('ChatHistory renders system compact progress and done separators', () => {
    expect(appSource).toContain("if (message.role === 'system')");
    expect(appSource).toContain("phase === 'progress' ? 'COMPACTING' : 'COMPACTED'");
    expect(appSource).toContain("compactContext: async () => (await controller.compact()).notice");
  });
});