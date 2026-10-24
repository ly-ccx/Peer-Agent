import { isModelReasoningEffort, modelReasoningLevels, modelSupportsFastMode, type ModelReasoningEffort } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { effortLabel } from '../../../chat/state/preferences';
import { Dropdown } from '../Dropdown';
import type { RoutingModelOption } from './modelRoutingPanelState';

/** Presentation only: an explicit clear/normal choice never changes the model binding. */
export function RoutingParameterFields({ value, candidates, inherit, disabled, label, i18n, onEffort, onChannel }: {
  readonly value: { readonly reasoningEffort?: ModelReasoningEffort | null; readonly fastMode?: boolean };
  readonly candidates: readonly RoutingModelOption[];
  readonly inherit?: { readonly reasoningEffort?: ModelReasoningEffort; readonly fastMode: boolean };
  readonly disabled: boolean;
  readonly label: string;
  readonly i18n: I18nRuntime;
  readonly onEffort: (effort: ModelReasoningEffort | null | undefined) => void;
  readonly onChannel: (fast: boolean | undefined) => void;
}) {
  const levels = candidates.length ? modelReasoningLevels(candidates[0]!).filter(level => candidates.every(model => modelReasoningLevels(model).includes(level))) : [];
  const supportsFast = candidates.length > 0 && candidates.every(modelSupportsFastMode);
  const invalidEffort = value.reasoningEffort != null && !levels.includes(value.reasoningEffort);
  const effortName = (effort?: ModelReasoningEffort | null) => effort != null
    ? effortLabel(effort, i18n.locale.startsWith('zh')) : i18n.t('modelRouting.reasoningDefault');
  const channelName = (fast: boolean) => i18n.t(fast ? 'modelRouting.channelFast' : 'modelRouting.channelNormal');
  const inherited = (value: string) => i18n.t('modelRouting.inheritedValue', { value });
  const effort = value.reasoningEffort === undefined && inherit ? 'inherit' : value.reasoningEffort ?? 'model-default';
  const channel = value.fastMode === undefined && inherit ? 'inherit' : value.fastMode === true ? 'fast' : 'normal';
  const hint = !candidates.length ? i18n.t('modelRouting.chooseCandidates') : !levels.length
    ? i18n.t('modelRouting.noSharedEffort') : invalidEffort ? i18n.t('modelRouting.reasoningInvalid') : '';
  return (
    <div className={`model-routing-parameters${supportsFast ? ' has-channel' : ''}`}>
      <div className="model-routing-parameter">
        <span className="model-routing-parameter-label">{i18n.t('modelRouting.reasoning')}</span>
        <Dropdown
          value={effort}
          disabled={disabled}
          ariaLabel={`${label} ${i18n.t('modelRouting.reasoning')}`}
          options={[
            ...(inherit ? [{ value: 'inherit', label: inherited(effortName(inherit.reasoningEffort)) }] : []),
            { value: 'model-default', label: i18n.t('modelRouting.reasoningDefault') },
            ...levels.map(level => ({ value: level, label: effortName(level) })),
            ...(invalidEffort ? [{ value: value.reasoningEffort!, label: `${effortName(value.reasoningEffort)} · ${i18n.t('modelRouting.reasoningInvalid')}`, disabled: true }] : []),
          ]}
          onChange={next => {
            if (next === 'inherit') onEffort(undefined);
            else if (next === 'model-default') onEffort(null);
            else if (isModelReasoningEffort(next) && levels.includes(next)) onEffort(next);
          }}
        />
        {hint ? <p className="model-routing-reasoning-note">{hint}</p> : null}
      </div>
      {supportsFast ? <div className="model-routing-parameter">
        <span className="model-routing-parameter-label">{i18n.t('modelRouting.channel')}</span>
        <Dropdown
          value={channel}
          disabled={disabled}
          ariaLabel={`${label} ${i18n.t('modelRouting.channel')}`}
          options={[
            ...(inherit ? [{ value: 'inherit', label: inherited(channelName(inherit.fastMode)) }] : []),
            { value: 'normal', label: channelName(false) },
            { value: 'fast', label: channelName(true) },
          ]}
          onChange={next => { if (next === 'inherit') onChannel(undefined); else if (next === 'normal') onChannel(false); else if (next === 'fast' && supportsFast) onChannel(true); }}
        />
      </div> : null}
    </div>
  );
}
