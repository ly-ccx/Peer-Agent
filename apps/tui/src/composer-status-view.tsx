import type { ComposerStatus } from './composer-status.ts';

const MUTED = '#64748b';
const SUBTLE = '#475569';
const ACCENT = '#7189c9';
const TEXT = '#94a3b8';

export type ComposerStatusLayout = 'wide' | 'compact' | 'narrow';

function StatusSeparator() {
  return <span fg={SUBTLE}> · </span>;
}

function StatusPair({ label, value, accent = false }: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <>
      <span fg={SUBTLE}>{label} </span>
      <span fg={accent ? ACCENT : TEXT}>{value}</span>
    </>
  );
}

function ContextStatus({ status, short = false }: {
  readonly status: ComposerStatus;
  readonly short?: boolean;
}) {
  return (
    <span fg={status.contextPercent !== undefined && status.contextPercent >= 80 ? '#fbbf24' : MUTED}>
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
        <text fg={MUTED} wrapMode="none">
          <StatusPair label="mode" value={status.mode} accent />
        </text>
        <text fg={MUTED} wrapMode="none">
          <StatusPair label="access" value={status.permissionShort} />
        </text>
        <text fg={MUTED} wrapMode="none">
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
      <text fg={MUTED} wrapMode="none">
        <StatusPair label="mode" value={status.mode} accent />
        <StatusSeparator />
        <StatusPair label="access" value={layout === 'compact' ? status.permissionShort : status.permission} />
      </text>
      <text fg={MUTED} wrapMode="none">
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
        <text fg={TEXT} wrapMode="none">{status.model}</text>
        <text fg={MUTED} wrapMode="none">{status.reasoning}</text>
        <text fg={MUTED} wrapMode="none">
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
      <text fg={MUTED} wrapMode="none">
        <span fg={TEXT}>{status.model}</span>
        <StatusSeparator />
        <span fg={MUTED}>{status.reasoning}</span>
      </text>
      <text fg={MUTED} wrapMode="none">
        <ContextStatus status={status} short={layout === 'compact'} />
      </text>
    </box>
  );
}
