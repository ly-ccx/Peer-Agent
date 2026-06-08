import type { CapabilityWorkbenchItem, CapabilityWorkbenchSection } from '../types';
import { CapabilityCard } from './CapabilityCard';

export function CapabilitySection({
  activeItemId,
  section,
  onSelect,
}: {
  readonly activeItemId: string | null;
  readonly section: CapabilityWorkbenchSection;
  readonly onSelect: (item: CapabilityWorkbenchItem) => void;
}) {
  return (
    <section className="capability-section">
      <h3>{section.title}</h3>
      <div className="capability-grid">
        {section.items.map((item) => (
          <CapabilityCard
            key={item.id}
            active={activeItemId === item.id}
            item={item}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}
