import { useEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectDiagnostics } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import './diagnostics.css';

export function ProjectDiagnosticsPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const [report, setReport] = useState<ProjectDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'saved' | 'cancelled' | 'failed' | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function run(action: 'read' | 'export') {
    setBusy(true); setStatus(null);
    try {
      const result = await clientApi.projectAgentDiagnostics({ action });
      if (!live.current) return;
      if (result.ok) {
        setReport(result.report);
        setStatus(result.saved ? 'saved' : result.cancelled ? 'cancelled' : null);
      } else setStatus('failed');
    } catch { if (live.current) setStatus('failed'); }
    finally { if (live.current) setBusy(false); }
  }
  const unknown = i18n.t('developer.diagnostics.unknown');
  return <section className="settings-card project-diagnostics" aria-busy={busy}>
    <header><h3>{i18n.t('developer.projectAgent.diagnostics')}</h3>
      <p className="settings-status">{i18n.t('developer.diagnostics.description')}</p></header>
    <div className="project-diagnostics__actions">
      <button className="settings-btn" type="button" disabled={busy} onClick={() => void run('read')}>{i18n.t('developer.diagnostics.refresh')}</button>
      <button className="settings-btn" type="button" disabled={busy} onClick={() => void run('export')}>{i18n.t('developer.diagnostics.export')}</button>
    </div>
    <p className="settings-status" role="status" aria-live="polite">{busy ? i18n.t('developer.diagnostics.busy') : status ? i18n.t(`developer.diagnostics.${status}`) : ''}</p>
    {report && <>
      <dl className="project-diagnostics__summary">
        <div><dt>{i18n.t('developer.diagnostics.generated')}</dt><dd>{report.generatedAt ? new Date(report.generatedAt).toLocaleString(i18n.locale) : unknown}</dd></div>
        <div><dt>{i18n.t('developer.diagnostics.bots')}</dt><dd>{report.bots.length}</dd></div>
        <div><dt>{i18n.t('developer.diagnostics.slots')}</dt><dd>{report.scheduler ? `${report.scheduler.stats.active ?? unknown} / ${report.scheduler.stats.limit ?? unknown}` : unknown}</dd></div>
        <div><dt>{i18n.t('developer.diagnostics.waiting')}</dt><dd>{report.scheduler?.stats.waiting ?? unknown}</dd></div>
        <div><dt>{i18n.t('developer.diagnostics.errors')}</dt><dd>{report.errors.length + report.bots.reduce((sum, bot) => sum + bot.errors.length, 0)}</dd></div>
      </dl>
      <details><summary>{i18n.t('developer.diagnostics.preview')}</summary>
        <pre tabIndex={0} aria-label={i18n.t('developer.diagnostics.preview')}>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </>}
  </section>;
}
