import type { I18nRuntime } from '@peer-agent/i18n';
import { Dropdown } from './Dropdown';
import { splitBotTime, updateBotTime } from '../state/botTimeField';
const choices = (count: number) => Array.from({ length: count }, (_, i) => ({ value: String(i).padStart(2, '0'), label: String(i).padStart(2, '0') }));
const HOURS = choices(24), MINUTES = choices(60);
export function BotTimeField({ value, label, disabled, onChange, i18n }: {
  value: string; label: string; disabled: boolean; onChange: (value: string) => void; i18n: I18nRuntime;
}) {
  const [hour, minute] = splitBotTime(value);
  return <div className="general-bot-time" role="group" aria-label={label}>
    <Dropdown value={hour} options={HOURS} disabled={disabled} ariaLabel={i18n.t('projectAgent.settings.hour', { label })}
      onChange={next => onChange(updateBotTime(value, 'hour', next))} />
    <span aria-hidden="true">:</span>
    <Dropdown value={minute} options={MINUTES} disabled={disabled} ariaLabel={i18n.t('projectAgent.settings.minute', { label })}
      onChange={next => onChange(updateBotTime(value, 'minute', next))} />
  </div>;
}
