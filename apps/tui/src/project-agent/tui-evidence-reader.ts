import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { evidenceBodyFromRecord, type createGoalPlanStore } from '@peer-agent/runtime-node';

/** Resolve only artifacts registered on a real evidence record; paths are never accepted. */
export function createTuiEvidenceReader(options: {
  dataHome: string;
  plans: ReturnType<typeof createGoalPlanStore>;
  readWatchEvidence?: (ref: string) => any;
}) {
  function artifact(ref: string, record: any) {
    const match = /^local-(shell|browser)-artifact:\/\/([A-Za-z0-9_-]{1,128})\/(stdout|stderr|content|metadata|screenshot)$/.exec(ref);
    const date = typeof record.createdAt === 'string' ? record.createdAt.slice(0, 10) : '';
    if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const names: Record<string, string> = match[1] === 'shell'
      ? { stdout: 'stdout.txt', stderr: 'stderr.txt', metadata: 'metadata.json' }
      : { content: 'content.txt', metadata: 'metadata.json', screenshot: 'screenshot.png' };
    const name = names[match[3]!];
    if (!name) return '';
    const file = path.join(options.dataHome, `${match[1]}-artifacts`, date, match[2]!, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return '';
      if (name.endsWith('.png')) return ref;
      if (stat.size > 256 * 1024) return '';
      return readFileSync(file, 'utf8');
    } catch { return ''; }
  }
  return (ref: string): any => {
    const record = options.plans.findEvidenceIndexRecords?.([ref])?.[0];
    return record ? evidenceBodyFromRecord(record, (value: string) => artifact(value, record)) : options.readWatchEvidence?.(ref) ?? null;
  };
}
