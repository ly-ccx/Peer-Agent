import { useId, useState } from 'react';
import { ChoiceStrip } from '../../ui/forms/ChoiceStrip';
import { QoderMarketplacePanel } from './QoderMarketplacePanel';
import { SkillsInstalledPanel } from './SkillsInstalledPanel';
import { SkillMarketplacePanel } from './SkillMarketplacePanel';
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
  const id = useId();
  const [view, setView] = useState<'marketplace' | 'qoder' | 'installed'>('marketplace');
  const [installedRevision, setInstalledRevision] = useState(0);
  return (
    <div className="skill-panel">
      <ChoiceStrip className="skill-view-tabs" value={view} onChange={setView} label="Skill 视图" idPrefix={id} panelId={`${id}-panel`}
        options={[{ value: 'marketplace', label: 'skillhub 市场' }, { value: 'qoder', label: 'Qoder 市场' }, { value: 'installed', label: '已安装' }]} />
      <section role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${view}`} tabIndex={0}>
      {view === 'marketplace' ? (
        <SkillMarketplacePanel onInstalled={() => { setInstalledRevision((value) => value + 1); setView('installed'); }} />
      ) : view === 'qoder' ? (
        <QoderMarketplacePanel onInstalled={() => { setInstalledRevision((value) => value + 1); setView('installed'); }} />
      ) : (
        <SkillsInstalledPanel key={installedRevision} onSkillsCountChange={onSkillsCountChange} />
      )}
      </section>
      {uploadOpen && (
        <SkillUploadDialog
          onClose={() => onUploadOpenChange(false)}
          onDone={() => onUploadOpenChange(false)}
        />
      )}
    </div>
  );
}
