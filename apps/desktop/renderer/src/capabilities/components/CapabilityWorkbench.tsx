import { useGuardedNavigation } from '../../ui/forms/UnsavedChanges';
import type { CapabilityManifest } from '@peer-agent/protocol';
import { useId, useMemo, useState } from 'react';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import {
  buildCapabilityWorkbenchItems,
  countCapabilityWorkbenchItems,
  groupCapabilityItems,
} from '../capabilityCatalog';
import type { CapabilityWorkbenchItem, CapabilityWorkbenchTab } from '../types';
import { CapabilityDetailPanel } from './CapabilityDetailPanel';
import { CapabilityEmptyState } from './CapabilityEmptyState';
import { CapabilitySection } from './CapabilitySection';
import { CapabilityTabs } from './CapabilityTabs';
import { McpSettingsPanel } from '../../app/components/McpSettingsPanel';
import { SkillsPanel } from './SkillsPanel';

const TAB_DESCRIPTIONS: Record<CapabilityWorkbenchTab, string> = {
  skills: 'Skill 由云端 Agent 调度，描述任务编排、确认点和所需能力；本地 Skill 依赖客户端授权能力执行。',
  mcp: 'MCP 是工具/资源/提示通信协议；云端 MCP 直连云 Agent，本地 MCP 通过客户端授权链调度。',
};

function firstItemForTab(items: readonly CapabilityWorkbenchItem[], tab: CapabilityWorkbenchTab) {
  return items.find((item) => item.tab === tab) ?? null;
}

export function CapabilityWorkbench({
  capabilities,
}: {
  readonly capabilities: readonly CapabilityManifest[];
}) {
  const navigate = useGuardedNavigation();
  const items = useMemo(() => buildCapabilityWorkbenchItems(capabilities), [capabilities]);
  const baseCounts = useMemo(() => countCapabilityWorkbenchItems(items), [items]);
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<CapabilityWorkbenchTab>('skills');
  const [selectedItem, setSelectedItem] = useState<CapabilityWorkbenchItem | null>(() =>
    firstItemForTab(items, 'skills'),
  );
  const [skillsUploadOpen, setSkillsUploadOpen] = useState(false);
  const installed = useResourceRead('capability-counts', async () => {
    const workspace = await clientApi.workspaceList();
    const [skills, mcp] = await Promise.all([clientApi.listSkills(workspace.workspaces.map(row => row.path)), clientApi.mcpListInstalled()]);
    return { skills: skills.length, mcp: mcp.length };
  });
  const [skillsCount, setSkillsCount] = useState<number | null>(null);
  const [mcpCount, setMcpCount] = useState<number | null>(null);
  const counts = useMemo(
    () => ({ ...baseCounts, skills: skillsCount ?? installed.value?.skills ?? null, mcp: mcpCount ?? installed.value?.mcp ?? null }),
    [baseCounts, skillsCount, mcpCount, installed.value],
  );
  const sections = useMemo(() => groupCapabilityItems(items, activeTab), [activeTab, items]);

  const changeTab = (tab: CapabilityWorkbenchTab) => {
    navigate(() => { setActiveTab(tab); setSelectedItem(firstItemForTab(items, tab)); });
  };

  return (
    <section className={`capability-workbench ${activeTab === 'skills' || activeTab === 'mcp' ? 'skills-active' : ''} ${activeTab === 'skills' ? 'marketplace' : ''}`}>
      <main className="capability-workbench-main">
        <div className="capability-tabs-row">
          <CapabilityTabs idPrefix={tabsId} activeTab={activeTab} counts={counts} onChange={changeTab} />
          {activeTab === 'skills' && (
            <button
              type="button"
              className="ui-button is-compact skill-upload-btn"
              onClick={() => setSkillsUploadOpen(true)}
            >
              <PeerIcon name="plus" size={14} />
              上传技能
            </button>
          )}
        </div>

        {installed.error ? <p className="ui-form-feedback" role="status">数量暂未更新 <button type="button" className="ui-button is-compact" onClick={() => void installed.reload()}>重新读取</button></p> : null}
        <p className="capability-hero-copy">{TAB_DESCRIPTIONS[activeTab]}</p>

        <div className="capability-sections" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${activeTab}`} tabIndex={0}>
          {activeTab === 'skills' ? (
            <SkillsPanel
              uploadOpen={skillsUploadOpen}
              onUploadOpenChange={setSkillsUploadOpen}
              onSkillsCountChange={setSkillsCount}
            />
          ) : activeTab === 'mcp' ? (
            <McpSettingsPanel embedded onServersCountChange={setMcpCount} />
          ) : sections.length === 0 ? (
            <CapabilityEmptyState tab={activeTab} />
          ) : sections.map((section) => (
            <CapabilitySection
              key={section.locality}
              activeItemId={selectedItem?.id ?? null}
              section={section}
              onSelect={setSelectedItem}
            />
          ))}
        </div>
      </main>

      {selectedItem ? (
        <CapabilityDetailPanel
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      ) : null}
    </section>
  );
}
