import type { ReactNode, RefObject } from 'react';
import { Overlay } from './Overlay';

export function Drawer({
  onClose,
  restoreFocusRef,
  closeOnBackdrop = true,
  onRequestClose,
  ariaLabel,
  panelClassName,
  softBackdrop = false,
  children,
}: {
  readonly onClose?: () => void;
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly closeOnBackdrop?: boolean;
  readonly onRequestClose?: () => boolean | Promise<boolean>;
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
      restoreFocusRef={restoreFocusRef}
      closeOnBackdrop={closeOnBackdrop}
      onRequestClose={onRequestClose}
      ariaLabel={ariaLabel}
      panelClassName={panelClassName}
      backdropClassName={backdropClassName}
    >
      {children}
    </Overlay>
  );
}
