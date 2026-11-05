export interface SidebarSummarySource {
  readonly preview?: {
    readonly excerpt?: string;
    readonly availability?: 'ready' | 'rebuilding' | 'version_changed' | 'damaged';
  } | null;
}

/** Classic sidebar copy reads the materialized preview only. */
export function sidebarSummaryExcerpt(conversation: SidebarSummarySource | null | undefined): string {
  const preview = conversation?.preview;
  if (!preview || preview.availability === 'rebuilding' || preview.availability === 'damaged') return '';
  return typeof preview.excerpt === 'string' ? preview.excerpt.trim() : '';
}
