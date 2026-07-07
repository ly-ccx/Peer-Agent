import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveQoderCliCommand({
  env = process.env,
  homeDir = os.homedir(),
  exists = existsSync,
} = {}) {
  const explicit = String(env.QODER_CLI_PATH || '').trim();
  if (explicit) return explicit;

  const candidates = [
    path.join(homeDir, '.local/bin/qodercli'),
    '/usr/local/bin/qodercli',
    '/opt/homebrew/bin/qodercli',
    '/Applications/QoderWork.app/Contents/Resources/bin/qodercli',
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return 'qodercli';
}
