import { redactShellOutput } from '../runtime-gateway/shell-redaction.mjs';

const FILE_TOOLS = new Set(['read_file', 'list_files', 'search_files']);

/** Capture only a successful file Provider result; never assistant or wrapper output. */
export function fileEvidencePreview(execution) {
  const call = execution?.call;
  const result = execution?.result;
  const name = result?.outputPreview?.tool;
  if (result?.status !== 'success' || !FILE_TOOLS.has(name)
    || !['local.file.read', 'local.file.list', 'local.file.search'].includes(call?.capabilityId)) return null;
  const file = result.outputPreview.fileResult;
  if (file?.success !== true || typeof file.output !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(file.output); } catch { return null; }
  const raw = typeof parsed?.preview === 'string' ? parsed.preview : JSON.stringify(parsed, null, 2);
  if (!raw) return null;
  const text = redactShellOutput(raw).slice(0, 4000);
  return {
    kind: 'file', text,
    truncated: raw.length > 4000 || parsed.contextPreviewTruncated === true || parsed.truncated === true,
  };
}
