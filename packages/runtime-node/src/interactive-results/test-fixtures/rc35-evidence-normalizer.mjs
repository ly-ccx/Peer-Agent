// Exact RC35 normalizer from 4a58e2846875f85de69915764a127096721c5b0d.
// Keep this immutable: compatibility tests exercise the old writer, not a facsimile.
import { normalizeEvidenceRefList, normalizeOptionalString } from "../../goal-plan-domain.mjs";

export function normalizeEvidenceIndexRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const evidenceRef = normalizeOptionalString(value.evidenceRef);
  if (!evidenceRef) return null;
  const createdAt = normalizeOptionalString(value.createdAt) || new Date().toISOString();
  const record = { evidenceRef, createdAt };
  const optionalFields = [
    'planId',
    'conversationId',
    'streamId',
    'toolCallId',
    'capabilityId',
    'toolName',
  ];
  for (const field of optionalFields) {
    const normalized = normalizeOptionalString(value[field]);
    if (normalized) record[field] = normalized;
  }
  const artifactRefs = normalizeEvidenceRefList(value.artifactRefs);
  if (artifactRefs.length > 0) record.artifactRefs = artifactRefs;
  const userArtifacts = Array.isArray(value.userArtifacts)
    ? value.userArtifacts
      .filter((artifact) => artifact && typeof artifact === 'object')
      .map((artifact) => {
        const kind = ['code-change', 'file', 'image'].includes(artifact.kind) ? artifact.kind : null;
        const ref = normalizeOptionalString(artifact.ref);
        const label = normalizeOptionalString(artifact.label);
        if (!kind || !ref || !label) return null;
        const normalized = { kind, ref, label };
        const artifactPath = normalizeOptionalString(artifact.path);
        if (artifactPath) normalized.path = artifactPath;
        // 新建文件（kind='file'）同样带增删统计，因此不能只放行 code-change，
        // 否则「新建文件」这一类产物的 +N/−M 会在持久化这一层被丢掉。
        if ((kind === 'code-change' || kind === 'file') && artifact.preview?.kind === 'code') {
          const additions = Number.isSafeInteger(artifact.preview.additions) && artifact.preview.additions >= 0
            ? artifact.preview.additions
            : 0;
          const deletions = Number.isSafeInteger(artifact.preview.deletions) && artifact.preview.deletions >= 0
            ? artifact.preview.deletions
            : 0;
          const diffLines = Array.isArray(artifact.preview.diffLines)
            ? artifact.preview.diffLines
              .filter((line) => typeof line === 'string')
              .slice(0, 41)
              .map((line) => line.slice(0, 240))
            : [];
          if (diffLines.length > 0) normalized.preview = { kind: 'code', additions, deletions, diffLines };
        }
        if (kind === 'image' && artifact.preview?.kind === 'image') {
          const dataUrl = normalizeOptionalString(artifact.preview.dataUrl);
          const width = Number.isSafeInteger(artifact.preview.width) && artifact.preview.width > 0
            ? Math.min(640, artifact.preview.width)
            : 0;
          const height = Number.isSafeInteger(artifact.preview.height) && artifact.preview.height > 0
            ? Math.min(640, artifact.preview.height)
            : 0;
          if (dataUrl && dataUrl.length <= 512 * 1024
            && /^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)
            && width > 0 && height > 0) {
            normalized.preview = { kind: 'image', dataUrl, width, height };
          }
        }
        return normalized;
      })
      .filter(Boolean)
    : [];
  if (userArtifacts.length > 0) record.userArtifacts = userArtifacts;
  const filePreview = value.bodyPreview?.kind === 'file'
    && ['local.file.read', 'local.file.list', 'local.file.search'].includes(record.capabilityId)
    && ['read_file', 'list_files', 'search_files'].includes(record.toolName);
  const commandPreview = value.bodyPreview?.kind === 'command' && record.capabilityId === 'local.shell.exec'
    && ['bash', 'Bash'].includes(record.toolName);
  if ((filePreview || commandPreview) && typeof value.bodyPreview.text === 'string') {
    record.bodyPreview = {
      kind: value.bodyPreview.kind, text: value.bodyPreview.text.slice(0, 4000),
      truncated: value.bodyPreview.truncated === true || value.bodyPreview.text.length > 4000,
    };
  }
  return record;
}

