import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { createApprovalStore, digestApprovalArgs } from '../../../packages/runtime-node/src/project-agent/approval-store.mjs';
import { projectCards } from '../../../packages/runtime-node/src/project-agent/card-projection.mjs';
import { checkConversationTypography } from './bot-conversation-typography-checks.mjs';

/** Production approval card/IPC/storage; synthetic pictures, no cloud model. */
export async function checkBotImageApproval({ page, until, report, captureDirectory, commandFile, home, conversationId }) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const access = await page.evaluate(workspaceId => window.peerAgent.projectAgentReadAccessPolicy({ workspaceId }), initial.workspaceId);
  assert.equal(access.ok, true);
  const policyRevision = `bot:${access.policy.workspaceId}:${access.policy.conversationId}:${access.policy.revision}`;
  const store = createApprovalStore({ rootDir: path.join(home, 'project-runtime') });
  const image = path.join(captureDirectory, 'permission-fixture.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const stat = statSync(image);
  const scope = { capabilityId: 'local.image.read', path: image, workspacePath: null, action: 'read_image_for_model',
    fileIdentity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
  const approval = store.append({ approvalId: 'rc-image-approval', workspaceId: initial.workspaceId, conversationId,
    capabilityId: 'local.image.read', imageReadScope: scope, state: 'stale', summary: image, policyRevision,
    argsDigest: digestApprovalArgs({ path: image, fileIdentity: scope.fileIdentity }), createdAt: new Date().toISOString() });
  const other = store.append({ approvalId: 'rc-other-approval', workspaceId: initial.workspaceId, conversationId,
    capabilityId: 'local.file.write', state: 'open', summary: '另一项操作仍需单独确认', policyRevision, argsDigest: digestApprovalArgs({ path: '/another/file' }) });
  const cards = projectCards(initial.workspaceId, { approvals: [approval, other] });
  let seq = initial.seq;
  const send = messages => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, conversationMessages: messages }));
    renameSync(commandFile + '.next', commandFile);
  };
  send(cards.map(card => ({ id: card.cardId, role: 'assistant', kind: 'system_card', cards: [card] })));
  const card = page.locator('[data-card-id="card:approval:rc-image-approval"]');
  await card.waitFor(); await card.scrollIntoViewIfNeeded();
  assert.match(await card.innerText(), /交给当前模型[\s\S]*30 分钟[\s\S]*本轮允许此图片/);
  assert.equal(await card.getByRole('button', { name: '仅这一次', exact: true }).count(), 1);
  const viewport = page.viewportSize(); const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await card.scrollIntoViewIfNeeded();
    assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `image-approval-${width}-${appearance}.png`) });
  }
  await card.getByRole('button', { name: '本轮允许此图片', exact: true }).focus(); await page.keyboard.press('Enter');
  await until(() => store.list().filter(row => row.imageReadGrant && row.state === 'approved').length, n => n === 1);
  assert.equal(store.list().find(row => row.approvalId === other.approvalId).state, 'open');
  assert.equal(store.list().find(row => row.imageReadGrant).imageReadGrant.scope.path, image);
  await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await checkConversationTypography({ page, until, report, captureDirectory, send });
  send([]);
  await card.waitFor({ state: 'detached' });
  report.imageApproval = { exactScope: true, keyboard: true, persisted: true, unrelatedUnapproved: true, narrowFits: true };
}
