import type { I18nRuntime } from '@peer-agent/i18n';
import { Dropdown } from './Dropdown';
export function BotTargetPicker({ bots, value, onChange, disabled, i18n }: {
  bots: readonly { workspaceId: string; name: string }[]; value: string;
  onChange: (id: string) => void; disabled: boolean; i18n: I18nRuntime;
}) {
  return <Dropdown value={value} options={bots.map(bot => ({ value: bot.workspaceId, label: bot.name }))}
    onChange={onChange} disabled={disabled || !bots.length} ariaLabel={i18n.t('projectAgent.quick.chooseBot')}
    placeholder={i18n.t('projectAgent.quick.noBots')} menuPlacement="up" className="quick-chat-bot-picker" />;
}
