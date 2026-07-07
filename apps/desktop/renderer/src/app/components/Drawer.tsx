import type { ReactNode } from 'react';
import { Overlay } from './Overlay';

export function Drawer({
  onClose,
  closeOnBackdrop = true,
  ariaLabel,
  panelClassName,
  softBackdrop = false,
  children,
}: {
  readonly onClose?: () => void;
  readonly closeOnBackdrop?: boolean;
  readonly ariaLabel?: string;
  readonly panelClassName?: string;
  readonly softBackdrop?: boolean;
  readonly children: ReactNode | ((api: { readonly requestClose: () => void }) => ReactNode);
}) {
  const backdropClassName = softBackdrop
    ? 'pa-overlay-backdrop--drawer pa-overlay-backdrop--drawer-soft'
    : 'pa-overlay-backdrop--drawer';

  return (
    <Overlay
      onClose={onClose}
      closeOnBackdrop={closeOnBackdrop}
      ariaLabel={ariaLabel}
      panelClassName={panelClassName}
      backdropClassName={backdropClassName}
    >
      {children}
    </Overlay>
  );
}
