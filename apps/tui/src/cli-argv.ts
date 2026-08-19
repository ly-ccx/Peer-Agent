import { formatPeerVersionLine } from './cli-version.ts';
import { CLI_EXIT } from './cli-exit.ts';

export type ExecAccess = 'ask' | 'session' | 'full';
export type ExecOutputFormat = 'text' | 'json';
export type ExecMode = 'chat' | 'plan' | 'goal';

export interface PeerExecOptions {
  readonly access: ExecAccess;
  readonly tools: readonly string[] | undefined;
  readonly outputFormat: ExecOutputFormat;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly mode: ExecMode;
  readonly workspace: string | undefined;
  readonly maxTurns: number | undefined;
  readonly promptParts: readonly string[];
}

export type PeerCliCommand =
  | { readonly kind: 'version' }
  | { readonly kind: 'help'; readonly topic: 'root' | 'exec' }
  | { readonly kind: 'tui' }
  | { readonly kind: 'exec'; readonly options: PeerExecOptions }
  | { readonly kind: 'error'; readonly message: string; readonly exitCode: typeof CLI_EXIT.usage };

const ACCESS_VALUES = new Set<ExecAccess>(['ask', 'session', 'full']);
const OUTPUT_VALUES = new Set<ExecOutputFormat>(['text', 'json']);
const MODE_VALUES = new Set<ExecMode>(['chat', 'plan', 'goal']);

function isHelpFlag(value: string): boolean {
  return value === '--help' || value === '-h';
}

function splitFlag(arg: string): { readonly name: string; readonly inline?: string } | null {
  if (arg === '--') return { name: '--' };
  if (!arg.startsWith('-') || arg === '-') return null;
  const eq = arg.indexOf('=');
  if (eq === -1) return { name: arg };
  return { name: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

function readValue(
  name: string,
  inline: string | undefined,
  rest: string[],
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  if (inline !== undefined) {
    if (!inline.trim()) return { ok: false, message: `peer exec: ${name} requires a value` };
    return { ok: true, value: inline };
  }
  const next = rest.shift();
  if (!next || next.startsWith('-') && next !== '-') {
    return { ok: false, message: `peer exec: ${name} requires a value` };
  }
  return { ok: true, value: next };
}

function parseExecArgs(argv: readonly string[]): PeerCliCommand {
  const rest = [...argv];
  let access: ExecAccess = 'session';
  let tools: string[] | undefined;
  let outputFormat: ExecOutputFormat = 'text';
  let provider: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let mode: ExecMode = 'chat';
  let workspace: string | undefined;
  let maxTurns: number | undefined;
  const promptParts: string[] = [];
  let endOfFlags = false;

  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (endOfFlags) {
      promptParts.push(arg);
      continue;
    }
    if (isHelpFlag(arg)) {
      return { kind: 'help', topic: 'exec' };
    }
    const flag = splitFlag(arg);
    if (!flag) {
      promptParts.push(arg);
      continue;
    }
    if (flag.name === '--') {
      endOfFlags = true;
      continue;
    }
    if (flag.name === '--access') {
      const value = readValue('--access', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      if (!ACCESS_VALUES.has(value.value as ExecAccess)) {
        return {
          kind: 'error',
          message: 'peer exec: --access must be ask, session, or full',
          exitCode: CLI_EXIT.usage,
        };
      }
      access = value.value as ExecAccess;
      continue;
    }
    if (flag.name === '--tools') {
      const value = readValue('--tools', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      const tokens = value.value.split(',').map((item) => item.trim()).filter(Boolean);
      if (tokens.length === 0) {
        return { kind: 'error', message: 'peer exec: --tools requires a value', exitCode: CLI_EXIT.usage };
      }
      tools = tokens;
      continue;
    }
    if (flag.name === '--output-format') {
      const value = readValue('--output-format', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      if (!OUTPUT_VALUES.has(value.value as ExecOutputFormat)) {
        return {
          kind: 'error',
          message: 'peer exec: --output-format must be text or json',
          exitCode: CLI_EXIT.usage,
        };
      }
      outputFormat = value.value as ExecOutputFormat;
      continue;
    }
    if (flag.name === '--provider') {
      const value = readValue('--provider', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      provider = value.value;
      continue;
    }
    if (flag.name === '--model') {
      const value = readValue('--model', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      model = value.value;
      continue;
    }
    if (flag.name === '--effort') {
      const value = readValue('--effort', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      effort = value.value;
      continue;
    }
    if (flag.name === '--mode') {
      const value = readValue('--mode', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      if (!MODE_VALUES.has(value.value as ExecMode)) {
        return {
          kind: 'error',
          message: 'peer exec: --mode must be chat, plan, or goal',
          exitCode: CLI_EXIT.usage,
        };
      }
      mode = value.value as ExecMode;
      continue;
    }
    if (flag.name === '--workspace') {
      const value = readValue('--workspace', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      workspace = value.value;
      continue;
    }
    if (flag.name === '--max-turns') {
      const value = readValue('--max-turns', flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      const parsed = Number(value.value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return {
          kind: 'error',
          message: 'peer exec: --max-turns must be a positive integer',
          exitCode: CLI_EXIT.usage,
        };
      }
      maxTurns = parsed;
      continue;
    }
    return {
      kind: 'error',
      message: `peer exec: unknown option ${flag.name}`,
      exitCode: CLI_EXIT.usage,
    };
  }

  return {
    kind: 'exec',
    options: {
      access,
      tools,
      outputFormat,
      provider,
      model,
      effort,
      mode,
      workspace,
      maxTurns,
      promptParts,
    },
  };
}

export function parsePeerArgv(argv: readonly string[]): PeerCliCommand {
  if (argv.some((arg) => arg === '--version' || arg === '-v')) {
    return { kind: 'version' };
  }

  const [head, ...rest] = argv;
  if (head === undefined) return { kind: 'tui' };
  if (isHelpFlag(head) && rest.length === 0) return { kind: 'help', topic: 'root' };
  if (head === 'exec') return parseExecArgs(rest);
  if (isHelpFlag(head)) return { kind: 'help', topic: 'root' };
  if (argv.some(isHelpFlag) && !argv.includes('exec')) return { kind: 'help', topic: 'root' };
  return { kind: 'tui' };
}

export function formatPeerHelp(topic: 'root' | 'exec', version = formatPeerVersionLine()): string {
  if (topic === 'exec') {
    return [
      version,
      '',
      'peer exec — run one task without the TUI',
      '',
      'Usage:',
      '  peer exec [options] [prompt]',
      '  echo "..." | peer exec [options]',
      '',
      'Options:',
      '  --access ask|session|full   Permission policy (default: session)',
      '  --tools <list>              Projection allowlist, e.g. bash,file',
      '  --output-format text|json   stdout shape (default: text)',
      '  --provider <id>             This-run provider / credential id',
      '  --model <id>                This-run model id, or provider::model',
      '  --effort <level>            This-run effort override',
      '  --mode chat|plan|goal       Runtime mode (default: chat)',
      '  --workspace <path>          Workspace root (must exist)',
      '  --max-turns <n>             Optional agent-loop cap (default: none)',
      '  -h, --help                  Show this help',
      '',
      'Prompt is the remaining arguments, or stdin when none are given.',
      '--access ask fails without a TTY. Evaluation containers should pass --access full.',
      'If two providers share a model id, pass --provider or --model <provider>::<model>.',
      'Do not join with / — that character is part of some model ids.',
    ].join('\n');
  }

  return [
    version,
    '',
    'Usage:',
    '  peer                 Start the interactive TUI',
    '  peer --version       Print version',
    '  peer --help          Show this help',
    '  peer exec [options] [prompt]',
    '',
    'Use `peer exec --help` for headless flags.',
  ].join('\n');
}

export function shouldRefuseInteractiveTui(stdoutIsTTY: boolean | undefined): boolean {
  return stdoutIsTTY !== true;
}
