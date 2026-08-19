import type { CapabilityWorkbenchItem } from '../types';
import { useState } from 'react';
import { PeerIcon } from '../../ui/icons';

function DetailList({
  items,
}: {
  readonly items: readonly string[];
}) {
  return (
    <ol className="capability-detail-list">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ol>
  );
}

export function CapabilityDetailPanel({
  item,
  onClose,
}: {
  readonly item: CapabilityWorkbenchItem;
  readonly onClose: () => void;
}) {
  const [showManifest, setShowManifest] = useState(false);
  const manifestText = item.manifest ? JSON.stringify(item.manifest, null, 2) : null;

  return (
    <aside className="capability-detail-panel" aria-label={`${item.name} 详情`}>
      <header>
        <div className="capability-detail-title">
          <span className="capability-detail-seal">{item.originLabel === '本地' ? '本' : '云'}</span>
          <div>
            <p>能力详情</p>
            <h3>{item.name}</h3>
          </div>
        </div>
        <button type="button" aria-label="关闭详情" onClick={onClose}><PeerIcon name="close" size={14} /></button>
      </header>

      <section>
        <h4>描述</h4>
        <p>{item.description}</p>
      </section>

      <section>
        <h4>来源</h4>
        <code>{item.sourceDetail}</code>
      </section>

      {item.endpoint ? (
        <section>
          <h4>Endpoint</h4>
          <code>{item.endpoint}</code>
        </section>
      ) : null}

      <section>
        <h4>步骤 ({item.steps.length})</h4>
        <DetailList items={item.steps} />
      </section>

      <section>
        <h4>权限 · Evidence</h4>
        <DetailList items={item.permissions} />
      </section>

      {showManifest && manifestText ? (
        <section>
          <h4>Manifest</h4>
          <pre className="capability-manifest-preview">{manifestText}</pre>
        </section>
      ) : null}

      <footer>
        <button type="button" className="primary" disabled>
          {item.status === 'catalog' ? '等待安装器接入' : '已接入个人工具面'}
        </button>
        {manifestText ? (
          <button type="button" onClick={() => setShowManifest((visible) => !visible)}>
            {showManifest ? '收起 Manifest' : '查看 Manifest'}
          </button>
        ) : null}
      </footer>
    </aside>
  );
}
