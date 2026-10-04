import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotRoleModelView, ModelRole, ModelRoutingMenuOption, ProjectModelPolicy, ProjectAgentActivity } from '@peer-agent/protocol';
import { CascadingMenu } from '../app/components/CascadingMenu';
import { ReasoningEffortSlider } from '../chat/components/thread/ReasoningEffortSlider';
import { botFixedModelPolicy, botInheritModelPolicy, botModelMenuGroups } from './state/botModelControls';
import '../chat/styles/chat-surface.css';
import './styles/bot-model-controls.css';

export function BotModelControls({ role, policy, models, view, busy, compact = false, activeSelection, i18n, onChange }: {
  readonly role: ModelRole;
  readonly policy?: ProjectModelPolicy | null;
  readonly models: readonly ModelRoutingMenuOption[];
  readonly view?: BotRoleModelView;
  readonly busy: boolean;
  readonly compact?: boolean;
  readonly activeSelection?: ProjectAgentActivity['modelSelection'];
  readonly i18n: I18nRuntime;
  readonly onChange: (policy: ProjectModelPolicy) => void;
}) {
  const isZh = i18n.locale.startsWith('zh');
  const selection = activeSelection ?? (view?.resolution.ok ? view.resolution.selection : undefined);
  const model = models.find(item => item.id === selection?.modelProviderId);
  const levels = model?.reasoningEffortLevels ?? [];
  const effort = selection?.reasoningEffort ?? model?.defaultReasoningEffort;
  const setting = policy?.overrides?.[role];
  const groups = [
    ...botModelMenuGroups(models, view, isZh),
    { id: 'bot-model-defaults', label: i18n.t('projectAgent.model.defaults'), items: [
      { id: 'inherit', label: i18n.t('projectAgent.policy.inherit') },
      ...(['strong', 'fast', 'economy', 'vision'] as const).map(tier => ({ id: `tier:${tier}`, label: i18n.t(`modelRouting.tier.${tier}`) })),
    ] },
  ];
  const changeModel = (id: string) => {
    if (id === 'inherit') onChange(botInheritModelPolicy(policy, role));
    else if (id.startsWith('tier:')) onChange({ ...policy, overrides: { ...policy?.overrides,
      [role]: { mode: 'tier', tier: id.slice(5) as 'strong' | 'fast' | 'economy' | 'vision' } } });
    else {
      const next = models.find(item => item.id === id);
      if (next && view?.eligibleModelIds.includes(id)) onChange(botFixedModelPolicy(policy, role, next, effort));
    }
  };
  const source = !setting ? i18n.t('projectAgent.policy.inherit') : setting.mode === 'tier'
    ? i18n.t(`modelRouting.tier.${setting.tier}`) : setting.mode === 'auto'
      ? i18n.t('projectAgent.policy.autoPool') : i18n.t('projectAgent.model.botOnly');
  return <div className={`bot-model-control${compact ? ' is-compact' : ''}`} data-model-id={model?.id ?? ''} data-effort={effort ?? ''}>
    <div className="bot-model-control-row">
      <CascadingMenu className="bot-model-picker" value={model?.id ?? ''} groups={groups}
        triggerLabel={model?.label}
        onChange={changeModel} disabled={busy || models.length === 0} menuPlacement={compact ? 'up' : 'down'}
        placeholder={i18n.t('projectAgent.model.unavailable')}
        ariaLabel={`${i18n.t('projectAgent.model.select')}：${model?.label ?? i18n.t('projectAgent.model.unavailable')}`}
        title={`${model?.label ?? ''} · ${source} · ${i18n.t(activeSelection ? 'projectAgent.model.runningReply' : 'projectAgent.model.nextReply')}`} />
      {model && effort && levels.includes(effort as typeof levels[number]) ? (
        <ReasoningEffortSlider key={model.id} effort={effort as typeof levels[number]} effortLevels={levels}
          disabled={busy || levels.length < 2} isZh={isZh} fastAvailable={false} fastMode={false}
          onFastModeChange={() => {}} onEffortChange={value => onChange(botFixedModelPolicy(policy, role, model, value))} />
      ) : null}
    </div>
    {!compact ? <p className="bot-model-source">{view?.resolution.ok ? source : i18n.t('projectAgent.model.unavailable')}
      {model && !levels.length ? ` · ${i18n.t('projectAgent.model.noEffort')}` : ''}</p> : null}
  </div>;
}
