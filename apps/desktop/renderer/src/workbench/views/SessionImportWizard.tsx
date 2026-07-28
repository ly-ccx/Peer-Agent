/**
 * 站点会话导入向导（Cookie only）。
 * 不导入密码；不展示 Cookie value。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

export interface SessionImportWizardProps {
  readonly open: boolean;
  readonly isZh: boolean;
  readonly onClose: () => void;
  readonly onImported?: (result: {
    readonly ok: boolean;
    readonly added?: number;
    readonly status?: string;
  }) => void;
}

type ProfileOption = {
  readonly profileId: string;
  readonly displayName: string;
  readonly directory: string;
  readonly hasCookieDb: boolean;
  readonly browserName: string;
};

type SiteOption = {
  readonly registrableDomain: string;
  readonly cookieCount: number;
  readonly hostCount: number;
};

type Step = 'sources' | 'sites' | 'confirm' | 'working' | 'done';

export function SessionImportWizard({
  open,
  isZh,
  onClose,
  onImported,
}: SessionImportWizardProps) {
  const [step, setStep] = useState<Step>('sources');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [resultSummary, setResultSummary] = useState<string | null>(null);

  const t = useMemo(
    () => ({
      title: isZh ? '导入站点会话' : 'Import site session',
      subtitle: isZh
        ? '仅导入 Cookie / 登录状态，不会导入密码。'
        : 'Imports cookies / login sessions only — not passwords.',
      close: isZh ? '关闭' : 'Close',
      back: isZh ? '上一步' : 'Back',
      next: isZh ? '下一步' : 'Next',
      import: isZh ? '确认导入' : 'Import',
      loadingSources: isZh ? '正在查找浏览器…' : 'Looking for browsers…',
      loadingSites: isZh ? '正在扫描站点…' : 'Scanning sites…',
      importing: isZh ? '正在导入…' : 'Importing…',
      noSources: isZh
        ? '未发现可用的 Chrome / Chromium Profile，或缺少磁盘访问权限。'
        : 'No Chrome / Chromium profiles found, or disk access is denied.',
      noSites: isZh ? '该 Profile 下没有可导入的站点 Cookie。' : 'No importable site cookies in this profile.',
      pickProfile: isZh ? '选择浏览器 Profile' : 'Choose a browser profile',
      pickSites: isZh ? '选择要导入的站点' : 'Choose sites to import',
      confirm: isZh ? '确认导入' : 'Confirm import',
      cookies: isZh ? '条 Cookie' : 'cookies',
      hosts: isZh ? '主机' : 'hosts',
      selected: isZh ? '已选' : 'Selected',
      doneOk: isZh ? '已写入 Peer Browser（cookies_applied）。请打开站点确认是否仍需 MFA。' : 'Written to Peer Browser (cookies_applied). Open the site to verify MFA if needed.',
      donePartial: isZh ? '部分 Cookie 写入成功。' : 'Some cookies were applied.',
      doneFail: isZh ? '导入失败' : 'Import failed',
      risk: isZh
        ? '导入后登录态对所有 Peer Browser 标签共享。不会导入密码库。'
        : 'Imported sessions are shared across all Peer Browser tabs. Password vault is not imported.',
    }),
    [isZh],
  );

  const reset = useCallback(() => {
    setStep('sources');
    setLoading(false);
    setError(null);
    setProfiles([]);
    setProfileId(null);
    setSites([]);
    setSelectedDomains(new Set());
    setResultSummary(null);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await clientApi.listBrowserSessionSources();
        if (cancelled) return;
        if (!res?.ok) {
          setError(res?.error || t.noSources);
          setProfiles([]);
          return;
        }
        const flat: ProfileOption[] = [];
        for (const src of res.sources || []) {
          for (const p of src.profiles || []) {
            flat.push({
              profileId: p.profileId,
              displayName: p.displayName,
              directory: p.directory,
              hasCookieDb: p.hasCookieDb,
              browserName: src.browserName,
            });
          }
        }
        setProfiles(flat);
        if (flat.length === 0) setError(t.noSources);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, reset, t.noSources]);

  const loadSites = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      setSites([]);
      setSelectedDomains(new Set());
      try {
        const res = await clientApi.listBrowserSessionSites(id);
        if (!res?.ok) {
          setError(res?.error || t.noSites);
          return;
        }
        const list = (res.sites || []).map((s) => ({
          registrableDomain: s.registrableDomain,
          cookieCount: s.cookieCount,
          hostCount: s.hostCount,
        }));
        setSites(list);
        if (list.length === 0) setError(t.noSites);
        setStep('sites');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [t.noSites],
  );

  const toggleDomain = (domain: string) => {
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  const runImport = useCallback(async () => {
    if (!profileId || selectedDomains.size === 0) return;
    setStep('working');
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi.importBrowserSiteSession({
        profileId,
        registrableDomains: [...selectedDomains],
        includeSubdomains: true,
      });
      if (!res?.ok) {
        setError(`${t.doneFail}${res?.error ? `: ${res.error}` : ''}`);
        setStep('confirm');
        onImported?.({ ok: false });
        return;
      }
      const summary =
        res.status === 'cookies_applied'
          ? `${t.doneOk} (+${res.added ?? 0})`
          : `${t.donePartial} (+${res.added ?? 0}, fail ${res.failed ?? 0})`;
      setResultSummary(summary);
      setStep('done');
      onImported?.({ ok: true, added: res.added, status: res.status });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('confirm');
      onImported?.({ ok: false });
    } finally {
      setLoading(false);
    }
  }, [onImported, profileId, selectedDomains, t.doneFail, t.doneOk, t.donePartial]);

  if (!open) return null;

  const selectedProfile = profiles.find((p) => p.profileId === profileId) || null;

  return (
    <div className="session-import-overlay" role="dialog" aria-modal="true" aria-label={t.title}>
      <div className="session-import-modal">
        <header className="session-import-header">
          <div>
            <h2 className="session-import-title">{t.title}</h2>
            <p className="session-import-sub">{t.subtitle}</p>
          </div>
          <button type="button" className="session-import-close" onClick={onClose}>
            {t.close}
          </button>
        </header>

        {error ? <div className="session-import-error">{error}</div> : null}

        {step === 'sources' || (step === 'sites' && !profileId) ? (
          <section className="session-import-body">
            <h3 className="session-import-section-title">{t.pickProfile}</h3>
            {loading ? <p className="session-import-hint">{t.loadingSources}</p> : null}
            <ul className="session-import-list">
              {profiles.map((p) => (
                <li key={p.profileId}>
                  <button
                    type="button"
                    className="session-import-list-btn"
                    disabled={!p.hasCookieDb || loading}
                    onClick={() => {
                      setProfileId(p.profileId);
                      void loadSites(p.profileId);
                    }}
                  >
                    <span className="session-import-list-main">
                      {p.browserName} · {p.displayName}
                    </span>
                    <span className="session-import-list-meta">{p.directory}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {step === 'sites' && profileId ? (
          <section className="session-import-body">
            <h3 className="session-import-section-title">{t.pickSites}</h3>
            {loading ? <p className="session-import-hint">{t.loadingSites}</p> : null}
            <ul className="session-import-list session-import-list--check">
              {sites.map((s) => {
                const checked = selectedDomains.has(s.registrableDomain);
                return (
                  <li key={s.registrableDomain}>
                    <label className="session-import-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDomain(s.registrableDomain)}
                      />
                      <span className="session-import-list-main">{s.registrableDomain}</span>
                      <span className="session-import-list-meta">
                        {s.cookieCount} {t.cookies} · {s.hostCount} {t.hosts}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <footer className="session-import-footer">
              <button
                type="button"
                className="session-import-btn"
                onClick={() => {
                  setStep('sources');
                  setProfileId(null);
                  setSites([]);
                  setSelectedDomains(new Set());
                }}
              >
                {t.back}
              </button>
              <button
                type="button"
                className="session-import-btn session-import-btn--primary"
                disabled={selectedDomains.size === 0}
                onClick={() => setStep('confirm')}
              >
                {t.next} ({t.selected} {selectedDomains.size})
              </button>
            </footer>
          </section>
        ) : null}

        {step === 'confirm' || step === 'working' ? (
          <section className="session-import-body">
            <h3 className="session-import-section-title">{t.confirm}</h3>
            <p className="session-import-hint">
              {selectedProfile
                ? `${selectedProfile.browserName} · ${selectedProfile.displayName}`
                : profileId}
            </p>
            <ul className="session-import-list">
              {[...selectedDomains].map((d) => (
                <li key={d} className="session-import-static-item">
                  {d}
                </li>
              ))}
            </ul>
            <p className="session-import-risk">{t.risk}</p>
            <footer className="session-import-footer">
              <button
                type="button"
                className="session-import-btn"
                disabled={loading}
                onClick={() => setStep('sites')}
              >
                {t.back}
              </button>
              <button
                type="button"
                className="session-import-btn session-import-btn--primary"
                disabled={loading}
                onClick={() => void runImport()}
              >
                {loading ? t.importing : t.import}
              </button>
            </footer>
          </section>
        ) : null}

        {step === 'done' ? (
          <section className="session-import-body">
            <p className="session-import-hint">{resultSummary}</p>
            <footer className="session-import-footer">
              <button type="button" className="session-import-btn session-import-btn--primary" onClick={onClose}>
                {t.close}
              </button>
            </footer>
          </section>
        ) : null}
      </div>
    </div>
  );
}
