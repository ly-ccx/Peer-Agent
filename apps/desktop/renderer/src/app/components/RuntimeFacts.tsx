import type { I18nRuntime } from '@peer-agent/i18n';
import type { ClientSessionState, WorkspaceProject } from '@peer-agent/protocol';
import { sessionStatusKey } from '../runtimeLabels';

function FactCard({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <article className="fact-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

export function RuntimeFacts({
  session,
  projects,
  i18n,
}: {
  readonly session: ClientSessionState | null;
  readonly projects: readonly WorkspaceProject[];
  readonly i18n: I18nRuntime;
}) {
  const rootProject = projects[0];
  const workspaceDetail = rootProject
    ? `${rootProject.absolutePath}${rootProject.git?.branch ? ` · ${i18n.t('runtime.gitBranch', { branch: rootProject.git.branch })}` : ''}`
    : undefined;

  return (
    <section className="facts-grid">
      <FactCard
        label={i18n.t('runtime.session')}
        value={session ? i18n.t(sessionStatusKey(session.status)) : i18n.t('status.connecting')}
        detail={session ? `${i18n.t('runtime.sessionId')}: ${session.sessionId}` : undefined}
      />
      <FactCard
        label={i18n.t('runtime.workspace')}
        value={rootProject?.name ?? session?.workspaceLabel ?? i18n.t('app.workspaceFallback')}
        detail={workspaceDetail}
      />
    </section>
  );
}
