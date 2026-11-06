import { ChoiceStrip } from '../../ui/forms/ChoiceStrip';
import type { CapabilityWorkbenchCounts, CapabilityWorkbenchTab } from '../types';
export function CapabilityTabs({ activeTab, counts, onChange, idPrefix }: {
  readonly idPrefix: string; readonly activeTab: CapabilityWorkbenchTab;
  readonly counts: { readonly [K in keyof CapabilityWorkbenchCounts]: number | null };
  readonly onChange: (tab: CapabilityWorkbenchTab) => void;
}) {
  return <ChoiceStrip className="capability-tabs" value={activeTab} onChange={onChange} label="能力类型"
    idPrefix={idPrefix} panelId={`${idPrefix}-panel`} options={[
      { value: 'skills', label: <>Skills {counts.skills === null ? '数量未确认' : counts.skills}</> },
      { value: 'mcp', label: <>MCP {counts.mcp === null ? '数量未确认' : counts.mcp}</> },
    ]} />;
}
