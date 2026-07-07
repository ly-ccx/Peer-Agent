import { spawn } from 'node:child_process';
import { resolveQoderCliCommand } from './qoder-cli-command.mjs';

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => extractText(part))
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.input_text === 'string') return value.input_text;
    if (value.type === 'image_url' || value.type === 'image') {
      return '[image attachment omitted by qoder-cli bridge]';
    }
    return extractText(value.content ?? value.parts ?? value.text);
  }
  return '';
}

function formatMessage(message) {
  const role = String(message?.role || 'user').toUpperCase();
  const content = extractText(message?.content).trim();
  if (!content) return '';
  return `## ${role}\n${content}`;
}

export function buildQoderCliPrompt({
  systemPrompt,
  messages = [],
  workspacePath = null,
} = {}) {
  const parts = [
    '# Peer Agent conversation',
    workspacePath ? `Workspace: ${workspacePath}` : '',
    'The following system context and conversation were assembled by Peer Agent. Answer the latest user request.',
    '',
    '## SYSTEM CONTEXT',
    String(systemPrompt || '').trim(),
    '',
    '## CONVERSATION',
    ...messages.map(formatMessage).filter(Boolean),
  ].filter((part) => part !== '');
  return `${parts.join('\n\n')}\n`;
}

function normalizeCliModel(value) {
  const raw = String(value || '').trim();
  return raw || 'Auto';
}

function filterCliOutput(text) {
  return String(text || '')
    .replace(ANSI_PATTERN, '')
    .trim();
}

function parseJsonResult(text) {
  const raw = filterCliOutput(text);
  if (!raw) return { content: '', usage: null, raw };
  try {
    const parsed = JSON.parse(raw);
    return {
      content: String(parsed?.result || ''),
      usage: parsed?.usage || null,
      modelUsage: parsed?.modelUsage || null,
      raw,
    };
  } catch {
    return { content: raw, usage: null, raw };
  }
}

export function buildQoderCliArgs({
  prompt,
  model,
  systemPrompt,
  contextWindow,
  maxOutputTokens,
} = {}) {
  const args = ['-p', '--output-format', 'json', '--tools', ''];
  const selectedModel = normalizeCliModel(model);
  if (selectedModel) args.push('--model', selectedModel);
  const system = String(systemPrompt || '').trim();
  if (system) args.push('--system-prompt', system);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    args.push('--context-window', String(Math.trunc(contextWindow)));
  }
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    args.push('--max-output-tokens', String(Math.trunc(maxOutputTokens)));
  }
  args.push('--', String(prompt || ''));
  return args;
}

export async function callQoderCliPrompt({
  prompt,
  model = 'Auto',
  systemPrompt = '',
  cwd = process.cwd(),
  contextWindow = 0,
  maxOutputTokens = 0,
  signal = null,
  command = null,
} = {}) {
  const cliModel = normalizeCliModel(model);
  const cliCommand = command || resolveQoderCliCommand();
  const args = buildQoderCliArgs({
    prompt,
    model: cliModel,
    systemPrompt,
    contextWindow,
    maxOutputTokens,
  });
  return new Promise((resolve) => {
    const child = spawn(cliCommand, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', abort);
      resolve(result);
    };

    const abort = () => {
      try {
        child.kill('SIGTERM');
      } catch {}
      settle({
        ok: false,
        aborted: true,
        errorText: 'qoder_cli_aborted',
        stdout: filterCliOutput(stdout),
        stderr: filterCliOutput(stderr),
      });
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener?.('abort', abort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      settle({
        ok: false,
        errorText: error?.code === 'ENOENT' ? 'qoder_cli_not_found' : (error?.message || 'qoder_cli_error'),
        stdout: filterCliOutput(stdout),
        stderr: filterCliOutput(stderr),
      });
    });
    child.on('close', (code, signalName) => {
      if (settled) return;
      const cleanStdout = filterCliOutput(stdout);
      const cleanStderr = filterCliOutput(stderr);
      if (code === 0) {
        const parsed = parseJsonResult(cleanStdout);
        settle({
          ok: true,
          stdout: cleanStdout,
          stderr: cleanStderr,
          content: parsed.content,
          usage: parsed.usage,
          modelUsage: parsed.modelUsage,
          model: cliModel,
        });
        return;
      }
      settle({
        ok: false,
        errorText: `qoder_cli_exit_${code ?? signalName ?? 'unknown'}`,
        stdout: cleanStdout,
        stderr: cleanStderr,
      });
    });
  });
}
