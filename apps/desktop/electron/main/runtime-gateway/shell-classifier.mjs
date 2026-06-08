import path from 'node:path';

export const SHELL_RISK_ORDER = {
  L0_inert: 0,
  L1_local_read: 1,
  L2_local_write: 2,
  L3_external_write: 3,
  L4_privileged: 4,
  L5_destructive: 5,
};

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'date',
  'echo',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'tail',
  'wc',
  'whoami',
]);

const WRITE_COMMANDS = new Set([
  'chmod',
  'chown',
  'cp',
  'git',
  'mkdir',
  'mv',
  'perl',
  'sed',
  'tee',
  'touch',
]);

const NETWORK_COMMANDS = new Set([
  'curl',
  'nc',
  'ncat',
  'netcat',
  'open',
  'rsync',
  'scp',
  'ssh',
  'telnet',
  'wget',
]);

const PROCESS_COMMANDS = new Set([
  'cargo',
  'make',
  'node',
  'npm',
  'pnpm',
  'python',
  'python3',
  'yarn',
]);

const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh']);
const PASS_THROUGH_WRAPPERS = new Set(['builtin', 'command']);
const COMMAND_SEPARATORS = new Set([';', '&&', '||', '|', '|&']);
const WRITE_OPERATORS = new Set(['>', '>>', '2>', '&>', '1>']);
const HEREDOC_OPERATORS = new Set(['<<', '<<<']);

function isInsideDirectory(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function normalizeShellCwd(cwd, workspaceRoot) {
  const resolved = path.resolve(cwd || workspaceRoot);
  if (!isInsideDirectory(workspaceRoot, resolved)) {
    const err = new Error('Shell cwd must stay inside the active workspace.');
    err.code = 'cwd_outside_workspace';
    throw err;
  }
  return resolved;
}

function stripCommandPath(commandName) {
  return path.basename(String(commandName || ''));
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function mergeClassification(left, right) {
  if (!left) return right;
  if (!right) return left;
  return SHELL_RISK_ORDER[right.riskLevel] > SHELL_RISK_ORDER[left.riskLevel] ? right : left;
}

function tokenizeShell(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  function flush() {
    if (current !== '') {
      tokens.push({ type: 'word', value: current });
      current = '';
    }
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    if (char === '2' && next === '>') {
      flush();
      tokens.push({ type: 'operator', value: '2>' });
      index += 1;
      continue;
    }

    if (char === '1' && next === '>') {
      flush();
      tokens.push({ type: 'operator', value: '1>' });
      index += 1;
      continue;
    }

    if (char === '&' && next === '>') {
      flush();
      tokens.push({ type: 'operator', value: '&>' });
      index += 1;
      continue;
    }

    if (char === '|' && next === '&') {
      flush();
      tokens.push({ type: 'operator', value: '|&' });
      index += 1;
      continue;
    }

    if ((char === '&' && next === '&') || (char === '|' && next === '|') || (char === '>' && next === '>') || (char === '<' && next === '<')) {
      flush();
      tokens.push({ type: 'operator', value: `${char}${next}` });
      index += 1;
      continue;
    }

    if (';|&<>'.includes(char)) {
      flush();
      tokens.push({ type: 'operator', value: char });
      continue;
    }

    current += char;
  }

  flush();
  return {
    tokens,
    parseError: quote ? 'unterminated_quote' : null,
  };
}

function splitSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === 'operator' && COMMAND_SEPARATORS.has(token.value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function classifyGit(tokens) {
  const subcommand = tokens[1];
  if (['status', 'diff', 'log', 'branch', 'rev-parse', 'show', 'remote'].includes(subcommand)) {
    if (subcommand === 'branch' && tokens.some((token) => ['-d', '-D', '--delete'].includes(token))) {
      return category('write', 'git_branch_delete');
    }
    return category('read-only', 'git_read_only');
  }
  if (subcommand === 'reset' && tokens.includes('--hard')) return category('destructive', 'git_reset_hard');
  if (subcommand === 'clean' && tokens.some((token) => token.startsWith('-') && token.includes('f'))) {
    return category('destructive', 'git_clean_force');
  }
  if (['push', 'pull', 'fetch', 'clone'].includes(subcommand)) return category('network', 'git_network');
  return category('write', 'git_write_operation');
}

function classifyPackageCommand(commandName, tokens) {
  const joined = tokens.join(' ');
  if (/\b(add|install|remove|uninstall|publish)\b/.test(joined)) {
    return category('network', `${commandName}_dependency_or_publish`);
  }
  if (/\b(test|typecheck|lint|build|check)\b/.test(joined)) {
    return category('process-control', `${commandName}_project_command`);
  }
  return category('process-control', `${commandName}_command`);
}

function category(kind, reason) {
  if (kind === 'read-only') {
    return {
      category: kind,
      reason,
      riskLevel: 'L1_local_read',
      dataLevel: 'D1_internal',
      requiresApproval: false,
      defaultBehavior: 'allow',
    };
  }
  if (kind === 'write') {
    return {
      category: kind,
      reason,
      riskLevel: 'L2_local_write',
      dataLevel: 'D2_sensitive',
      requiresApproval: true,
      defaultBehavior: 'ask',
    };
  }
  if (kind === 'network') {
    return {
      category: kind,
      reason,
      riskLevel: 'L3_external_write',
      dataLevel: 'D2_sensitive',
      requiresApproval: true,
      defaultBehavior: 'ask',
    };
  }
  if (kind === 'process-control') {
    return {
      category: kind,
      reason,
      riskLevel: 'L4_privileged',
      dataLevel: 'D2_sensitive',
      requiresApproval: true,
      defaultBehavior: 'ask',
    };
  }
  if (kind === 'destructive') {
    return {
      category: kind,
      reason,
      riskLevel: 'L5_destructive',
      dataLevel: 'D3_private',
      requiresApproval: true,
      defaultBehavior: 'deny',
    };
  }
  return {
    category: 'unknown',
    reason,
    riskLevel: 'L4_privileged',
    dataLevel: 'D2_sensitive',
    requiresApproval: true,
    defaultBehavior: 'ask',
  };
}

function classifySimpleSegment(words) {
  let tokens = words.filter(Boolean);
  const features = [];
  while (tokens.length > 0 && isEnvAssignment(tokens[0])) {
    features.push('env_prefix');
    tokens = tokens.slice(1);
  }

  if (tokens.length === 0) return category('unknown', 'empty_segment_after_env_prefix');

  let commandName = stripCommandPath(tokens[0]);

  if (tokens[0] === 'env') {
    features.push('env_wrapper');
    let offset = 1;
    while (tokens[offset]?.startsWith('-') || isEnvAssignment(tokens[offset])) offset += 1;
    tokens = tokens.slice(offset);
    commandName = stripCommandPath(tokens[0]);
  }

  if (PASS_THROUGH_WRAPPERS.has(commandName)) {
    features.push('pass_through_wrapper');
    tokens = tokens.slice(1);
    commandName = stripCommandPath(tokens[0]);
  }

  if (!commandName) return category('unknown', 'missing_command');

  if (SHELL_WRAPPERS.has(commandName) && tokens.includes('-c')) {
    const commandIndex = tokens.findIndex((token) => token === '-c') + 1;
    const nestedCommand = tokens[commandIndex];
    if (!nestedCommand) return category('unknown', 'shell_wrapper_without_command');
    const nested = classifyParsedCommand(nestedCommand);
    return {
      ...nested,
      reason: `shell_wrapper:${nested.reason}`,
      features: [...new Set([...(nested.features ?? []), 'shell_wrapper'])],
    };
  }

  if (commandName === 'sudo') return category('destructive', 'sudo');
  if (commandName === 'rm') return category('destructive', 'rm');
  if (commandName === 'dd' || commandName === 'mkfs' || commandName === 'shutdown' || commandName === 'reboot') {
    return category('destructive', commandName);
  }
  if (commandName === 'chmod' && tokens.includes('-R') && tokens.includes('777')) {
    return category('destructive', 'chmod_recursive_777');
  }
  if (commandName === 'docker' && tokens[1] === 'system' && tokens[2] === 'prune') {
    return category('destructive', 'docker_system_prune');
  }
  if (commandName === 'find' && tokens.includes('-delete')) return category('destructive', 'find_delete');
  if (commandName === 'find' && tokens.includes('-exec')) return category('process-control', 'find_exec');
  if (commandName === 'git') return classifyGit(tokens);
  if (commandName === 'sed' && tokens.some((token) => token === '-i' || token.startsWith('-i'))) {
    return category('write', 'sed_in_place');
  }
  if (commandName === 'perl' && tokens.some((token) => token.includes('i'))) {
    return category('write', 'perl_in_place');
  }
  if (NETWORK_COMMANDS.has(commandName)) return category('network', commandName);
  if (PROCESS_COMMANDS.has(commandName)) return classifyPackageCommand(commandName, tokens);
  if (WRITE_COMMANDS.has(commandName)) return category('write', commandName);
  if (READ_ONLY_COMMANDS.has(commandName)) return category('read-only', commandName);

  const result = category('unknown', `unknown_command:${commandName}`);
  result.features = features;
  return result;
}

function classifyParsedCommand(command) {
  const { tokens, parseError } = tokenizeShell(command);
  if (parseError) return category('unknown', parseError);

  let selected = null;
  const features = [];
  for (const token of tokens) {
    if (token.type === 'operator' && WRITE_OPERATORS.has(token.value)) features.push('redirect_write');
    if (token.type === 'operator' && HEREDOC_OPERATORS.has(token.value)) features.push('heredoc');
    if (token.type === 'operator' && token.value === '|') features.push('pipeline');
    if (token.type === 'operator' && [';', '&&', '||'].includes(token.value)) features.push('compound');
  }

  if (features.includes('heredoc')) selected = mergeClassification(selected, category('unknown', 'heredoc'));
  if (features.includes('redirect_write') || tokens.some((token) => token.type === 'word' && token.value === 'tee')) {
    selected = mergeClassification(selected, category('write', 'write_redirection'));
  }

  for (const segment of splitSegments(tokens)) {
    const words = segment.filter((token) => token.type === 'word').map((token) => token.value);
    selected = mergeClassification(selected, classifySimpleSegment(words));
  }

  return {
    ...(selected ?? category('unknown', 'empty_command')),
    features: [...new Set([...(selected?.features ?? []), ...features])],
  };
}

export function classifyShellCommand({ command, cwd, workspaceRoot }) {
  const normalizedCommand = String(command || '').trim();
  const resolvedCwd = normalizeShellCwd(cwd, workspaceRoot);
  if (!normalizedCommand) {
    return {
      allowed: false,
      category: 'empty',
      reason: 'empty_command',
      riskLevel: 'L0_inert',
      dataLevel: 'D0_public',
      requiresApproval: false,
      defaultBehavior: 'deny',
      command: normalizedCommand,
      cwd: resolvedCwd,
      features: [],
    };
  }

  const parsed = classifyParsedCommand(normalizedCommand);
  return {
    allowed: parsed.category !== 'empty',
    ...parsed,
    command: normalizedCommand,
    cwd: resolvedCwd,
  };
}

export function compareRisk(left, right) {
  return SHELL_RISK_ORDER[left] - SHELL_RISK_ORDER[right];
}
