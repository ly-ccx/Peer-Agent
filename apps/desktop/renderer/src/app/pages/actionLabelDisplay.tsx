import { PeerIcon } from '../../ui/icons';

/** 协议 / 页面文案里残留的装饰箭头，渲染时拆掉，改由 PeerIcon 承担。 */
export function splitDecorativeArrow(label: string): { text: string; hasArrow: boolean } {
  const hasArrow = /\s*→\s*$/u.test(label);
  return {
    text: label.replace(/\s*→\s*$/u, '').trimEnd(),
    hasArrow,
  };
}

export function ActionLabel({
  label,
  forceArrow = false,
  iconClassName = 'action-label-arrow',
  size = 14,
}: {
  readonly label: string;
  readonly forceArrow?: boolean;
  readonly iconClassName?: string;
  readonly size?: number;
}) {
  const { text, hasArrow } = splitDecorativeArrow(label);
  return (
    <>
      {text}
      {forceArrow || hasArrow ? <PeerIcon name="chevronRight" size={size} className={iconClassName} /> : null}
    </>
  );
}
