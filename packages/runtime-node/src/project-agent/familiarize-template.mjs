/**
 * 熟悉项目的任务形状。非空文件夹是只读 research；
 * 只有点文件或空目录时不开任务，改问职责。
 * 传入的 git 事实只是建立任务时的快照；工作者用 git_query 读取当前事实。
 */
export const FAMILIARIZE_READ_CAPABILITIES = Object.freeze([
  'local.file.list',
  'local.file.read',
  'local.git.query',
  'local.file.search',
  'local.search.aggregate',
]);

const WRITE_CAPABILITIES = new Set([
  'local.file.write',
  'local.file.edit',
  'local.shell.exec',
]);

export const RESPONSIBILITY_QUESTION = '这个机器人主要负责什么';

export function isBlankProject(entries) {
  const names = Array.isArray(entries) ? entries : [];
  return names.every((name) => typeof name !== 'string' || !name.trim() || name.trim().startsWith('.'));
}

export function familiarizeAllowsCapability(capabilityId) {
  return FAMILIARIZE_READ_CAPABILITIES.includes(capabilityId)
    && !WRITE_CAPABILITIES.has(capabilityId);
}

export function buildFamiliarizePlan({
  displayName,
  entries,
  git = null,
} = {}) {
  if (isBlankProject(entries)) {
    return {
      kind: 'blank',
      question: RESPONSIBILITY_QUESTION,
      task: null,
    };
  }
  const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : '这个项目';
  const lines = [
    `只读熟悉「${name}」。`,
    '查看目录、AGENTS.md、脚本和最近提交。',
    '只使用结构化文件读取与 git_query。不要使用 shell，不要写入、修改或执行会改变工作区的操作。',
    '用 git_query 核对当前仓库身份、工作树和最近提交；非 Git 目录如实记录，不用旧分支/提交快照代替当前检查。',
    '交付带证据引用的阅读结果；记忆是否写入由宿主按用户设置决定。无法核实的内容标为未知，并说明原因。',
    '本次目标是了解项目。发现缺陷或缺失文件也应先完成阅读报告，不要为新增修复、扩大检查或写入记忆要求用户选择。只有完成本次读取所必需且无法自行查明的决定才向用户提问。',
  ];
  if (git?.branch) lines.push(`建立任务时的分支快照（需重新核对）：${git.branch}`);
  else lines.push('没有可读的 git 分支。');
  if (git?.commit) lines.push(`建立任务时的提交快照（需重新核对）：${git.commit}`);
  return {
    kind: 'research',
    question: null,
    task: {
      kind: 'research',
      readOnly: true,
      requiredCapabilities: [...FAMILIARIZE_READ_CAPABILITIES],
      title: '熟悉项目',
      brief: lines.join('\n'),
      successCriteria: [
        { id: 'c1', kind: 'model_review', description: '用文件读取工具看过项目结构' },
        { id: 'c2', kind: 'model_review', description: '确认过的事实带有证据引用' },
        { id: 'c3', kind: 'model_review', description: '以当前 Git 读取事实核对仓库身份、工作树与最近提交；非仓库如实记录', requiredCapabilities: ['local.git.query'] },
      ],
      allowedCapabilities: [...FAMILIARIZE_READ_CAPABILITIES],
      git: git?.branch ? { branch: git.branch, commit: git.commit || null } : null,
    },
  };
}

export function buildReadmeTask({ displayName, responsibility } = {}) {
  const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : '这个项目';
  const duty = typeof responsibility === 'string' ? responsibility.trim() : '';
  return {
    kind: 'docs',
    readOnly: false,
    requiredCapabilities: ['local.file.write', 'local.file.read'],
    title: '写 README',
    brief: [
      `在「${name}」的文件夹里写一份 README，记录这个机器人的职责。`,
      duty ? `职责：${duty}` : '职责以用户刚刚说的为准。',
    ].join('\n'),
    successCriteria: [{ id: 'c1', kind: 'model_review', description: 'README 写明这个机器人主要负责什么' }],
    allowedCapabilities: ['local.file.write', 'local.file.read', 'local.file.list'],
  };
}
