import { useCallback, useState } from 'react';
import { SkillSubTabs, type SkillSubTab } from './SkillSubTabs';
import { SkillsInstalledPanel } from './SkillsInstalledPanel';
import { SkillsDingtalkMarketPanel } from './SkillsDingtalkMarketPanel';
import { SkillsAonePanel } from './SkillsAonePanel';
import { SkillUploadDialog } from './SkillUploadDialog';

export function SkillsPanel({
  uploadOpen,
  onUploadOpenChange,
  onSkillsCountChange,
}: {
  readonly uploadOpen: boolean;
  readonly onUploadOpenChange: (open: boolean) => void;
  readonly onSkillsCountChange?: (count: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<SkillSubTab>('installed');

  const handleUploadDone = useCallback(() => {
    onUploadOpenChange(false);
  }, [onUploadOpenChange]);

  return (
    <div className="skill-panel">
      <SkillSubTabs activeTab={activeTab} onChange={setActiveTab} />
      <div className="skill-panel-content">
        {activeTab === 'installed' && (
          <SkillsInstalledPanel onSkillsCountChange={onSkillsCountChange} />
        )}
        {activeTab === 'dingtalk' && <SkillsDingtalkMarketPanel />}
        {activeTab === 'aone' && <SkillsAonePanel />}
      </div>

      {uploadOpen && (
        <SkillUploadDialog
          onClose={() => onUploadOpenChange(false)}
          onDone={handleUploadDone}
        />
      )}
    </div>
  );
}
