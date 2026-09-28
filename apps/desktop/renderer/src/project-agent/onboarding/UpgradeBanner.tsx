import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { upgradeBannerPending } from './botShell';

export function UpgradeBanner({ i18n }: { readonly i18n: I18nRuntime }) {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void clientApi.getSettings().then((settings) => {
      if (!cancelled) setPending(upgradeBannerPending(settings));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!pending) return null;
  return (
    <div className="bot-upgrade-banner">
      <p>{i18n.t('projectAgent.shell.banner')}</p>
      <button
        type="button"
        onClick={() => {
          setPending(false);
          void clientApi.updateSettings({
            projectAgent: { shellIntroPending: false, shellIntroDismissed: true },
          }).catch(() => setPending(true));
        }}
      >
        {i18n.t('projectAgent.shell.bannerDismiss')}
      </button>
    </div>
  );
}
