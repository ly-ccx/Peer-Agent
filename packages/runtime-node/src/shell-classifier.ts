import path from 'node:path';

export const NODE_SHELL_RISK_ORDER = {
  L0_inert: 0,
  L1_local_read: 1,
  L2_local_write: 2,
  L3_external_write: 3,
  L4_privileged: 4,
  L5_destructive: 5,
} as const;

export type NodeShellRiskLevel = keyof typeof NODE_SHELL_RISK_ORDER;
export type NodeShellCategory =
  | 'empty'
  | 'read'
  | 'write'
  | 'network'
  | 'process'
  | 'privileged'
  | 'destructive'
  | 'unknown';

export interface NodeShellClassification {
  readonly allowed: boolean;
  readonly command: string;
  readonly cwd: string;
  readonly category: NodeShellCategory;
  readonly riskLevel: NodeShellRiskLevel;
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly reason: string;
}

const READ_ONLY_COMMANDS = new Set([
  'cat', 'date', 'echo', 'find', 'grep', 'head', 'ls', 'printf', 'pwd', 'rg',
  'sed', 'tail', 'test', 'true', 'false', 'wc', 'whoami', 'which', 'type',
]);
const WRITE_COMMANDS = new Set([
  'chmod', 'chown', 'cp', 'install', 'mkdir', 'mv', 'perl', 'tee', 'touch',
]);
const NETWORK_COMMANDS = new Set([
  'curl', 'nc', 'ncat', 'netcat', 'open', 'rsync', 'scp', 'ssh', 'telnet', 'wget',
]);
const PROCESS_COMMANDS = new Set([
  'cargo', 'make', 'node', 'npm', 'npx', 'pnpm', 'python', 'python3', 'ruby', 'yarn',
]);
const PRIVILEGED_COMMANDS = new Set(['launchctl', 'mount', 'sudo', 'su', 'systemctl', 'umount']);
const DESTRUCTIVE_COMMANDS = new Set([
  'dd', 'diskutil', 'halt', 'kill', 'killall', 'mkfs', 'pkill', 'poweroff', 'reboot',
  'rm', 'shutdown',
]);
const GIT_READ_SUBCOMMANDS = new Set([
  'branch', 'diff', 'log', 'rev-parse', 'show', 'status', 'tag', 'version',
]);
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh']);
const PASS_THROUGH_WRAPPERS = new Set(['builtin', 'command', 'env']);

function insideDirectory(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function normalizeNodeShellCwd(cwd: string | undefined, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(cwd || root);
  if (!insideDirectory(root, resolved)) {
    const error = new Error('cwd_outside_workspace') as Error & { code?: string };
    error.code = 'cwd_outside_workspace';
    throw error;
  }
  return resolved;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function words(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map(stripQuotes)
    .filter(Boolean)
    .filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token));
}

function commandName(token: string | undefined): string {
  return path.basename(String(token || '')).toLowerCase();
}

function classification(
  category: NodeShellCategory,
  reason: string,
): Pick<NodeShellClassification, 'category' | 'riskLevel' | 'decision' | 'reason'> {
  switch (category) {
    case 'empty': return { category, riskLevel: 'L0_inert', decision: 'deny', reason };
    case 'read': return { category, riskLevel: 'L1_local_read', decision: 'allow', reason };
    case 'write': return { category, riskLevel: 'L2_local_write', decision: 'ask', reason };
    case 'network': return { category, riskLevel: 'L3_external_write', decision: 'ask', reason };
    case 'process': return { category, riskLevel: 'L3_external_write', decision: 'ask', reason };
    case 'privileged': return { category, riskLevel: 'L4_privileged', decision: 'deny', reason };
    case 'destructive': return { category, riskLevel: 'L5_destructive', decision: 'deny', reason };
    default: return { category, riskLevel: 'L3_external_write', decision: 'ask', reason };
  }
}

function classifySegment(segment: string): ReturnType<typeof classification> {
  if (/\$\(|`/.test(segment)) return classification('unknown', 'command_substitution');
  if (/(^|\s)(>|>>|1>|2>|&>|<<|<<<)(\s|$)/.test(segment)) {
    return classification('write', 'shell_redirection');
  }

  const tokens = words(segment);
  if (tokens.length === 0) return classification('empty', 'empty_command');
  let index = 0;
  while (PASS_THROUGH_WRAPPERS.has(commandName(tokens[index])) && index < tokens.length - 1) index += 1;
  const name = commandName(tokens[index]);
  const args = tokens.slice(index + 1);

  if (SHELL_WRAPPERS.has(name)) {
    const commandIndex = args.findIndex((token) => token === '-c' || token === '-lc');
    if (commandIndex >= 0 && args[commandIndex + 1]) {
      return classifyCommandText(args.slice(commandIndex + 1).join(' '));
    }
    return classification('process', 'interactive_shell');
  }
  if (DESTRUCTIVE_COMMANDS.has(name)) return classification('destructive', `destructive_command:${name}`);
  if (PRIVILEGED_COMMANDS.has(name)) return classification('privileged', `privileged_command:${name}`);
  if (NETWORK_COMMANDS.has(name)) return classification('network', `network_command:${name}`);
  if (PROCESS_COMMANDS.has(name)) return classification('process', `process_command:${name}`);
  if (WRITE_COMMANDS.has(name)) return classification('write', `write_command:${name}`);
  if (name === 'git') {
    const subcommand = commandName(args.find((token) => !token.startsWith('-')));
    return GIT_READ_SUBCOMMANDS.has(subcommand)
      ? classification('read', `git_read:${subcommand}`)
      : classification('write', `git_mutation:${subcommand || 'unknown'}`);
  }
  if (READ_ONLY_COMMANDS.has(name)) return classification('read', `read_command:${name}`);
  return classification('unknown', `unknown_command:${name}`);
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const doubleSeparator = (char === '&' && next === '&') || (char === '|' && next === '|');
    if (doubleSeparator) {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (char === ';' || char === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function classifyCommandText(command: string): ReturnType<typeof classification> {
  const segments = splitCommandSegments(command).map(classifySegment);
  if (segments.length === 0) return classification('empty', 'empty_command');
  return segments.reduce((left, right) =>
    NODE_SHELL_RISK_ORDER[right.riskLevel] > NODE_SHELL_RISK_ORDER[left.riskLevel]
      ? right
      : left,
  );
}

export function classifyNodeShellCommand({
  command,
  cwd,
  workspaceRoot,
}: {
  readonly command: unknown;
  readonly cwd?: string;
  readonly workspaceRoot: string;
}): NodeShellClassification {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  const resolvedCwd = normalizeNodeShellCwd(cwd, workspaceRoot);
  const parsed = classifyCommandText(normalizedCommand);
  return {
    allowed: parsed.category !== 'empty',
    command: normalizedCommand,
    cwd: resolvedCwd,
    ...parsed,
  };
}

export function compareNodeShellRisk(left: NodeShellRiskLevel, right: NodeShellRiskLevel): number {
  return NODE_SHELL_RISK_ORDER[left] - NODE_SHELL_RISK_ORDER[right];
}
