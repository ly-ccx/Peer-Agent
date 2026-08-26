import { useState } from 'react';
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
  const [view, setView] = useState<'marketplace' | 'installed'>('marketplace');
  const [installedRevision, setInstalledRevision] = useState(0);
  return (
    <div className="skill-panel">
      <nav className="skill-view-tabs" aria-label="Skill 视图">
        <button type="button" className={view === 'marketplace' ? 'active' : ''} onClick={() => setView('marketplace')}>腾讯市场</button>
        <button type="button" className={view === 'installed' ? 'active' : ''} onClick={() => setView('installed')}>已安装</button>
      </nav>
      {view === 'marketplace' ? (
        <SkillMarketplacePanel onInstalled={() => { setInstalledRevision((value) => value + 1); setView('installed'); }} />
      ) : (
        <SkillsInstalledPanel key={installedRevision} onSkillsCountChange={onSkillsCountChange} />
      )}
      {uploadOpen && (
        <SkillUploadDialog
          onClose={() => onUploadOpenChange(false)}
          onDone={() => onUploadOpenChange(false)}
        />
      )}
    </div>
  );
}
