import type { ReactNode, SVGProps } from 'react';
import lucideLicense from './LUCIDE-LICENSE?raw';

export type PeerIconName =
  | 'loader'
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
  | 'image'
  | 'userRound'
  | 'stop'
  | 'settings'
  | 'history'
  | 'search'
  | 'repeat'
  | 'blocks'
  | 'agentOrbit'
  | 'agentBloom'
  | 'agentPrism'
  | 'agentWeave'
  | 'agentSpark'
  | 'agentFacet'
  | 'agentLeaf'
  | 'agentKnot'
  | 'check'
  | 'minus'
  | 'circle'
  | 'pause'
  | 'warning'
  | 'ellipsis'
  | 'archive'
  | 'arrowRight'
  | 'panelRight'
  | 'arrowRightOff'
  | 'bolt';

const PATHS: Record<PeerIconName, ReactNode> = {
  loader: <path d="M20 12a8 8 0 1 1-5.5-7.6" />,
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
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></>,
  // Lucide user-round (ISC); source and notice in LUCIDE-LICENSE.
  userRound: <g data-license={lucideLicense}><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></g>,
  settings: <><path d="M3 6h5m4 0h9M3 12h10m4 0h4M3 18h3m4 0h11" /><circle cx="10" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></>,
  repeat: <><path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3" /></>,
  blocks: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 17.5h7m-3.5-3.5v7" /></>,
  agentOrbit: <><circle cx="12" cy="12" r="3" /><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-35 12 12)" /></>,
  agentBloom: <><path d="M12 12C2 12 2 2 7 3c4 0 5 5 5 9Zm0 0C12 2 22 2 21 7c0 4-5 5-9 5Zm0 0c10 0 10 10 5 9-4 0-5-5-5-9Zm0 0c0 10-10 10-9 5 0-4 5-5 9-5Z" /></>,
  agentPrism: <><path d="m12 2 10 10-10 10L2 12Zm0 0v20M2 12h20" /></>,
  agentWeave: <><rect x="3" y="7" width="18" height="10" rx="5" /><rect x="7" y="3" width="10" height="18" rx="5" /></>,
  agentSpark: <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />,
  agentFacet: <><path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5m-9 5L3 7m9 5v10" /></>,
  agentLeaf: <><path d="M12 13C3 13 2 6 3 3c7-1 10 3 9 10Zm0 0c9 0 10-7 9-10-7-1-10 3-9 10Zm0 0v8m-5-4 5 4 5-4" /></>,
  agentKnot: <><rect x="3" y="3" width="12" height="12" rx="4" /><rect x="9" y="9" width="12" height="12" rx="4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  minus: <path d="M5 12h14" />,
  circle: <circle cx="12" cy="12" r="8" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  warning: <><path d="m12 3 10 18H2Z" /><path d="M12 9v4m0 4h.01" /></>,
  ellipsis: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  archive: <><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v14h14V7m-10 5h6" /></>,
  arrowRight: <path d="M4 12h16m-6-6 6 6-6 6" />,
  panelRight: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>,
  arrowRightOff: <><path d="M4 12h10m2 0h4m-6-6 6 6-3 3M3 3l18 18" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 10-12h-7l0-8Z" />,
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
