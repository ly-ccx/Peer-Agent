// S5: main-process image -> conversation user attachment, via real conversation-store API.
import { createConversationStore } from '../../packages/conversation-store/src/index.mjs';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const report = {};
try {
  const storeDir = mkdtempSync(join(tmpdir(), 'appshot-s5-'));
  const store = createConversationStore({ storeDir });
  const conv = store.createConversation({ title: 'appshot-spike' });
  report.conversationId = conv.id;

  const png = readFileSync(new URL('./out/s2-cli-window60.png', import.meta.url));
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  report.pngBytes = png.length;

  store.appendMessage(conv.id, {
    id: `appshot-${Date.now()}`,
    role: 'user',
    content: '',
    attachments: [{
      id: 'att-appshot-1',
      name: 'Appshot — peer (window:60)',
      mimeType: 'image/png',
      size: png.length,
      kind: 'image',
      dataUrl,
    }],
    createdAt: new Date().toISOString(),
  });

  const loaded = store.getConversation(conv.id);
  const msgs = loaded?.messages ?? [];
  report.readBackMessageCount = msgs.length;
  const att = msgs[0]?.attachments?.[0];
  report.attachmentRoundTrip = att
    ? { kind: att.kind, mimeType: att.mimeType, size: att.size, dataUrlIntact: att.dataUrl === dataUrl }
    : null;
  report.ok = Boolean(att && att.dataUrl === dataUrl);
} catch (err) {
  report.error = String(err?.stack ?? err);
}
console.log(JSON.stringify(report, (k, v) => (k === 'dataUrl' ? undefined : v), 2));
writeFileSync(new URL('./out/s5-report.json', import.meta.url), JSON.stringify(report, (k, v) => (k === 'dataUrl' ? undefined : v), 2));
