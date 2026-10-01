import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, ModelRole, ModelRoutingMenuOption, ProjectModelPolicy, RoleSetting } from '@peer-agent/protocol';
import { useState } from 'react';
import { Dropdown } from '../../app/components/Dropdown';

const ROLES: readonly ModelRole[] = ['project_agent', 'session_worker', 'verifier', 'explorer', 'visual_verifier', 'memory_curator', 'objective_probe', 'compactor'];
const TIERS = ['strong', 'fast', 'economy', 'vision'] as const;
type Patch = Pick<BotProfile, 'planApproval' | 'acceptancePolicy' | 'modelPolicy'>;

/** Controlled project policy form. All writes and validation belong to update-profile. */
export function BotPolicyFields({ profile, models, busy, i18n, onChange }: {
  profile: BotProfile; models: readonly ModelRoutingMenuOption[]; busy: boolean; i18n: I18nRuntime;
  onChange: (patch: Patch) => void;
}) {
  const [expanded, setExpanded] = useState(false);
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
  return <section className="bot-policy-fields">
    <div className="bot-settings-field">
      <span>{i18n.t('projectAgent.policy.planApproval')}</span>
      <Dropdown value={profile.planApproval || 'never'} disabled={busy}
        ariaLabel={i18n.t('projectAgent.policy.planApproval')}
        options={(['never', 'writes', 'always'] as const).map(value => ({ value, label: i18n.t(`projectAgent.policy.planApproval.${value}`) }))}
        onChange={value => onChange({ planApproval: value as BotProfile['planApproval'] })} />
    </div>
    <div className="bot-settings-field">
      <span>{i18n.t('projectAgent.drawer.acceptance')}</span>
      <Dropdown value={profile.acceptancePolicy || 'auto'} disabled={busy}
        ariaLabel={i18n.t('projectAgent.drawer.acceptance')}
        options={(['auto', 'confirm'] as const).map(value => ({ value, label: i18n.t(`projectAgent.policy.acceptance.${value}`) }))}
        onChange={value => onChange({ acceptancePolicy: value as BotProfile['acceptancePolicy'] })} />
    </div>
    <h2>{i18n.t('projectAgent.policy.models')}</h2>
    <p className="bot-drawer-note">{i18n.t('projectAgent.policy.modelsHint')}</p>
    {(expanded ? ROLES : ROLES.slice(0, 3)).map(role => <div className="bot-settings-field" key={role}>
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
    </div>)}
    <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      {i18n.t(expanded ? 'projectAgent.policy.fewerRoles' : 'projectAgent.policy.moreRoles')}
    </button>
    <div className="bot-settings-field">
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
    <button type="button" role="switch" aria-checked={policy.scope?.localOnly === true} disabled={busy}
      onClick={() => setPolicy({ ...policy, scope: { ...policy.scope, localOnly: policy.scope?.localOnly !== true } })}>
      {i18n.t('projectAgent.policy.localOnly')}
    </button>
  </section>;
}
