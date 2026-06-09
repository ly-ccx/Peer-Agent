import { SkillsInstalledPanel } from './SkillsInstalledPanel';
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
  return (
    <div className="skill-panel">
      <SkillsInstalledPanel onSkillsCountChange={onSkillsCountChange} />
      {uploadOpen && (
        <SkillUploadDialog
          onClose={() => onUploadOpenChange(false)}
          onDone={() => onUploadOpenChange(false)}
        />
      )}
    </div>
  );
}
