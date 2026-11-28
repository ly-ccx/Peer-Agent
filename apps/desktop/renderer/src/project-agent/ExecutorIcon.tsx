import { useId } from 'react';

export type ExecutorKind = 'peer' | 'claude-code' | 'codex' | 'opencode' | 'gemini-cli';

export interface ExecutorIconProps {
  readonly kind?: ExecutorKind;
  readonly size?: number;
  readonly className?: string;
  readonly title?: string;
  readonly flowing?: boolean;
}

const EXECUTOR_NAMES: Record<ExecutorKind, string> = {
  peer: 'Peer Native CLI',
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
};

export function executorDisplayName(kind: ExecutorKind, isZh: boolean): string {
  return kind === 'peer' && isZh ? 'Peer 小猫 CLI' : EXECUTOR_NAMES[kind];
}

const EXTERNAL_MARKS = {
  'claude-code': <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4m0-8.4-8.4 8.4" stroke="#D97757" strokeWidth="1.6" strokeLinecap="round" />,
  codex: <path d="M8 5a3 3 0 1 0-3 5h3m0 1a3 3 0 1 0 3-5H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  opencode: <path d="m4 5 3 3-3 3m4 0h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  'gemini-cli': <path d="M8 1.5A8 8 0 0 0 14.5 8 8 8 0 0 0 8 14.5 8 8 0 0 0 1.5 8 8 8 0 0 0 8 1.5Z" fill="currentColor" />,
};

export function ExecutorIcon({ kind = 'peer', size = 14, className, title, flowing = false }: ExecutorIconProps) {
  const instanceId = useId();
  const maskId = `peer-executor-mask-${instanceId}`;
  const gradientId = `peer-executor-flow-${instanceId}`;
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" focusable="false"
      className={className} data-executor-kind={kind} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      {kind === 'peer' ? (
        <>
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
              <path d="M3.2 6.8 C2.9 4.7 3.5 2.5 4.6 2.4 C5.6 2.3 6.5 3.6 7.0 4.3 C7.6 4.1 8.4 4.1 9.0 4.3 C9.5 3.6 10.4 2.3 11.4 2.4 C12.5 2.5 13.1 4.7 12.8 6.8 C13.3 7.7 13.5 8.7 13.3 9.7 C12.9 12.1 10.9 13.6 8.0 13.6 C5.1 13.6 3.1 12.1 2.7 9.7 C2.5 8.7 2.7 7.7 3.2 6.8 Z"
                fill="white" />
              <rect x="5.4" y="7.5" width="1.15" height="2.0" rx="0.58" fill="black" />
              <rect x="8.8" y="7.5" width="1.15" height="2.0" rx="0.58" fill="black" />
            </mask>
            {flowing ? (
              <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="12" y2="12" spreadMethod="repeat">
                <stop offset="0" stopColor="var(--state-iridescent-blue)" />
                <stop offset=".2" stopColor="var(--state-iridescent-lilac)" />
                <stop offset=".4" stopColor="var(--state-iridescent-rose)" />
                <stop offset=".6" stopColor="var(--state-iridescent-apricot)" />
                <stop offset=".8" stopColor="var(--state-iridescent-mint)" />
                <stop offset="1" stopColor="var(--state-iridescent-blue)" />
              </linearGradient>
            ) : null}
          </defs>
          {flowing ? (
            <g mask={`url(#${maskId})`}>
              {/* Half the strip spans one 24-unit horizontal repeat of the diagonal gradient. */}
              <rect className="motion-iridescent-flow" width="48" height="16" fill={`url(#${gradientId}) currentColor`} />
            </g>
          ) : <rect width="16" height="16" fill="currentColor" mask={`url(#${maskId})`} />}
        </>
      ) : EXTERNAL_MARKS[kind]}
    </svg>
  );
}
