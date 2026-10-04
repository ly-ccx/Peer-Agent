import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotModelViews, BotProfile, ModelRole, ModelRoutingMenuOption, ProjectModelPolicy } from '@peer-agent/protocol';
import { BotModelControls } from '../BotModelControls';
import { Dropdown } from '../../app/components/Dropdown';
import { Switch } from '../../ui/boolean-controls/Switch';
import { PeerIcon } from '../../ui/icons/PeerIcon';

// Compaction currently uses the active conversation provider, without this role routing seam.
const ROLES: readonly ModelRole[] = ['project_agent', 'session_worker', 'verifier', 'explorer', 'visual_verifier', 'memory_curator', 'objective_probe'];
type Patch = Pick<BotProfile, 'planApproval' | 'acceptancePolicy' | 'modelPolicy'>;
type PolicyProps = {
  profile: BotProfile; busy: boolean; i18n: I18nRuntime;
  onChange: (patch: Patch) => void;
};

export function BotApprovalFields({ profile, busy, i18n, onChange }: PolicyProps) {
  return <>
    <div className="bot-settings-row">
      <span>{i18n.t('projectAgent.policy.planApproval')}</span>
      <Dropdown value={profile.planApproval || 'never'} disabled={busy}
        ariaLabel={i18n.t('projectAgent.policy.planApproval')}
        options={(['never', 'writes', 'always'] as const).map(value => ({ value, label: i18n.t(`projectAgent.policy.planApproval.${value}`) }))}
        onChange={value => onChange({ planApproval: value as BotProfile['planApproval'] })} />
    </div>
    <div className="bot-settings-row">
      <span>{i18n.t('projectAgent.drawer.acceptance')}</span>
      <Dropdown value={profile.acceptancePolicy || 'auto'} disabled={busy}
        ariaLabel={i18n.t('projectAgent.drawer.acceptance')}
        options={(['auto', 'confirm'] as const).map(value => ({ value, label: i18n.t(`projectAgent.policy.acceptance.${value}`) }))}
        onChange={value => onChange({ acceptancePolicy: value as BotProfile['acceptancePolicy'] })} />
    </div>
  </>;
}

/** Controlled project policy form. All writes and validation belong to update-profile. */
export function BotPolicyFields({ profile, models, views, busy, i18n, onChange }: PolicyProps & {
  models: readonly ModelRoutingMenuOption[];
  views: BotModelViews;
}) {
  const policy = profile.modelPolicy || {};
  const scopeIds = policy.scope?.modelProviderIds;
  function setPolicy(next: ProjectModelPolicy) { onChange({ modelPolicy: next }); }
  const roleLabel = (role: ModelRole) => i18n.t(role === 'project_agent' ? 'projectAgent.drawer.model' : `modelRouting.role.${role}`);
  const roleField = (role: ModelRole) => <div className="bot-settings-row bot-model-settings-row" key={role}>
    <span>{roleLabel(role)}</span>
    <BotModelControls role={role} policy={policy} models={models} view={views[role]} busy={busy} i18n={i18n}
      onChange={setPolicy} />
  </div>;
  return <section className="bot-settings-section bot-policy-fields">
    <h2>{i18n.t('projectAgent.policy.models')}</h2>
    <p className="bot-drawer-note">{i18n.t('projectAgent.policy.modelsHint')}</p>
    {ROLES.slice(0, 3).map(roleField)}
    <details className="bot-settings-disclosure bot-model-advanced">
      <summary>{i18n.t('projectAgent.drawer.settings.advancedModels')}<PeerIcon name="chevronDown" size={14} /></summary>
      <div className="bot-settings-disclosure-body">
        {ROLES.slice(3).map(roleField)}
        <div className="bot-settings-row">
          <span>{i18n.t('projectAgent.policy.scope')}</span>
          <Dropdown value={scopeIds ? 'restricted' : 'all'} disabled={busy || models.length === 0}
            ariaLabel={i18n.t('projectAgent.policy.scope')}
            options={[{ value: 'all', label: i18n.t('projectAgent.policy.scope.all') }, { value: 'restricted', label: i18n.t('projectAgent.policy.scope.restricted') }]}
            onChange={value => {
              const scope = { ...policy.scope };
              if (value === 'all') delete scope.modelProviderIds;
              else scope.modelProviderIds = models.map(model => model.id);
              setPolicy({ ...policy, scope });
            }} />
        </div>
        {scopeIds ? <div className="bot-policy-models" role="group" aria-label={i18n.t('projectAgent.policy.scope')}>
          {models.map(model => <button key={model.id} type="button" aria-pressed={scopeIds.includes(model.id)}
            disabled={busy || scopeIds.length === 1 && scopeIds.includes(model.id)}
            onClick={() => setPolicy({ ...policy, scope: { ...policy.scope, modelProviderIds: scopeIds.includes(model.id) ? scopeIds.filter(id => id !== model.id) : [...scopeIds, model.id] } })}>
            {model.label}
          </button>)}
        </div> : null}
        <div className="bot-settings-row bot-settings-toggle-row">
          <label htmlFor="bot-local-models">{i18n.t('projectAgent.policy.localOnly')}</label>
          <Switch id="bot-local-models" checked={policy.scope?.localOnly === true} disabled={busy}
            onCheckedChange={value => setPolicy({ ...policy, scope: { ...policy.scope, localOnly: value } })} />
        </div>
      </div>
    </details>
  </section>;
}
