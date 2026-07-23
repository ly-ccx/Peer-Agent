import { describe, expect, test } from 'bun:test';

const appSource = await Bun.file(new URL('./app.tsx', import.meta.url)).text();
const statusViewSource = await Bun.file(new URL('./composer-status-view.tsx', import.meta.url)).text();
const goalStatusViewSource = await Bun.file(new URL('./goal-status-view.tsx', import.meta.url)).text();

describe('TUI app layout', () => {
  test('centers the B3 Signal wordmark above the welcome composer', () => {
    expect(appSource).toContain('const isWelcome = snapshot.messages.length === 0');
    expect(appSource).toContain('justifyContent="center" alignItems="center"');
    expect(appSource).toContain('<B3Wordmark variant={wordmarkVariant} />');
    expect(appSource).not.toContain('<ascii-font');
    expect(appSource).not.toContain('wordmarkFont');
  });

  test('keeps the CLI home visible for an empty session even when a Goal exists', () => {
    const welcomeCondition = appSource.match(/const isWelcome = [\s\S]*?isComposerSurface;/)?.[0] ?? '';

    expect(welcomeCondition).toContain('snapshot.messages.length === 0');
    expect(welcomeCondition).not.toContain('!sharedGoalPlan');
    expect(appSource).toContain("!isWelcome && goalView && goalLayout.mode === 'side-panel'");
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

  test('keeps composer input text readable with the active theme whether focused or not', () => {
    const composerSource = appSource.slice(
      appSource.indexOf('function Composer('),
      appSource.indexOf('function ComposerDock'),
    );

    expect(composerSource).toContain('textColor={COLOR.text}');
    expect(composerSource).toContain('focusedTextColor={COLOR.text}');
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
    expect(appSource).toContain('const resumed = resumeTuiConversation(controller, persistence, conversation);');
    expect(keyboardSource).toContain('handleResumeConversationSummary(resumeItems[resumeSurface.selectedIndex])');
    expect(appSource).toContain('focused={isComposerInputFocused}');
    expect(appSource).toContain('onMouseDown={() => onResume(row)}');
    expect(appSource).toContain('onResume={handleResumeConversationSummary}');
    expect(keyboardSource).toContain("key.name === 'escape'");
    expect(keyboardSource).toContain("key.name === 'return' || key.name === 'enter'");
  });


  test('renders assistant thinking/tool segments in event order instead of fixed thinking-then-tools', () => {
    const historyStart = appSource.indexOf('function ChatHistory');
    const historySource = appSource.slice(historyStart, historyStart + 12_000);
    expect(historySource).toContain('message.segments');
    expect(historySource).toContain("segment.type === 'thinking'");
    expect(historySource).toContain("segment.type === 'tool-call'");
    // Ordered map over segments, not a fixed thinking block followed by tools[] only.
    expect(historySource).toContain('segments.map((segment, segmentIndex)');
  });

  test('keeps the thinking status docked above composer and animates trailing dots quickly', () => {
    expect(appSource).toContain('const THINKING_SPINNER_INTERVAL_MS = 120;');
    const labelSource = appSource.slice(
      appSource.indexOf('function ThinkingStatusLabel'),
      appSource.indexOf('function ToolStatusGlyph'),
    );
    expect(labelSource).toContain('useStatusAnimationFrame(true, THINKING_SPINNER_INTERVAL_MS)');
    expect(labelSource).toContain('thinkingStatusLabel(frame, hasThinkingContent)');
  });

  test('renders pending thinking in chat history with the message timeline', () => {
    const historySource = appSource.slice(
      appSource.indexOf('function ChatHistory'),
      appSource.indexOf('function ErrorBanner'),
    );
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );

    expect(historySource).toContain('showThinkingPlaceholder ? (');
    expect(historySource).toContain('<ThinkingStatusLabel');
    expect(historySource).not.toContain('if (showThinkingPlaceholder) return null;');
    expect(dockSource).not.toContain('thinkingActive ? (');
    expect(dockSource).not.toContain('<ThinkingStatusLabel');
    expect(appSource).not.toContain('thinkingActive={dockThinkingActive}');
    expect(appSource).not.toContain('thinkingText={dockThinkingText}');
  });

  test('mounts a Qoder-style running status bar above the input', () => {
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );
    const runningLabelSource = appSource.slice(
      appSource.indexOf('function ComposerRunningStatusLabel'),
      appSource.indexOf('function ToolStatusGlyph'),
    );

    expect(statusViewSource).toContain('export function ComposerRunningStatusBar');
    expect(statusViewSource).toContain('export function ComposerModeDivider');
    expect(statusViewSource).not.toContain('cancelHint');
    expect(appSource).toContain('function ComposerRunningStatusLabel');
    expect(runningLabelSource).toContain('useStatusAnimationFrame(true, THINKING_SPINNER_INTERVAL_MS)');
    expect(runningLabelSource).toContain('thinkingSpinnerGlyph(frame)');
    expect(runningLabelSource).toContain('composerRunningStatusLabel(locale, runStatus)');
    expect(dockSource).toContain("snapshot.status === 'compacting' ? 'compacting'");
    expect(runningLabelSource).toContain("'compacting'");
    expect(runningLabelSource).not.toContain('composerEscToCancelHint');
    expect(runningLabelSource).not.toContain('cancelHint');
    expect(dockSource).toContain("snapshot.status !== 'idle'");
    expect(dockSource).toContain('<ComposerRunningStatusLabel');
    expect(dockSource).toContain('composerContentWidth(terminal.width, layout.outerPadding)');
    expect(dockSource).toContain('<ComposerModeDivider width={dividerWidth} />');
    expect(statusViewSource).not.toContain("{'─'.repeat(80)}");
    expect(statusViewSource).toContain("{'─'.repeat(cols)}");
    // Divider must only render with the running status (not when idle).
    const activeBlock = dockSource.slice(
      dockSource.indexOf("snapshot.status !== 'idle'"),
      dockSource.indexOf('<Composer\n'),
    );
    expect(activeBlock).toContain('<ComposerRunningStatusLabel');
    expect(activeBlock).toContain('<ComposerModeDivider width={dividerWidth} />');
    expect(activeBlock).toContain(') : null}');
    const runningAt = dockSource.indexOf('<ComposerRunningStatusLabel');
    const dividerAt = dockSource.indexOf('<ComposerModeDivider width={dividerWidth} />');
    const inputAt = dockSource.indexOf('<Composer\n');
    const statusAt = dockSource.indexOf('<ComposerStatusBar status={status} layout={statusLayout} />');
    expect(runningAt).toBeGreaterThanOrEqual(0);
    expect(dividerAt).toBeGreaterThan(runningAt);
    expect(inputAt).toBeGreaterThan(dividerAt);
    expect(statusAt).toBeGreaterThan(inputAt);
  });

  test('preserves typed composer draft when image paste reports a replacement value', () => {
    const composerSource = appSource.slice(
      appSource.indexOf('function Composer('),
      appSource.indexOf('function ComposerDock'),
    );
    expect(composerSource).toContain("const lastComposerValueRef = useRef('');");
    expect(composerSource).toContain('mergeImagePasteWithExistingDraft(rawValue, lastComposerValueRef.current)');
    expect(composerSource).toContain('lastComposerValueRef.current = chipped;');
    expect(composerSource).toContain("lastComposerValueRef.current = '';");
  });

  test('keeps the composer input pure and places status below the input', () => {
    expect(appSource).toContain('placeholder={composerPlaceholder(locale, disabled)}');
    const dockSource = appSource.slice(
      appSource.indexOf('function ComposerDock'),
      appSource.indexOf('export function App'),
    );
    expect(dockSource).not.toContain('ComposerControlsBar');
    expect(dockSource).toContain('<ComposerStatusBar status={status} layout={statusLayout} />');
    const inputAt = dockSource.indexOf('<Composer\n');
    const statusAt = dockSource.indexOf('<ComposerStatusBar status={status} layout={statusLayout} />');
    expect(inputAt).toBeGreaterThanOrEqual(0);
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

  test('allows long errors to wrap on a dedicated banner so slash suggestions keep their reserved space', () => {
    const errorBannerSource = appSource.slice(
      appSource.indexOf('function ErrorBanner'),
      appSource.indexOf('function SlashCommandMenu'),
    );

    expect(errorBannerSource).toContain('<box flexShrink={0}');
    expect(errorBannerSource).not.toContain('height={1}');
    expect(errorBannerSource).toContain('wrapMode="word"');
    expect(errorBannerSource).not.toContain('wrapMode="none"');
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

  test('auto-copies stable mouse selections and surfaces copy result notices', () => {
    expect(appSource).toContain('lastAutoCopiedTextRef');
    expect(appSource).toContain('selectionCopyTimerRef');
    expect(appSource).toContain('copySelectionText');
    expect(appSource).toContain('setCommandNotice(selectionCopyNotice(result, textToCopy.length))');
    expect(appSource).toContain('if (text === lastAutoCopiedTextRef.current) return;');
    expect(appSource).toContain('}, 180);');
  });

  test('insets transient notices with the responsive outer padding', () => {
    const noticeSource = appSource.slice(
      appSource.indexOf('{commandNotice && !commandSurface ? ('),
      appSource.indexOf('{permissionSurface ? ('),
    );

    expect(noticeSource).toContain('width="100%"');
    expect(noticeSource).toContain('paddingLeft={layout.outerPadding}');
    expect(noticeSource).toContain('paddingRight={layout.outerPadding}');
    expect(noticeSource).toContain('<text fg={COLOR.accent}>{commandNotice}</text>');
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

  test('renders footer statusbar as mode · access left and model + context right', () => {
    const statusSource = statusViewSource.slice(statusViewSource.indexOf('export function ComposerStatusBar'));
    const wideStatusSource = statusSource.slice(statusSource.lastIndexOf('return ('));

    expect(statusViewSource).not.toContain('ComposerControlsBar');
    expect(statusViewSource).not.toContain('label="lang"');
    expect(statusViewSource).not.toContain('label="workspace"');
    expect(statusViewSource).not.toContain('{status.reasoning}');
    expect(wideStatusSource).toContain('justifyContent="space-between"');
    expect(wideStatusSource.match(/<text /g)?.length).toBe(2);
    expect(wideStatusSource).toContain('<StatusPair label="mode" value={status.mode} accent />');
    expect(wideStatusSource).toContain('value={layout === \'compact\' ? status.permissionShort : status.permission}');
    expect(wideStatusSource).toContain('{status.model}');
    expect(wideStatusSource).toContain('<ContextStatus status={status} short={layout === \'compact\'} />');
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

  test('covers mode · access + model/context footer and keeps workspace out of the dock', () => {
    expect(statusViewSource).not.toContain('export function ComposerControlsBar');
    expect(statusViewSource).toContain('export function ComposerStatusBar');
    expect(statusViewSource).not.toContain('export function WorkspaceTopBar');
    expect(statusViewSource).toContain('label="mode"');
    expect(statusViewSource).toContain('label="access"');
    expect(statusViewSource).not.toContain('label="lang"');
    expect(statusViewSource).not.toContain('label="workspace"');
    expect(statusViewSource).toContain('justifyContent="space-between"');
    expect(statusViewSource).toContain('{status.model}');
    expect(statusViewSource).not.toContain('{status.reasoning}');
    expect(statusViewSource).toContain('const width = short ? 6 : 12;');
    expect(statusViewSource).toContain('contextMeterParts(status.contextPercent, width)');
    expect(appSource).not.toContain('<WorkspaceTopBar');
    expect(appSource).not.toContain('ComposerControlsBar');
    expect(appSource).toContain('<ComposerStatusBar status={status} layout={statusLayout} />');
    expect(appSource).toContain('host.setAccessLevel(nextPolicy)');
  });

  test('renders assistant content through the terminal-frame-tested Markdown view', () => {
    expect(appSource).toContain("import { MarkdownView } from './markdown-view.tsx'");
    expect(appSource).toContain('<MarkdownView content={message.content} />');
    expect(appSource).not.toContain('<markdown');
    expect(appSource).not.toContain('MARKDOWN_STYLE');
  });

  test('renders YOU/PEER lanes and a real tool activity timeline', () => {
    // YOU is a muted left rail label (not a highlighted title row).
    expect(appSource).toContain('<box width={7}><text fg={COLOR.muted}>YOU</text></box>');
    expect(appSource).not.toContain('<strong>YOU</strong>');
    expect(appSource).toContain('<strong>PEER</strong>');
    // Cyan bar sits on the user body column, not before the YOU label.
    expect(appSource).toContain('<text fg={COLOR.user}>{APP_CHROME.userRailBar}</text>');
    expect(appSource).toContain('function ToolActivityTimeline');
    expect(appSource).toContain('width={12}');
    expect(appSource).toContain('formatToolDuration(presentation)');
    expect(appSource).toContain('const summary = toolActivitySummary(presentation)');
    expect(appSource).toContain("{canExpand ? (expanded ? '−' : '+') : ' '}");
    expect(appSource).toContain('onMouseDown={canExpand ? onToggle : undefined}');
    expect(appSource).not.toContain('<box flexDirection="row" onMouseDown={onToggle}>');
    expect(appSource).toContain('>│ </text>');
    expect(appSource).toContain('toolStatusColor(presentation.status)');
    expect(appSource).toContain('resolveToolPresentation(message)');
    // Crush tool timeline: status glyph + kind label + summary + duration.
    expect(appSource).toContain('<ToolStatusGlyph status={presentation.status} />');
    expect(appSource).toContain('{presentation.toolName}');
    expect(appSource).toContain('{formatToolDuration(presentation)}');
    expect(appSource).not.toContain('backgroundColor={COLOR.userPanel}');
  });

  test('ChatHistory user messages render image attachments as visible chips', () => {
    const historyStart = appSource.indexOf('function ChatHistory');
    expect(historyStart).toBeGreaterThanOrEqual(0);
    // ToolStatusGlyph is defined before ChatHistory; slice forward from ChatHistory body.
    // Assistant segment rendering makes ChatHistory larger — keep user-message helpers in range.
    const historySource = appSource.slice(historyStart, historyStart + 12_000);
    expect(historySource).toContain('formatUserMessageBody');
    expect(historySource).toContain('message.images');
    expect(historySource).toContain('imageLabel');
    expect(appSource).toContain("attachment.images.length > 0 ? '' : attachment.displayContent");
  });

  test('uses the shared theme module for chrome colors and picker selection', () => {
    expect(appSource).toContain("from './tui-theme.ts'");
    expect(appSource).toContain('PICKER_CHROME.selectedBackground');
    expect(appSource).toContain('PICKER_CHROME.selectedForeground');
    expect(appSource).toContain('PICKER_CHROME.caretSelected');
    expect(statusViewSource).toContain("from './tui-theme.ts'");
    expect(statusViewSource).toContain('contextUsageColor(status.contextPercent)');
    expect(statusViewSource).toContain('contextMeterParts(status.contextPercent, width)');
    expect(statusViewSource).toContain('<span fg={color}>{filled}</span>');
    expect(statusViewSource).toContain('<span fg={COLOR.muted}>{empty}</span>');
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

  test('uses the main interaction area plus a right Goal status area without a persistent left navigation', () => {
    expect(appSource).toContain('<box flexDirection="row" width="100%" height="100%" gap={1}>');
    expect(appSource).toContain("goalLayout.mode === 'side-panel'");
    expect(appSource).toContain('<GoalStatusPanel view={goalView} width={goalLayout.panelWidth} />');
    expect(appSource).toContain("goalLayout.mode === 'compact-summary'");
    expect(appSource).toContain('<GoalCompactSummary view={goalView} />');
    expect(appSource).not.toContain('LeftNavigation');
  });

  test('hides ordinary Goal tool payloads from both assistant and tool chat entries', () => {
    expect(appSource.match(/if \(isGoalStatusToolPresentation\(presentation\)\) return null;/g)).toHaveLength(2);
  });

  test('uses a design-aligned session topbar above active conversations', () => {
    expect(appSource).toContain('<strong> PEER</strong>');
    expect(appSource).not.toContain('local capability agent');
    expect(appSource).toContain('{sessionWorkspacePath}');
    expect(appSource).toContain('{sessionTopbarModel}');
    expect(appSource).toContain('sessionTopbarModelLabel(');
    expect(appSource).toContain('compactWorkspacePath(host.workspaceRoot)');
    expect(appSource).toContain('<text fg={COLOR.success} wrapMode="none">{APP_CHROME.onlineDot}</text>');
    expect(appSource).not.toContain('backgroundColor={COLOR.border}');
    expect(appSource).toContain('composerContentWidth(terminal.width, layout.outerPadding)');
    expect(appSource).toContain('<ComposerModeDivider width={topbarDividerWidth} />');
  });

  test('presents running work as an activity rail instead of a loose spinner label', () => {
    expect(statusViewSource).toContain('justifyContent="space-between"');
    expect(statusViewSource).toContain('<span>PEER</span>');
    expect(statusViewSource).toContain('<span fg={COLOR.accent}> / ACTIVE</span>');
  });

  test('presents goals as a mission rail with progress and current-work emphasis', () => {
    expect(goalStatusViewSource).toContain('<strong>MISSION</strong>');
    expect(goalStatusViewSource).toContain("const progressTrack = `${'━'.repeat(progressDone)}${'─'.repeat(progressWidth - progressDone)}`;");
    expect(goalStatusViewSource).toContain('NOW WORKING');
    expect(goalStatusViewSource).toContain('border={[\'left\']}');
    expect(goalStatusViewSource).not.toContain('borderStyle="rounded"');
  });

});

describe('TUI Ask user option selection', () => {
  test('wires a selectable user-input surface with arrow/digit confirmation', async () => {
    const surfaceSource = await Bun.file(new URL('./surface-state.ts', import.meta.url)).text();
    expect(surfaceSource).toContain("type: 'user-input'");
    expect(appSource).toContain('userInputDecisionForKey');
    expect(appSource).toContain('showUserInput');
    expect(appSource).toContain('pendingUserInput');
    expect(appSource).toContain('↑↓ select · Enter confirm · type free text below');
  });

  test('keeps the Ask user card from being compressed by chat history', () => {
    const askUserIndex = appSource.indexOf('<strong>Ask user</strong>');
    expect(askUserIndex).toBeGreaterThan(-1);

    const cardStart = appSource.lastIndexOf('<box', askUserIndex);
    const cardEnd = appSource.indexOf('↑↓ select · Enter confirm · type free text below', askUserIndex);
    expect(cardStart).toBeGreaterThan(-1);
    expect(cardEnd).toBeGreaterThan(cardStart);

    const askUserCardSource = appSource.slice(cardStart, cardEnd);
    expect(askUserCardSource).toContain('flexShrink={0}');
    expect(askUserCardSource).toContain('borderColor={COLOR.accent}');
    expect(askUserCardSource).toContain('{pendingUserInput.question}');
    expect(askUserCardSource).toContain('userInputOptions.map');
  });
});

describe('TUI compact progress and separator rendering', () => {
  test('ChatHistory keeps progress visible and collapses completed handoffs to the desktop summary', () => {
    expect(appSource).toContain("if (message.role === 'system')");
    expect(appSource).toContain("phase === 'progress' ? 'COMPACTING' : 'COMPACTED'");
    expect(appSource).toContain("phase === 'done'");
    expect(appSource).toContain('Earlier conversation (compacted)');
    expect(appSource).toContain('${message.compact?.summarizedCount ?? 0} msgs · Structural');
    expect(appSource).toContain(': message.content;');
    expect(appSource).toContain("{compactSummary || ' '}");
    expect(appSource).not.toContain("{message.content || ' '}");
    expect(appSource).toContain("compactContext: async () => (await controller.compact()).notice");
  });
});