import { fileEvidencePreview } from './file-evidence-preview.mjs';
import { redactShellOutput } from './output-redaction.mjs';

/** Admit only Provider execution facts; assistant text and goal wrappers are excluded. */
export function toolResultEvidencePreview(execution) {
  const file = fileEvidencePreview(execution);
  if (file) return file;
  const call = execution?.call;
  const result = execution?.result;
  if (call?.capabilityId !== 'local.shell.exec' || !call.toolCallId
    || result?.toolCallId !== call.toolCallId || result.evidence?.toolCallId !== call.toolCallId) return null;
  const allowed = execution.grant
    ? execution.grant.granted === true && execution.grant.toolCallId === call.toolCallId
    : result.permissionGrant?.decision === 'allow' && result.permissionGrant.capabilityId === call.capabilityId;
  const output = result.output ?? result.outputPreview;
  if (!allowed || !['success', 'completed'].includes(result.status)
    || !['success', 'completed'].includes(output?.status) || output.exitCode !== 0
    || output.timedOut || output.cancelled || output.interrupted) return null;
  const stdout = typeof output.stdout === 'string' ? output.stdout : '';
  const stderr = typeof output.stderr === 'string' ? output.stderr : '';
  const fact = { exitCode: 0, stdout: redactShellOutput(stdout), stderr: redactShellOutput(stderr) };
  let text = JSON.stringify(fact);
  const truncated = output.truncated === true || output.contextPreviewTruncated === true
    || stdout.length > 4000 || stderr.length > 4000
    || output.stdoutChars > stdout.length || output.stderrChars > stderr.length || text.length > 4000;
  // Bound the serialized JSON without cutting its structure or losing the exit status.
  while (text.length > 4000) {
    const key = fact.stdout.length >= fact.stderr.length ? 'stdout' : 'stderr';
    const remove = Math.max(1, Math.ceil((text.length - 4000) / 2));
    fact[key] = fact[key].slice(0, Math.max(0, fact[key].length - remove));
    text = JSON.stringify(fact);
  }
  return { kind: 'command', text, truncated };
}
