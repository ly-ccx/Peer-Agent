import { WorkbenchToggle } from '../../workbench/WorkbenchToggle';

interface AppHeaderProps {
  readonly isZh: boolean;
}

export function AppHeader({ isZh }: AppHeaderProps) {
  return (
    <header className="header">
      <div className="header-actions">
        <WorkbenchToggle isZh={isZh} />
      </div>
    </header>
  );
}
