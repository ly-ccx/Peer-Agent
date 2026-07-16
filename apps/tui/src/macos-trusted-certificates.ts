import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SHA1_FINGERPRINT = /<key>([A-Fa-f0-9]{40})<\/key>/g;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const DENY_TRUST_SETTING = /<key>kSecTrustSettingsResult<\/key>\s*<integer>3<\/integer>/;

export type MacosTrustCommand = (
  command: string,
  args: readonly string[],
  options: { readonly encoding?: BufferEncoding; readonly stdio?: 'ignore' | readonly unknown[] },
) => string | Buffer;

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').toUpperCase();
}

/** Extracts explicitly configured, non-denied SHA-1 fingerprints from a trustList XML plist. */
export function trustedFingerprintsFromXml(xml: string): ReadonlySet<string> {
  const matches = [...xml.matchAll(SHA1_FINGERPRINT)];
  const trusted = new Set<string>();
  for (const [index, match] of matches.entries()) {
    const fingerprint = match[1];
    if (!fingerprint) continue;
    const entryStart = match.index ?? 0;
    const entryEnd = matches[index + 1]?.index ?? xml.length;
    const entry = xml.slice(entryStart, entryEnd);
    if (!DENY_TRUST_SETTING.test(entry)) {
      trusted.add(normalizeFingerprint(fingerprint));
    }
  }
  return trusted;
}

/** Keeps only certificates whose SHA-1 fingerprints occur in the trusted set. */
export function certificatesMatchingFingerprints(
  pemBundle: string,
  trustedFingerprints: ReadonlySet<string>,
): string[] {
  const selected = new Map<string, string>();
  for (const pem of pemBundle.match(PEM_CERTIFICATE) ?? []) {
    try {
      const certificate = new X509Certificate(pem);
      const fingerprint = normalizeFingerprint(certificate.fingerprint);
      if (trustedFingerprints.has(fingerprint)) {
        selected.set(fingerprint, `${pem.trim()}\n`);
      }
    } catch {
      // Ignore malformed entries from a mixed certificate export.
    }
  }
  return [...selected.values()];
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: { readonly encoding?: BufferEncoding; readonly stdio?: 'ignore' | readonly unknown[] },
): string | Buffer {
  return execFileSync(command, [...args], options as Parameters<typeof execFileSync>[2]);
}

function exportTrustListXml(
  plistPath: string,
  domain: 'user' | 'admin',
  runCommand: MacosTrustCommand,
): string | undefined {
  try {
    const exportArgs = domain === 'admin'
      ? ['trust-settings-export', '-d', plistPath]
      : ['trust-settings-export', plistPath];
    runCommand('/usr/bin/security', exportArgs, { stdio: 'ignore' });
    return String(runCommand(
      '/usr/bin/plutil',
      ['-extract', 'trustList', 'xml1', '-o', '-', plistPath],
      { encoding: 'utf8' },
    ));
  } catch {
    return undefined;
  }
}

export interface LoadMacosTrustedCertificatesOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: MacosTrustCommand;
}

/**
 * Loads only certificates explicitly admitted by macOS user/admin Trust Settings.
 * Failures return an empty list, leaving the built-in trust store and TLS validation intact.
 */
export function loadMacosTrustedCertificates(
  options: LoadMacosTrustedCertificatesOptions = {},
): string[] {
  if ((options.platform ?? process.platform) !== 'darwin') return [];

  const runCommand = options.runCommand ?? defaultRunCommand;
  const directory = mkdtempSync(join(tmpdir(), 'peer-macos-trust-'));
  try {
    const trusted = new Set<string>();
    for (const domain of ['user', 'admin'] as const) {
      const xml = exportTrustListXml(join(directory, `${domain}.plist`), domain, runCommand);
      if (!xml) continue;
      for (const fingerprint of trustedFingerprintsFromXml(xml)) trusted.add(fingerprint);
    }
    if (trusted.size === 0) return [];

    try {
      const pemBundle = String(runCommand(
        '/usr/bin/security',
        ['find-certificate', '-a', '-p'],
        { encoding: 'utf8' },
      ));
      return certificatesMatchingFingerprints(pemBundle, trusted);
    } catch {
      return [];
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
