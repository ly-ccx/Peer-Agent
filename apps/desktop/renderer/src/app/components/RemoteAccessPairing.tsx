import { useEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { Status } from './remoteAccessPresentation';

export function RemoteAccessPairing({ pairing, i18n }: {
  pairing: NonNullable<Status['pairing']>; i18n: I18nRuntime;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const t = i18n.t;
  async function copy(key: string, value: string) {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(value);
      if (!active.current) return;
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { if (active.current) setCopied(null); }, 2000);
    } catch { if (active.current) setFailed(true); }
  }
  const remaining = pairing.expiresAt - Date.now();
  return <section className="remote-access-card remote-access-pairing">
    <h3>{t('remoteAccess.pairTitle')}</h3><p>{t('remoteAccess.pairHint')}</p>
    {(['challengeId', 'pairingKey'] as const).map(key => {
      const label = t(key === 'challengeId' ? 'remoteAccess.challenge' : 'remoteAccess.pairingKey');
      return <div key={key}><span>{label}</span><code>{pairing[key]}</code>
        <button type="button" aria-label={t('remoteAccess.copyLabel', { name: label })} onClick={() => { void copy(key, pairing[key]); }}>
          {t(copied === key ? 'remoteAccess.copied' : 'remoteAccess.copy')}</button></div>;
    })}
    {failed && <p role="alert">{t('remoteAccess.copyFailed')}</p>}
    <p role="status">{remaining <= 0 ? t('remoteAccess.expired') : t('remoteAccess.remaining', { minutes: Math.max(1, Math.ceil(remaining / 60000)) })}</p>
  </section>;
}
