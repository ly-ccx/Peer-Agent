import type { ReactNode, SVGProps } from 'react';
import lucideLicense from './LUCIDE-LICENSE?raw';

export type PeerIconName =
  | 'back'
  | 'plus'
  | 'close'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight'
  | 'arrowUpRight'
  | 'send'
  | 'terminal'
  | 'info'
  | 'fileText'
  | 'userRound'
  | 'stop';

const PATHS: Record<PeerIconName, ReactNode> = {
  back: (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>,
  fileText: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8m-8 4h6" /></>,
  // Lucide user-round (ISC); source and notice in LUCIDE-LICENSE.
  userRound: <g data-license={lucideLicense}><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></g>,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  arrowUpRight: <><path d="M7 17 17 7M8 7h9v9" /></>,
  send: (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
};

export function PeerIcon({
  name,
  size = 16,
  className,
  ...rest
}: {
  readonly name: PeerIconName;
  readonly size?: number;
} & SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={['peer-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
