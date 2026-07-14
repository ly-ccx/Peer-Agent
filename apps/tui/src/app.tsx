import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';

import {
  createChatController,
  type ChatController,
  type ChatMessage,
  type ChatModelPort,
  type ChatSnapshot,
} from './chat-controller.ts';
import {
  approvalDecisionForKey,
  moveApprovalSelection,
  TUI_APPROVAL_OPTIONS,
} from './approval-card.ts';
import type { PendingApproval, TuiHost } from './tui-host.ts';
import { cycleTuiMode, TUI_MODES, tuiModeForKey, tuiModeOption } from './tui-mode.ts';

function roleColor(role: ChatMessage['role']): string {
  if (role === 'user') return '#93c5fd';
  if (role === 'tool') return '#fcd34d';
  return '#a7f3d0';
}

function ChatHistory({ snapshot }: { readonly snapshot: ChatSnapshot }) {
  if (snapshot.messages.length === 0) {
    return <text fg="#64748b">Start a conversation. Model tool calls run through the governed Runtime.</text>;
  }

  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" padding={1}>
      {snapshot.messages.map((message) => (
        <box key={message.id} flexDirection="column" marginBottom={1}>
          <text fg={roleColor(message.role)}>
            <strong>{message.role.toUpperCase()}</strong>
            {message.pending ? ' · streaming' : ''}
          </text>
          <text fg="#e2e8f0">{message.content || ' '}</text>
        </box>
      ))}
    </scrollbox>
  );
}

function Composer({ controller, snapshot, disabled }: {
  readonly controller: ChatController;
  readonly snapshot: ChatSnapshot;
  readonly disabled: boolean;
}) {
  const editor = useRef<TextareaRenderable | null>(null);

  const submit = () => {
    const value = editor.current?.plainText ?? '';
    if (!value.trim() || disabled || snapshot.status !== 'idle') return;
    editor.current?.clear();
    void controller.send(value);
  };

  return (
    <box border borderColor={snapshot.status === 'idle' ? '#475569' : '#f59e0b'} height={6} padding={1}>
      <textarea
        ref={editor}
        focused={!disabled}
        placeholder={disabled ? 'Resolve the permission request first…' : 'Message Peer Agent…'}
        wrapMode="word"
        onSubmit={submit}
      />
    </box>
  );
}

export function App({ host, model, modelLabel }: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly modelLabel: string;
}) {
  const renderer = useRenderer();
  const controller = useMemo(() => createChatController({ host, model }), [host, model]);
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [approvalSelection, setApprovalSelection] = useState(0);
  const visibleTurn = snapshot.session?.activeTurn ?? snapshot.session?.lastTurn;

  useEffect(() => controller.subscribe(setSnapshot), [controller]);
  useEffect(() => host.subscribeApproval((next) => {
    setApprovalSelection(0);
    setApproval(next);
  }), [host]);

  useKeyboard((key) => {
    if (approval) {
      if (key.name === 'left' || key.name === 'up') {
        setApprovalSelection((current) => moveApprovalSelection(current, -1));
        return;
      }
      if (key.name === 'right' || key.name === 'down' || key.name === 'tab') {
        setApprovalSelection((current) => moveApprovalSelection(current, 1));
        return;
      }
      const decision = approvalDecisionForKey(key.name, approvalSelection);
      if (decision) approval.resolve(decision);
      return;
    }
    if (key.ctrl && key.name === 'c') {
      if (snapshot.status === 'running') controller.cancel();
      else renderer.destroy();
      return;
    }
    if (snapshot.status !== 'idle') return;
    const directMode = tuiModeForKey(key.name, Boolean(key.ctrl));
    if (directMode) {
      controller.setMode(directMode);
      return;
    }
    if (key.ctrl && key.name === 'tab') {
      controller.setMode(cycleTuiMode(snapshot.mode, key.shift ? -1 : 1));
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1} backgroundColor="#07111f">
      <box justifyContent="space-between">
        <text fg="#67e8f9"><strong>PEER AGENT</strong> · {modelLabel}</text>
        <text fg={snapshot.status === 'idle' ? '#86efac' : '#fbbf24'}>
          {snapshot.status}
          {snapshot.usage?.totalTokens === undefined ? '' : ` · ${snapshot.usage.totalTokens} tokens`}
        </text>
      </box>

      <box flexDirection="column" border borderColor="#1e3a5f" padding={1}>
        <box flexDirection="row" gap={2}>
          {TUI_MODES.map((option) => (
            <text key={option.mode} fg={option.mode === snapshot.mode ? '#67e8f9' : '#64748b'}>
              {option.mode === snapshot.mode ? '▶ ' : '  '}
              Ctrl+{option.shortcut} {option.label}
              {option.readOnly ? ' · read-only' : ''}
            </text>
          ))}
        </box>
        <text fg="#94a3b8">
          {tuiModeOption(snapshot.mode).description} · {(host.capabilitiesForMode?.(snapshot.mode) ?? host.capabilities).length} projected tools
        </text>
      </box>

      {snapshot.session ? (
        <text fg="#64748b">
          session {snapshot.session.sessionId}
          {visibleTurn ? ` · turn ${visibleTurn.turnIndex} · ${visibleTurn.status}` : ''}
        </text>
      ) : null}

      <ChatHistory snapshot={snapshot} />

      {snapshot.error ? <text fg="#fca5a5">{snapshot.error}</text> : null}

      {approval ? (
        <box flexDirection="column" border borderColor="#fb7185" padding={1}>
          <text fg="#fecdd3"><strong>Permission required</strong></text>
          <text fg="#fda4af">
            {approval.prompt.capabilityId} · {approval.prompt.confirmation.kind}
          </text>
          <text fg="#94a3b8">{approval.prompt.reason}</text>
          <text fg="#94a3b8">
            scope {approval.sessionId ? `session ${approval.sessionId}` : 'this request only'}
          </text>
          <box flexDirection="row" gap={2}>
            {TUI_APPROVAL_OPTIONS.map((option, index) => (
              <text key={option.decision} fg={option.color}>
                {index === approvalSelection ? '▶ ' : '  '}
                [{option.shortcut}] {option.label}
              </text>
            ))}
          </box>
          <text fg="#64748b">←/→ or Tab select · Enter confirm · Esc deny</text>
        </box>
      ) : null}

      <Composer controller={controller} snapshot={snapshot} disabled={Boolean(approval)} />
      <text fg="#64748b">Enter send · Shift+Enter newline · Ctrl+1..4 mode · Ctrl+Tab cycle · Ctrl+C cancel / quit</text>
    </box>
  );
}
