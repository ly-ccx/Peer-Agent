import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadLocalEnv({ workspaceRoot }) {
  const envPath = path.join(workspaceRoot, '.env');
  if (!existsSync(envPath)) return [];

  const loaded = [];
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
    loaded.push(key);
  }
  return loaded;
}
