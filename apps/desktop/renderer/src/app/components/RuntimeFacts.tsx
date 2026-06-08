import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState, ClientSessionState, CloudRuntimeState, WorkspaceProject } from '@zeus-atlas/protocol';
import { cloudStatusKey, formatAuthIdentity, sessionStatusKey } from '../runtimeLabels';

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
  cloudRuntime,
  authState,
  projects,
  i18n,
}: {
  readonly session: ClientSessionState | null;
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly authState: AuthState | null;
  readonly projects: readonly WorkspaceProject[];
  readonly i18n: I18nRuntime;
}) {
  const rootProject = projects[0];
  const authDetail = authState?.config.clientId
    ? `${i18n.t('runtime.clientId')}: ${authState.config.clientId}`
    : undefined;
  const cloudMode = cloudRuntime?.mode === 'pre'
    ? i18n.t('runtime.mode.pre')
    : cloudRuntime?.mode === 'custom'
      ? i18n.t('runtime.mode.custom')
      : i18n.t('runtime.mode.prod');
  const cloudDetail = cloudRuntime?.endpoint
    ? `${i18n.t('runtime.endpoint')}: ${cloudRuntime.endpoint} · ${i18n.t('runtime.mode')}: ${cloudMode}`
    : i18n.t('runtime.noEndpoint');
  const workspaceDetail = rootProject
    ? `${rootProject.absolutePath}${rootProject.git?.branch ? ` · ${i18n.t('runtime.gitBranch', { branch: rootProject.git.branch })}` : ''}`
    : undefined;

  return (
    <section className="facts-grid">
      <FactCard label={i18n.t('runtime.auth')} value={formatAuthIdentity(authState, i18n)} detail={authDetail} />
      <FactCard
        label={i18n.t('runtime.cloud')}
        value={cloudRuntime ? i18n.t(cloudStatusKey(cloudRuntime.status)) : i18n.t('status.connecting')}
        detail={cloudDetail}
      />
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
