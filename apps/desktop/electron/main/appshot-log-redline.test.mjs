import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppshotService } from './appshot-service.mjs';
import { deliverAppshot } from './appshot-delivery.mjs';

/**
 * T10 log red-line regression tests (ADR 59 decision 4).
 *
 * Forbidden in ANY appshot log line:
 * - image bytes / base64 / dataUrl fragments
 * - window titles (may contain document names, URLs, secrets)
 * Allowed: artifactRef, file paths, byte counts, durations, failure codes,
 * appName / bundleId / pid / windowId.
 */

const SENSITIVE_TITLE = 'SECRET-invoice-2026 – bank.example.com';
const PNG_BYTES = Buffer.from('fake-png-binary-payload-'.repeat(64));

function redlineViolations(lines) {
  const violations = [];
  for (const line of lines) {
    if (line.includes('base64') || line.includes('data:image')) {
      violations.push({ line, reason: 'base64/dataUrl fragment' });
    }
    if (line.includes(SENSITIVE_TITLE) || line.includes('SECRET-invoice')) {
      violations.push({ line, reason: 'window title leaked' });
    }
    if (line.includes(PNG_BYTES.subarray(0, 24).toString())) {
      violations.push({ line, reason: 'raw image bytes leaked' });
    }
  }
  return violations;
}

function fixture(overrides = {}) {
  const logs = [];
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'appshot-redline-'));
  const service = createAppshotService({
    getScreenPermissionStatus: () => 'granted',
    artifactsDir,
    log: (line) => logs.push(String(line)),
    resolveFrontmost: async () => ({ appName: 'Numbers', pid: 5151, bundleId: 'com.apple.Numbers' }),
    listWindows: async () => [
      { windowId: 88, pid: 5151, owner: 'Numbers', title: SENSITIVE_TITLE, x: 0, y: 0, width: 1200, height: 800 },
    ],
    captureWindow: async ({ outFile }) => { writeFileSync(outFile, PNG_BYTES); },
    isSelfPid: () => false,
    ...overrides,
  });
  return { service, logs };
}

test('success path logs never contain window title, base64, or image bytes', async () => {
  const { service, logs } = fixture();
  const result = await service.capture();
  assert.equal(result.ok, true);
  // Payload itself may carry the title (it goes to the conversation, not logs).
  assert.equal(result.payload.source.windowTitle, SENSITIVE_TITLE);
  const violations = redlineViolations(logs);
  assert.deepEqual(violations, [], `red-line violations: ${JSON.stringify(violations)}`);
  assert.ok(logs.some((l) => l.includes('appshot: captured')), 'success log line exists');
});

test('every failure path logs stay red-line clean', async () => {
  const cases = [
    { name: 'permission_denied', overrides: { getScreenPermissionStatus: () => 'denied' } },
    { name: 'peer_frontmost', overrides: { isSelfPid: () => true } },
    { name: 'no_window', overrides: { listWindows: async () => [] } },
    {
      name: 'window_not_capturable',
      overrides: {
        captureWindow: async () => {
          throw new Error(`could not create image from window ${SENSITIVE_TITLE}`);
        },
      },
    },
  ];
  for (const c of cases) {
    const { service, logs } = fixture(c.overrides);
    const result = await service.capture();
    assert.equal(result.ok, false, c.name);
    assert.equal(result.code, c.name);
    const violations = redlineViolations(logs);
    assert.deepEqual(violations, [], `${c.name}: ${JSON.stringify(violations)}`);
    // Structured failure detail must not embed the sensitive title either.
    assert.ok(!String(result.detail ?? '').includes('SECRET-invoice'), `${c.name} detail leaks title`);
  }
});

test('delivered message text fields keep full image out of conversation storage', async () => {
  const { service } = fixture();
  const captured = await service.capture();
  assert.equal(captured.ok, true);
  const appended = [];
  deliverAppshot({
    payload: captured.payload,
    listConversations: () => [{ id: 'c1', updatedAt: '2026-07-30T10:00:00Z' }],
    createConversation: () => ({ id: 'x' }),
    appendMessage: (id, message) => appended.push(message),
    options: { thumbnailDataUrl: 'data:image/png;base64,tinythumb' },
  });
  const att = appended[0].attachments[0];
  // artifactRef points at the disk file; dataUrl only ever holds the small thumbnail.
  assert.ok(att.artifactRef.startsWith('local-appshot-artifact://'));
  assert.equal(att.dataUrl, 'data:image/png;base64,tinythumb');
  const fullBase64 = readFileSync(captured.payload.visual.filePath).toString('base64');
  assert.ok(!JSON.stringify(appended[0]).includes(fullBase64.slice(0, 48)), 'full image base64 must not enter the message');
});
