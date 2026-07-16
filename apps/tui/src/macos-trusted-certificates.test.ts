import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { describe, expect, test } from 'bun:test';

import {
  certificatesMatchingFingerprints,
  loadMacosTrustedCertificates,
  trustedFingerprintsFromXml,
  type MacosTrustCommand,
} from './macos-trusted-certificates.ts';

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').toUpperCase();
}

function trustXml(entries: Array<{ fingerprint: string; deny?: boolean }>): string {
  return `<?xml version="1.0"?><plist><dict>${entries.map(({ fingerprint, deny }) => `
    <key>${fingerprint}</key><dict>${deny
      ? '<key>kSecTrustSettingsResult</key><integer>3</integer>'
      : '<key>modDate</key><date>2026-01-01T00:00:00Z</date>'}</dict>`).join('')}
  </dict></plist>`;
}

describe('macOS trusted certificates', () => {
  test('keeps explicit trust entries and excludes deny entries', () => {
    const allowed = 'A'.repeat(40);
    const denied = 'B'.repeat(40);
    expect([...trustedFingerprintsFromXml(trustXml([
      { fingerprint: allowed },
      { fingerprint: denied, deny: true },
    ]))]).toEqual([allowed]);
  });

  test('selects certificates by exact SHA-1 fingerprint and de-duplicates them', () => {
    const certificate = rootCertificates[0]!;
    const fingerprint = normalizeFingerprint(new X509Certificate(certificate).fingerprint);
    expect(certificatesMatchingFingerprints(
      `${certificate}\n${certificate}\nnot a certificate`,
      new Set([fingerprint]),
    )).toEqual([`${certificate.trim()}\n`]);
  });

  test('loads the union of user and admin trust settings on macOS', () => {
    const first = rootCertificates[0]!;
    const second = rootCertificates[1]!;
    const firstFingerprint = normalizeFingerprint(new X509Certificate(first).fingerprint);
    const secondFingerprint = normalizeFingerprint(new X509Certificate(second).fingerprint);
    const commands: string[][] = [];
    const runCommand: MacosTrustCommand = (command, args) => {
      commands.push([command, ...args]);
      if (args[0] === 'trust-settings-export') return '';
      if (command === '/usr/bin/plutil') {
        const plistPath = args.at(-1) ?? '';
        return plistPath.endsWith('user.plist')
          ? trustXml([{ fingerprint: firstFingerprint }])
          : trustXml([{ fingerprint: secondFingerprint }]);
      }
      if (args[0] === 'find-certificate') return `${first}\n${second}`;
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    expect(loadMacosTrustedCertificates({ platform: 'darwin', runCommand })).toEqual([
      `${first.trim()}\n`,
      `${second.trim()}\n`,
    ]);
    expect(commands.some((command) => command.includes('-d'))).toBe(true);
  });

  test('fails closed when trust settings cannot be read and skips non-macOS platforms', () => {
    const failing: MacosTrustCommand = () => { throw new Error('unavailable'); };
    expect(loadMacosTrustedCertificates({ platform: 'darwin', runCommand: failing })).toEqual([]);
    expect(loadMacosTrustedCertificates({ platform: 'linux', runCommand: failing })).toEqual([]);
  });
});
