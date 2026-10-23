/** Explain the layer that refused this call; never infer an OS failure from admission. */
export function capabilityDenial({ reason, capabilityId, toolName, stage = 'role', locale = 'zh-CN' }) {
  const alternatives = capabilityId === 'local.shell.exec' || toolName === 'bash'
    ? ['git_query', 'read_file', 'list_files'] : [];
  const zh = locale !== 'en-US';
  const subject = toolName || capabilityId || (zh ? '该能力' : 'this capability');
  const explanation = stage === 'projection'
    ? (zh ? `当前回合未提供 ${subject}，该调用没有执行。` : `${subject} is not provided in this turn; the call was not executed.`)
    : reason === 'read_only'
      ? (zh ? `当前任务是只读任务，未准入 ${subject}。` : `This read-only task does not admit ${subject}.`)
      : (zh ? `当前主 bot 角色不允许执行 ${subject}。` : `The main bot role cannot execute ${subject}.`);
  return { message: explanation + (alternatives.length ? (zh ? '只读 Git 查询可使用已提供的 git_query，文件读取使用结构化文件工具。'
    : 'Use the provided git_query for repository observations and structured file tools for reads.') : '')
    + (stage === 'role' ? (zh ? '提高访问档位不会解除角色限制。' : 'Full access does not override role limits.') : ''),
    diagnostic: { stage, reason, capabilityId, alternatives, retryable: false, userActionRequired: false } };
}
