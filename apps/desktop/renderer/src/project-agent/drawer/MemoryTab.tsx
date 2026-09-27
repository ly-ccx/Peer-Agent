import type { I18nRuntime } from '@peer-agent/i18n';
import type { DrawerMemoryItem } from '../state/drawerState';

export function MemoryTab({
  items,
  i18n,
}: {
  readonly items: readonly DrawerMemoryItem[];
  readonly i18n: I18nRuntime;
}) {
  return (
    <div className="bot-drawer-tab">
      <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.memory.readonly')}</p>
      {items.length === 0 ? <p>{i18n.t('projectAgent.drawer.memory.empty')}</p> : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.kind}</span>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
