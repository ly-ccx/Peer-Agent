import type { DropdownOption } from '../../app/components/Dropdown';
import { Dropdown } from '../../app/components/Dropdown';
import type { LocalAccessLevel } from '@peer-agent/protocol';
import { useBotAccessPolicy } from '../../project-agent/state/useBotAccessPolicy';
import { accessLevelLabel } from '../state/preferences';
import '../../project-agent/styles/bot-access-control.css';

/** Bot work has no independent selector. Independent classic conversations retain their preference. */
export function ConversationAccessControl({ conversationId, isZh, value, options, onChange, title, onOpenBot }: {
  readonly conversationId: string | null; readonly isZh: boolean; readonly value: LocalAccessLevel;
  readonly options: readonly DropdownOption[]; readonly onChange: (value: string) => void; readonly title: string;
  readonly onOpenBot?: (workspaceId: string) => void;
}) {
  const access = useBotAccessPolicy({ conversationId: conversationId ?? '' });
  if (conversationId && (access.loading || access.error)) return <button type="button" className="conversation-access-inherited"
    disabled={access.loading} onClick={() => void access.refresh()}>{isZh ? access.loading ? '确认权限…' : '权限未能读取，点击重试' : access.loading ? 'Checking access…' : 'Access unavailable. Retry'}</button>;
  if (access.view?.policy) return <button type="button" className="conversation-access-inherited"
    onClick={() => { if (access.view?.policy) onOpenBot?.(access.view.policy.workspaceId); }}
    title={isZh ? '返回主 Bot 管理权限' : 'Manage access in the Bot conversation'}>
    <span>{isZh ? '继承自主 Bot' : 'Inherited from Bot'} · {accessLevelLabel(access.view.policy.accessLevel, isZh)}</span>
  </button>;
  return <Dropdown className="composer-dropdown composer-access-dropdown" value={value} options={options} onChange={onChange}
    ariaLabel={isZh ? '本地访问模式' : 'Local access mode'} title={title} menuPlacement="up" />;
}
