import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, ModelRole, ModelRoutingMenuOption, ProjectModelPolicy, RoleSetting } from '@peer-agent/protocol';
import { Dropdown } from '../../app/components/Dropdown';
import { Switch } from '../../ui/boolean-controls/Switch';
import { PeerIcon } from '../../ui/icons/PeerIcon';

const ROLES: readonly ModelRole[] = ['project_agent', 'session_worker', 'verifier', 'explorer', 'visual_verifier', 'memory_curator', 'objective_probe', 'compactor'];
const TIERS = ['strong', 'fast', 'economy', 'vision'] as const;
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
export function BotPolicyFields({ profile, models, busy, i18n, onChange }: PolicyProps & {
  models: readonly ModelRoutingMenuOption[];
}) {
  const policy = profile.modelPolicy || {};
  const scopeIds = policy.scope?.modelProviderIds;
  function setPolicy(next: ProjectModelPolicy) { onChange({ modelPolicy: next }); }
  function setRole(role: ModelRole, value: string) {
    const overrides = { ...policy.overrides };
    if (value === 'inherit') delete overrides[role];
    else if (value.startsWith('tier:')) overrides[role] = { mode: 'tier', tier: value.slice(5) as typeof TIERS[number] };
    else overrides[role] = { mode: 'fixed', modelProviderId: value.slice(6) };
    setPolicy({ ...policy, overrides });
  }
  function valueOf(setting?: RoleSetting) {
    return !setting ? 'inherit' : setting.mode === 'fixed' ? `model:${setting.modelProviderId}`
      : setting.mode === 'tier' ? `tier:${setting.tier}` : 'auto';
  }
  const roleField = (role: ModelRole) => <div className="bot-settings-row" key={role}>
    <span>{i18n.t(`modelRouting.role.${role}`)}</span>
    <Dropdown value={valueOf(policy.overrides?.[role])} disabled={busy}
      ariaLabel={i18n.t(`modelRouting.role.${role}`)}
      options={[
        { value: 'inherit', label: i18n.t('projectAgent.policy.inherit') },
        ...(policy.overrides?.[role]?.mode === 'auto' ? [{ value: 'auto', label: i18n.t('projectAgent.policy.autoPool'), disabled: true }] : []),
        ...TIERS.map(tier => ({ value: `tier:${tier}`, label: i18n.t(`modelRouting.tier.${tier}`) })),
        ...models.filter(model => !scopeIds || scopeIds.includes(model.id)).map(model => ({ value: `model:${model.id}`, label: model.label })),
      ]}
      onChange={value => setRole(role, value)} />
  </div>;
  return <section className="bot-settings-section bot-policy-fields">
    <h2>{i18n.t('modelRouting.title')}</h2>
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
