import type { I18nRuntime } from '@peer-agent/i18n';
import type { CapabilityManifest } from '@peer-agent/protocol';

export function CapabilityInventory({
  capabilities,
  i18n,
}: {
  readonly capabilities: readonly CapabilityManifest[];
  readonly i18n: I18nRuntime;
}) {
  return (
    <section className="inventory-section">
      <div className="section-heading">
        <h2>{i18n.t('runtime.capabilities')}</h2>
        <span>{capabilities.length}</span>
      </div>
      {capabilities.length === 0 ? <p className="empty-inline">{i18n.t('runtime.noCapabilities')}</p> : null}
      <div className="inventory-list">
        {capabilities.map((capability) => (
          <article key={capability.capabilityId} className="inventory-row">
            <div>
              <strong>{i18n.capabilityName(capability)}</strong>
              <p>{i18n.capabilityDescription(capability)}</p>
            </div>
            <div className="row-meta">
              <span>{capability.capabilityId}</span>
              <span>{capability.source}</span>
              <span>{capability.riskLevel}</span>
              <span>{capability.dataLevel}</span>
              <span>{capability.health}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
