import { useMemo } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotRoleModelView, ModelRole, ModelRoutingMenuOption, ProjectModelPolicy, ProjectAgentActivity } from '@peer-agent/protocol';
import { AnchoredModelSelectionMenu } from '../chat/components/thread/ModelSelectionPanel';
import { isEffortLevel, type EffortLevel } from '../chat/state/preferences';
import type { SelectionProviderGroup } from '../chat/components/thread/modelSelection';
import { botConfiguredModelSelection, botFixedModelPolicy, botInheritModelPolicy, botModelMenuGroups } from './state/botModelControls';
import type { BotModelsControlState } from './state/useBotModels';
import { BotModelFeedback } from './BotModelFeedback';
import '../chat/styles/chat-surface.css';
import './styles/bot-model-controls.css';

const TIERS = ['strong', 'fast', 'economy', 'vision'] as const;

function botPanelGroups(
  models: readonly ModelRoutingMenuOption[],
  view: BotRoleModelView | undefined,
  isZh: boolean,
  defaultsLabel: string,
  inheritLabel: string,
  tierLabel: (tier: typeof TIERS[number]) => string,
): readonly SelectionProviderGroup[] {
  const providers = botModelMenuGroups(models, view, isZh).map((group) => ({
    id: group.id,
    label: group.label,
    disabled: group.disabled === true,
    models: group.items.map((item) => {
      const source = models.find((model) => model.id === item.id);
      const levels = source?.reasoningEffortLevels ?? [];
      return {
        id: item.id,
        label: item.label,
        disabled: item.disabled === true,
        supportsVision: source?.supportsVision === true,
        authMethod: source?.authMethod ?? '',
        supportsReasoning: levels.length > 1,
        reasoningEffortLevels: levels,
        reasoningDefaultEffort: source?.defaultReasoningEffort,
      };
    }),
  }));
  return [
    ...providers,
    {
      id: 'bot-model-defaults',
      label: defaultsLabel,
      disabled: false,
      models: [
        { id: 'inherit', label: inheritLabel, disabled: false, supportsVision: false, authMethod: '', supportsReasoning: false },
        ...TIERS.map((tier) => ({
          id: `tier:${tier}`,
          label: tierLabel(tier),
          disabled: false,
          supportsVision: false,
          authMethod: '',
          supportsReasoning: false,
        })),
      ],
    },
  ];
}

export function BotModelControls({ role, policy, models, view, busy, compact = false, activeSelection, feedback, i18n, onChange }: {
  readonly role: ModelRole;
  readonly policy?: ProjectModelPolicy | null;
  readonly models: readonly ModelRoutingMenuOption[];
  readonly view?: BotRoleModelView;
  readonly busy: boolean;
  readonly compact?: boolean;
  readonly activeSelection?: ProjectAgentActivity['modelSelection'];
  readonly feedback?: BotModelsControlState;
  readonly i18n: I18nRuntime;
  readonly onChange: (policy: ProjectModelPolicy) => void | Promise<unknown>;
}) {
  const isZh = i18n.locale.startsWith('zh');
  const selection = botConfiguredModelSelection(policy, role, models, view)
    ?? (view?.resolution.ok ? view.resolution.selection : undefined);
  const model = models.find(item => item.id === selection?.modelProviderId);
  const levels = model?.reasoningEffortLevels ?? [];
  const effort = selection?.reasoningEffort ?? model?.defaultReasoningEffort;
  const setting = policy?.overrides?.[role];
  const groups = useMemo(() => botPanelGroups(
    models,
    view,
    isZh,
    i18n.t('projectAgent.model.defaults'),
    i18n.t('projectAgent.policy.inherit'),
    (tier) => i18n.t(`modelRouting.tier.${tier}`),
  ), [i18n, isZh, models, view]);
  const changeModel = (id: string) => {
    if (id === 'inherit') return onChange(botInheritModelPolicy(policy, role));
    else if (id.startsWith('tier:')) return onChange({ ...policy, overrides: { ...policy?.overrides,
      [role]: { mode: 'tier', tier: id.slice(5) as 'strong' | 'fast' | 'economy' | 'vision' } } });
    else {
      const next = models.find(item => item.id === id);
      if (next && view?.eligibleModelIds.includes(id)) {
        return onChange(botFixedModelPolicy(policy, role, next, effort, setting?.mode === 'fixed' && setting.fastMode === true));
      }
    }
  };
  const source = !setting ? i18n.t('projectAgent.policy.inherit') : setting.mode === 'tier'
    ? i18n.t(`modelRouting.tier.${setting.tier}`) : setting.mode === 'auto'
      ? i18n.t('projectAgent.policy.autoPool') : i18n.t('projectAgent.model.botOnly');
  const selectedId = !setting ? 'inherit' : setting.mode === 'tier' ? `tier:${setting.tier}` : setting.mode === 'fixed' ? setting.modelProviderId : model?.id ?? 'inherit';
  const label = setting?.mode === 'tier'
    ? i18n.t(`modelRouting.tier.${setting.tier}`)
    : (model?.label ?? i18n.t('projectAgent.model.unavailable'));
  const effortLevel: EffortLevel = isEffortLevel(effort) ? effort : 'default';
  const fastMode = setting?.mode === 'fixed' && setting.fastMode === true;
  const updating = Boolean(feedback?.busy || feedback && !feedback.loaded && feedback.reading);
  const feedbackKey = feedback?.saveError ? 'forms.saveFailed' : feedback?.readError ? 'forms.loadFailed'
    : feedback?.pending && !feedback.busy ? 'forms.pendingSelection'
      : feedback?.loaded && !feedback.models.length ? 'forms.noModels' : null;
  return <div className={`bot-model-control${compact ? ' is-compact' : ''}`} data-model-id={model?.id ?? ''} data-effort={effort ?? ''}>
    <div className="bot-model-control-row">
      <AnchoredModelSelectionMenu
        className="bot-model-picker"
        groups={groups}
        selectedModelId={selectedId}
        effort={effortLevel}
        fastMode={fastMode}
        isZh={isZh}
        disabled={!feedback && (busy || !view)}
        selectionDisabled={busy || !view}
        busy={updating}
        statusLabel={feedbackKey ? i18n.t(feedbackKey) : updating ? i18n.t(feedback?.busy ? 'forms.saving' : 'forms.loading') : undefined}
        feedback={feedback ? <BotModelFeedback state={feedback} i18n={i18n} showLoading={false} showSaving={false} /> : undefined}
        label={label}
        title={`${label} · ${source} · ${i18n.t('projectAgent.model.nextReply')}`}
        onSelectModel={changeModel}
        onEffortChange={(value) => {
          if (!model || !view?.eligibleModelIds.includes(model.id)) return;
          return onChange(botFixedModelPolicy(policy, role, model, value, fastMode));
        }}
        onFastModeChange={(enabled) => {
          if (!model || !view?.eligibleModelIds.includes(model.id)) return;
          return onChange(botFixedModelPolicy(policy, role, model, effort, enabled));
        }}
      />
    </div>
    {activeSelection ? <p className="bot-model-source">{i18n.t('projectAgent.model.runningReply')}: {models.find(item => item.id === activeSelection.modelProviderId)?.label ?? i18n.t('projectAgent.model.unavailable')} · {i18n.t('projectAgent.model.nextReply')}</p> : null}
    {!compact ? <p className="bot-model-source">{view?.resolution.ok ? source : i18n.t('projectAgent.model.unavailable')}
      {model && !levels.length ? ` · ${i18n.t('projectAgent.model.noEffort')}` : ''}</p> : null}
  </div>;
}
