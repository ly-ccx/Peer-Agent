import type { ComposerStatus } from './composer-status.ts';
import { COLOR, contextUsageColor } from './tui-theme.ts';

export type ComposerStatusLayout = 'wide' | 'compact' | 'narrow';

/**
 * Footer running status: spinner + status text only.
 */
export function ComposerRunningStatusBar({
  spinner,
  statusLabel,
}: {
  readonly spinner: string;
  readonly statusLabel: string;
}) {
  return (
    <box
      flexDirection="row"
      width="100%"
      marginTop={1}
      flexShrink={0}
    >
      <text fg={COLOR.accent} wrapMode="none">
        <span>{spinner}</span>
        <span> {statusLabel}</span>
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

function ContextStatus({ status, short = false }: {
  readonly status: ComposerStatus;
  readonly short?: boolean;
}) {
  const color = contextUsageColor(status.contextPercent, COLOR.muted);
  return (
    <span fg={color}>
      {short ? status.contextShort : status.context}
    </span>
  );
}

/** Above the input: mode + access on the left, workspace on the right. */
export function ComposerControlsBar({ status, layout }: {
  readonly status: ComposerStatus;
  readonly layout: ComposerStatusLayout;
}) {
  const workspaceValue = layout === 'wide' ? status.workspace : status.workspaceShort;

  if (layout === 'narrow') {
    return (
      <box flexDirection="column" width="100%" paddingLeft={1} paddingRight={1} paddingBottom={0}>
        <text fg={COLOR.muted} wrapMode="none">
          <StatusPair label="mode" value={status.mode} accent />
        </text>
        <text fg={COLOR.muted} wrapMode="none">
          <StatusPair label="access" value={status.permissionShort} />
        </text>
        <text fg={COLOR.muted} wrapMode="none">
          <StatusPair label="lang" value={status.languageShort} />
        </text>
        <text fg={COLOR.muted} wrapMode="none">
          <StatusPair label="workspace" value={workspaceValue} />
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
      paddingRight={1}
      paddingBottom={0}
    >
      <text fg={COLOR.muted} wrapMode="none">
        <StatusPair label="mode" value={status.mode} accent />
        <StatusSeparator />
        <StatusPair label="access" value={layout === 'compact' ? status.permissionShort : status.permission} />
        <StatusSeparator />
        <StatusPair label="lang" value={layout === 'compact' ? status.languageShort : status.language} />
      </text>
      <text fg={COLOR.muted} wrapMode="none">
        <StatusPair label="workspace" value={workspaceValue} />
      </text>
    </box>
  );
}

/** Below the input: model · reasoning on the left, context pinned to the right. */
export function ComposerStatusBar({ status, layout }: {
  readonly status: ComposerStatus;
  readonly layout: ComposerStatusLayout;
}) {
  if (layout === 'narrow') {
    return (
      <box flexDirection="column" width="100%" paddingLeft={1} paddingRight={1} paddingTop={0}>
        <text fg={COLOR.textSoft} wrapMode="none">{status.model}</text>
        <text fg={COLOR.muted} wrapMode="none">{status.reasoning}</text>
        <text fg={COLOR.muted} wrapMode="none">
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
      paddingRight={1}
      paddingTop={0}
    >
      <text fg={COLOR.muted} wrapMode="none">
        <span fg={COLOR.textSoft}>{status.model}</span>
        <StatusSeparator />
        <span fg={COLOR.muted}>{status.reasoning}</span>
      </text>
      <text fg={COLOR.muted} wrapMode="none">
        <ContextStatus status={status} short={layout === 'compact'} />
      </text>
    </box>
  );
}
