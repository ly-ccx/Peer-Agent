import type { ReactNode, SVGProps } from 'react';

export type PeerIconName =
  | 'back'
  | 'plus'
  | 'close'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight'
  | 'send';

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
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
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
