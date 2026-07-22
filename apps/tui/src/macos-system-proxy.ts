import { execFileSync } from 'node:child_process';

/**
 * Structured system proxy endpoints resolved from macOS network preferences.
 * Each value, when present, is a fully-formed proxy URL (e.g. `http://127.0.0.1:9674`).
 */
export interface SystemProxyConfig {
  readonly http?: string;
  readonly https?: string;
}

export type SystemProxyCommand = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: BufferEncoding },
) => string | Buffer;

interface ScutilProxyFields {
  readonly [key: string]: string | undefined;
}

/** Parses the `<dictionary> { key : value }` block emitted by `scutil --proxy`. */
function parseScutilFields(output: string): ScutilProxyFields {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) fields[key] = value;
  }
  return fields;
}

function isEnabled(value: string | undefined): boolean {
  return value?.trim() === '1';
}

function buildProxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  const trimmedHost = host?.trim();
  if (!trimmedHost) return undefined;
  const trimmedPort = port?.trim();
  const authority = trimmedPort ? `${trimmedHost}:${trimmedPort}` : trimmedHost;
  return `http://${authority}`;
}

/**
 * Converts `scutil --proxy` output into a structured proxy config.
 * Only explicitly enabled HTTP/HTTPS proxies are returned. PAC (auto-config)
 * and SOCKS are intentionally ignored because the TUI transport routes plain
 * HTTP(S) proxy URLs only.
 */
export function parseSystemProxyConfig(output: string): SystemProxyConfig {
  const fields = parseScutilFields(output);
  const config: { http?: string; https?: string } = {};

  if (isEnabled(fields.HTTPEnable)) {
    const http = buildProxyUrl(fields.HTTPProxy, fields.HTTPPort);
    if (http) config.http = http;
  }
  if (isEnabled(fields.HTTPSEnable)) {
    const https = buildProxyUrl(fields.HTTPSProxy, fields.HTTPSPort);
    if (https) config.https = https;
  }

  return config;
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: { readonly encoding: BufferEncoding },
): string {
  return String(execFileSync(command, args, options));
}

export interface ReadMacosSystemProxyOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: SystemProxyCommand;
}

/**
 * Reads the macOS system proxy configuration via `scutil --proxy`.
 * Returns an empty config on non-macOS platforms or on any failure, leaving the
 * environment-variable proxy path as the sole source of truth in those cases.
 */
export function readMacosSystemProxy(
  options: ReadMacosSystemProxyOptions = {},
): SystemProxyConfig {
  if ((options.platform ?? process.platform) !== 'darwin') return {};

  const runCommand = options.runCommand ?? defaultRunCommand;
  try {
    const output = String(runCommand('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' }));
    return parseSystemProxyConfig(output);
  } catch {
    return {};
  }
}
