import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../../app/components/Overlay';
import '../styles/bot-list.css';

export function ClassicShellNotice({
  open,
  i18n,
  onClose,
  onSwitch,
}: {
  readonly open: boolean;
  readonly i18n: I18nRuntime;
  readonly onClose: () => void;
  readonly onSwitch: () => void;
}) {
  if (!open) return null;
  return (
    <Overlay ariaLabel={i18n.t('projectAgent.shell.classicNotice')} onClose={onClose}>
      <p className="bot-classic-notice">{i18n.t('projectAgent.shell.classicNotice')}</p>
      <button type="button" className="bot-onboarding-action" onClick={onSwitch}>
        {i18n.t('projectAgent.shell.classicNotice')}
      </button>
    </Overlay>
  );
}
