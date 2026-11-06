import { formatPeerVersionLine } from './cli-version.ts';
import { CLI_EXIT } from './cli-exit.ts';

export type ExecAccess = 'ask' | 'session' | 'full';
export type ExecOutputFormat = 'text' | 'json';
export type ExecMode = 'chat' | 'plan' | 'goal';

export interface PeerExecOptions {
  readonly bot?: { readonly inputId?: string; readonly waitMs: number };
  readonly access: ExecAccess;
  readonly tools: readonly string[] | undefined;
  readonly outputFormat: ExecOutputFormat;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly mode: ExecMode;
  readonly fast: boolean;
  readonly workspace: string | undefined;
  readonly maxTurns: number | undefined;
  readonly promptParts: readonly string[];
}

export type PeerCliCommand =
  | { readonly kind: 'version' }
  | { readonly kind: 'help'; readonly topic: 'root' | 'exec' | 'result' | 'update' }
  | { readonly kind: 'tui'; readonly classic?: boolean; readonly bots?: boolean }
  | { readonly kind: 'exec'; readonly options: PeerExecOptions }
  | { readonly kind: 'update'; readonly checkOnly: boolean }
  | { readonly kind: 'result-cleanup-receipt' }
  | { readonly kind: 'result'; readonly reference: string; readonly json: boolean }
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
  let bot = false, inputId: string | undefined, waitMs: number | undefined;
  const explicit = new Set<string>();
  let access: ExecAccess = 'session';
  let tools: string[] | undefined;
  let outputFormat: ExecOutputFormat = 'text';
  let provider: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let mode: ExecMode = 'chat';
  let fast = false;
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
    explicit.add(flag.name);
    if (flag.name === '--bot' && flag.inline === undefined) { bot = true; continue; }
    if (flag.name === '--input-id' || flag.name === '--wait-ms') {
      const value = readValue(flag.name, flag.inline, rest);
      if (!value.ok) return { kind: 'error', message: value.message, exitCode: CLI_EXIT.usage };
      if (flag.name === '--input-id' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.value)) { inputId = value.value; continue; }
      if (flag.name === '--wait-ms' && /^[1-9]\d{0,6}$/.test(value.value) && Number(value.value) <= 1_800_000) { waitMs = Number(value.value); continue; }
      return { kind: 'error', message: `peer exec: invalid ${flag.name}`, exitCode: CLI_EXIT.usage };
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
    if (flag.name === '--fast') {
      if (flag.inline !== undefined) {
        return {
          kind: 'error',
          message: 'peer exec: --fast does not take a value',
          exitCode: CLI_EXIT.usage,
        };
      }
      fast = true;
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

  if (bot && ['--access', '--tools', '--provider', '--model', '--effort', '--mode', '--fast', '--max-turns'].some(flag => explicit.has(flag)))
    return { kind: 'error', message: 'peer exec: --bot uses the bound Bot policy and model', exitCode: CLI_EXIT.usage };
  if (!bot && (inputId !== undefined || waitMs !== undefined))
    return { kind: 'error', message: 'peer exec: --input-id and --wait-ms require --bot', exitCode: CLI_EXIT.usage };
  return {
    kind: 'exec',
    options: {
      ...(bot ? { bot: { inputId, waitMs: waitMs ?? 1_800_000 } } : {}),
      access,
      tools,
      outputFormat,
      provider,
      model,
      effort,
      mode,
      fast,
      workspace,
      maxTurns,
      promptParts,
    },
  };
}

function parseUpdateArgs(argv: readonly string[]): PeerCliCommand {
  let checkOnly = false;
  for (const arg of argv) {
    if (isHelpFlag(arg)) return { kind: 'help', topic: 'update' };
    if (arg === '--check') {
      checkOnly = true;
      continue;
    }
    return {
      kind: 'error',
      message: arg.startsWith('-')
        ? `peer update: unknown option ${arg}`
        : `peer update: unexpected argument ${arg}`,
      exitCode: CLI_EXIT.usage,
    };
  }
  return { kind: 'update', checkOnly };
}

export function parsePeerArgv(argv: readonly string[]): PeerCliCommand {
  if (argv.some((arg) => arg === '--version' || arg === '-v')) {
    return { kind: 'version' };
  }

  const [head, ...rest] = argv;
  if (head === undefined) return { kind: 'tui' };
  if (head === '--classic' && rest.length === 0) return { kind: 'tui', classic: true };
  if (head === 'bots' && rest.length === 0) return { kind: 'tui', bots: true };
  if (isHelpFlag(head) && rest.length === 0) return { kind: 'help', topic: 'root' };
  if (head === 'update') return parseUpdateArgs(rest);
  if (head === 'exec') return parseExecArgs(rest);
  if (head === 'result-cleanup-receipt') {
    if (rest.length === 0) return { kind: 'result-cleanup-receipt' };
    return { kind: 'error', message: 'Usage: peer result-cleanup-receipt < request.json', exitCode: CLI_EXIT.usage };
  }
  if (head === 'result') {
    if (rest.length === 1 && isHelpFlag(rest[0]!)) return { kind: 'help', topic: 'result' };
    const [reference, flag] = rest;
    if (!reference || !reference.startsWith('interactive-result://') || rest.length > 2 || flag !== undefined && flag !== '--json')
      return { kind: 'error', message: 'Usage: peer result <interactive-result://…> [--json]', exitCode: CLI_EXIT.usage };
    return { kind: 'result', reference, json: flag === '--json' };
  }
  if (isHelpFlag(head)) return { kind: 'help', topic: 'root' };
  if (argv.some(isHelpFlag) && !argv.includes('exec')) return { kind: 'help', topic: 'root' };
  return { kind: 'tui' };
}

export function formatPeerHelp(topic: 'root' | 'exec' | 'result' | 'update', version = formatPeerVersionLine()): string {
  if (topic === 'update') {
    return [
      version,
      '',
      'peer update — install the newest release on this channel',
      '',
      'Usage:',
      '  peer update',
      '  peer update --check',
      '',
      'Channels stay separate: stable, beta (-beta.N), and rc (-rc.N).',
      'npm and pnpm installs upgrade that global package.',
      'A release-archive install replaces peer and peer-credential-helper.',
      'Restart peer after a successful update.',
      'This command always checks. PEER_AGENT_NO_UPDATE_CHECK=1 only disables the background prompt.',
    ].join('\n');
  }
  if (topic === 'result') return [
    version,
    '',
    'Usage: peer result <interactive-result://…> [--json]',
    'Read a fixed result summary from the local Bot.',
  ].join('\n');
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
      '  --bot                      Submit through the Bot bound to this workspace',
      '  --input-id <id>            Reuse the same Bot input on retry',
      '  --wait-ms <n>              Bot reply wait, up to 30 minutes',
      '  --access ask|session|full   Permission policy (default: session)',
      '  --tools <list>              Projection allowlist, e.g. bash,file',
      '  --output-format text|json   stdout shape (default: text)',
      '  --provider <id>             This-run provider / credential id',
      '  --model <id>                This-run model id, or provider::model',
      '  --effort <level>            This-run effort override',
      '  --mode chat|plan|goal       Runtime mode (default: chat)',
      '  --fast                      ChatGPT/Grok OAuth Fast (service_tier=priority)',
      '  --workspace <path>          Workspace root (must exist)',
      '  --max-turns <n>             Optional agent-loop cap (default: none)',
      '  -h, --help                  Show this help',
      '',
      'Prompt is the remaining arguments, or stdin when none are given.',
      'A Bot reply still pending at the deadline exits 8 with the input ID.',
      '--access ask fails without a TTY. Evaluation containers should pass --access full.',
      'If two providers share a model id, pass --provider or --model <provider>::<model>.',
      'Do not join with / — that character is part of some model ids.',
    ].join('\n');
  }

  return [
    version,
    '',
    'Usage:',
    '  peer                 Open this project bot (or ask to bind it)',
    '  peer bots            Browse your bots',
    '  peer --classic       Open ordinary task mode, even when a bot is bound',
    '  peer --version       Print version',
    '  peer --help          Show this help',
    '  peer update          Install the newest release on this channel',
    '  peer exec [options] [prompt]',
    '  peer result <interactive-result://…> [--json]',
    '  peer result-cleanup-receipt < request.json',
    '',
    'Use `peer exec --help` for headless flags.',
    'Use `peer update --help` to check or install a release.',
    'Inside bot mode, press F2 or type /classic to switch to task mode.',
  ].join('\n');
}

export function shouldRefuseInteractiveTui(stdoutIsTTY: boolean | undefined): boolean {
  return stdoutIsTTY !== true;
}
