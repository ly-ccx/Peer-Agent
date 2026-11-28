import type { SkillInstallTarget } from '@peer-agent/protocol';
import { useMemo } from 'react';
import { Dropdown, type DropdownOption } from '../../app/components/Dropdown';
import { describeWorkspaceInstallError, workspaceSelectionLabel } from './marketplace-workspace-target';

const ALL_TARGETS = '';

export function MarketplaceWorkspacePicker({ targets, selectedIds, onChange, disabled }: {
  readonly targets: readonly SkillInstallTarget[];
  readonly selectedIds: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
  readonly disabled: boolean;
}) {
  const available = targets.filter((target) => target.available);
  const names = available.filter((target) => selectedIds.includes(target.workspaceId)).map((target) => target.name);
  const allSelected = available.length > 0 && names.length === available.length;
  const showSelectAll = available.length >= 2;
  const options = useMemo((): readonly DropdownOption[] => [
    ...(showSelectAll ? [{ value: ALL_TARGETS, label: allSelected ? '取消全选' : '全选' }] : []),
    ...targets.map((target) => ({
      value: target.workspaceId,
      label: target.name,
      hint: target.available ? (target.isActive ? '当前' : undefined)
        : describeWorkspaceInstallError(target.unavailableReason) ?? '不可用',
      disabled: !target.available,
    })),
  ], [targets, showSelectAll, allSelected]);
  const summary = workspaceSelectionLabel(names);
  return (
    <div className="skill-marketplace-workspace-picker">
      <Dropdown
        className="skill-marketplace-workspace-dropdown"
        ariaLabel="选择安装机器人"
        value={ALL_TARGETS}
        options={options}
        selectedValues={showSelectAll && allSelected ? [ALL_TARGETS, ...selectedIds] : selectedIds}
        triggerLabel={summary}
        title={names.join('、') || summary}
        disabled={disabled || !targets.length}
        onChange={(id) => onChange(id === ALL_TARGETS
          ? (allSelected ? [] : available.map((target) => target.workspaceId))
          : (selectedIds.includes(id) ? selectedIds.filter((selected) => selected !== id) : [...selectedIds, id]))}
      />
    </div>
  );
}
