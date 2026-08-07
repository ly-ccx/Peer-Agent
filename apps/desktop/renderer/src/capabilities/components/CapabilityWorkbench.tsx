import type { CapabilityManifest } from '@peer-agent/protocol';
import { useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
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
  const items = useMemo(() => buildCapabilityWorkbenchItems(capabilities), [capabilities]);
  const baseCounts = useMemo(() => countCapabilityWorkbenchItems(items), [items]);
  const [activeTab, setActiveTab] = useState<CapabilityWorkbenchTab>('skills');
  const [selectedItem, setSelectedItem] = useState<CapabilityWorkbenchItem | null>(() =>
    firstItemForTab(items, 'skills'),
  );
  const [skillsUploadOpen, setSkillsUploadOpen] = useState(false);
  const [skillsCount, setSkillsCount] = useState(0);
  const [mcpCount, setMcpCount] = useState(0);
  useEffect(() => {
    void clientApi.mcpListInstalled().then((list) => setMcpCount(list.length)).catch(() => {});
  }, []);
  const counts = useMemo(
    () => ({ ...baseCounts, skills: skillsCount, mcp: mcpCount }),
    [baseCounts, skillsCount, mcpCount],
  );
  const sections = useMemo(() => groupCapabilityItems(items, activeTab), [activeTab, items]);

  const changeTab = (tab: CapabilityWorkbenchTab) => {
    setActiveTab(tab);
    setSelectedItem(firstItemForTab(items, tab));
  };

  return (
    <section className={`capability-workbench ${activeTab === 'skills' || activeTab === 'mcp' ? 'skills-active' : ''} ${activeTab === 'skills' ? 'marketplace' : ''}`}>
      <main className="capability-workbench-main">
        <div className="capability-tabs-row">
          <CapabilityTabs activeTab={activeTab} counts={counts} onChange={changeTab} />
          {activeTab === 'skills' && (
            <button
              type="button"
              className="skill-upload-btn"
              onClick={() => setSkillsUploadOpen(true)}
            >
              ＋ 上传技能
            </button>
          )}
        </div>

        <p className="capability-hero-copy">{TAB_DESCRIPTIONS[activeTab]}</p>

        <div className="capability-sections">
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
