import type { ComposerStatus } from './composer-status.ts';
import { COLOR, contextUsageColor } from './tui-theme.ts';

export type ComposerStatusLayout = 'wide' | 'compact' | 'narrow';

/** Footer running status, mounted above the quiet input divider. */
/** Soft neon palette for the Crush-style activity field (accent / ice / lime-adjacent). */
const NEON_ACTIVITY_COLORS = [COLOR.accent, COLOR.info, COLOR.success] as const;

export function neonActivityColor(index: number, frame = 0): string {
  return NEON_ACTIVITY_COLORS[Math.abs(index + frame) % NEON_ACTIVITY_COLORS.length] ?? COLOR.accent;
}

export function ComposerRunningStatusBar({
  activity,
  statusLabel,
  frame = 0,
}: {
  readonly activity: string;
  readonly statusLabel: string;
  /** Animation frame — shifts per-character neon colors without changing glyphs. */
  readonly frame?: number;
}) {
  return (
    <box
      flexDirection="row"
      width="100%"
      flexShrink={0}
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none">
        {[...activity].map((character, index) => (
          <span key={`${index}-${character}`} fg={neonActivityColor(index, frame)}>
            {character}
          </span>
        ))}
        <span fg={COLOR.textSoft}>  {statusLabel}</span>
      </text>
      <text fg={COLOR.subtle} wrapMode="none">
        <span>PEER</span>
        <span fg={COLOR.accent}> / ACTIVE</span>
      </text>
    </box>
  );
}

/** Thin rule between running status (if any) and the composer input. */
export function ComposerModeDivider({ width }: { readonly width: number }) {
  const cols = Math.max(1, Math.floor(width));
  return (
    <box width="100%" height={1} flexShrink={0}>
      <text fg={COLOR.subtle} wrapMode="none">
        {'─'.repeat(cols)}
      </text>
    </box>
  );
}

function StatusSeparator() {
  return <span fg={COLOR.subtle}> · </span>;
}

function StatusPair({ label, value, accent = false }: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <>
      <span fg={COLOR.subtle}>{label} </span>
      <span fg={accent ? COLOR.accent : COLOR.textSoft}>{value}</span>
    </>
  );
}

export function contextMeterParts(percent: number | undefined, width: number): {
  readonly filled: string;
  readonly empty: string;
} {
  if (width <= 0) return { filled: '', empty: '' };
  const bounded = Math.max(0, Math.min(100, percent ?? 0));
  const filledCount = Math.round((bounded / 100) * width);
  return {
    filled: '█'.repeat(filledCount),
    empty: '░'.repeat(width - filledCount),
  };
}

export function contextMeter(percent: number | undefined, width: number): string {
  const { filled, empty } = contextMeterParts(percent, width);
  return `${filled}${empty}`;
}

function ContextStatus({ status, short = false }: {
  readonly status: ComposerStatus;
  readonly short?: boolean;
}) {
  const color = contextUsageColor(status.contextPercent);
  const width = short ? 6 : 12;
  const { filled, empty } = contextMeterParts(status.contextPercent, width);
  const percent = status.contextPercent === undefined ? '?' : `${status.contextPercent}%`;
  return (
    <>
      <span fg={color}>{filled}</span>
      <span fg={COLOR.muted}>{empty}</span>
      <span fg={color}> {percent}</span>
    </>
  );
}

/**
 * Below the input: mode · access on the left, model · effort + context on the right.
 * No lang / workspace here — workspace lives in the session topbar.
 */
function ModelEffortLabel({ status }: { readonly status: ComposerStatus }) {
  return (
    <>
      <span fg={COLOR.textSoft}>{status.model}</span>
      <StatusSeparator />
      <span fg={COLOR.textSoft}>{status.effort}</span>
    </>
  );
}

export function ComposerStatusBar({ status, layout }: {
  readonly status: ComposerStatus;
  readonly layout: ComposerStatusLayout;
}) {
  if (layout === 'narrow') {
    return (
      <box flexDirection="column" width="100%" paddingLeft={1} paddingTop={0}>
        <text fg={COLOR.muted} wrapMode="none">
          <StatusPair label="mode" value={status.mode} accent />
          <StatusSeparator />
          <StatusPair label="access" value={status.permissionShort} />
        </text>
        <text fg={COLOR.muted} wrapMode="none">
          <ModelEffortLabel status={status} />
          {' '}
          <ContextStatus status={status} short />
        </text>
      </box>
    );
  }

  return (
    <box
      width="100%"
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingTop={0}
    >
      <text fg={COLOR.muted} wrapMode="none">
        <StatusPair label="mode" value={status.mode} accent />
        <StatusSeparator />
        <StatusPair
          label="access"
          value={layout === 'compact' ? status.permissionShort : status.permission}
        />
      </text>
      <text fg={COLOR.muted} wrapMode="none">
        <ModelEffortLabel status={status} />
        {' '}
        <ContextStatus status={status} short={layout === 'compact'} />
      </text>
    </box>
  );
}
