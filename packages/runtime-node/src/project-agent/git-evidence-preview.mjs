/** Only actual, authorized Provider observations can enter the verification snapshot. */
export function gitEvidencePreview(execution) {
  const call = execution?.call, result = execution?.result;
  if (call?.capabilityId !== 'local.git.query' || !call.toolCallId || result?.toolCallId !== call.toolCallId
    || result.evidence?.toolCallId !== call.toolCallId || !['success', 'completed'].includes(result.status)) return null;
  const allowed = execution.grant ? execution.grant.granted === true && execution.grant.toolCallId === call.toolCallId
    : result.permissionGrant?.decision === 'allow' && result.permissionGrant.capabilityId === call.capabilityId;
  const output = result.outputPreview;
  if (!allowed || output?.kind !== 'local_git_observation') return null;
  const fact = { repositoryPath: output.repositoryPath, operation: output.operation, startedAt: output.startedAt, finishedAt: output.finishedAt,
    head: output.head, branch: output.branch, unborn: output.unborn, origin: output.origin,
    consistent: output.consistent, atomic: false, status: output.status, commits: output.commits, artifactPath: output.artifactPath };
  let text = JSON.stringify(fact);
  while (text.length > 4000 && (fact.status?.entries?.length || fact.commits?.length)) {
    if (fact.status?.entries?.length) { fact.status = { ...fact.status, entries: fact.status.entries.slice(0, -1), truncated: true }; }
    else fact.commits = fact.commits.slice(0, -1);
    text = JSON.stringify(fact);
  }
  return { kind: 'observation', text: text.slice(0, 4000), truncated: output.contextPreviewTruncated === true || text.length > 4000 };
}
