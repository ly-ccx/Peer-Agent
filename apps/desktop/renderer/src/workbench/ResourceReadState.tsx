import type { ReactNode } from 'react';
import { PeerIcon } from '../ui/icons';
import { useMotionAllowed } from '../app/hooks/useMotionAllowed';

/** A real pending read may show placeholders; its completion never follows an animation. */
export function ResourceReadState({ title, detail, kind = 'loading', active = true, children }: {
  readonly title: string; readonly detail?: string; readonly kind?: 'loading' | 'empty' | 'error';
  readonly active?: boolean; readonly children?: ReactNode;
}) {
  const motionAllowed = useMotionAllowed();
  return <div className="resource-read-state" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'}>
    <div className="resource-read-state-heading">
      <span className="resource-read-state-icon"><PeerIcon name={kind === 'loading' ? 'loader' : kind === 'error' ? 'info' : 'fileText'}
        size={18} className={kind === 'loading' && active && motionAllowed ? 'motion-spin' : undefined} /></span>
      <div><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</div>
    </div>
    {kind === 'loading' ? <div className="resource-read-skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => <div key={index}><span /><span /></div>)}
    </div> : null}
    {children}
  </div>;
}
