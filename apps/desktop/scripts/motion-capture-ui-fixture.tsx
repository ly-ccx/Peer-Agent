// Isolated validation uses the actual work disclosure and its motion/styles.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createI18n } from '@peer-agent/i18n';
import type { BotWorkRow } from '../renderer/src/project-agent/state/botWorkState';
import { DelegatedWork } from '../renderer/src/project-agent/conversation/DelegatedWork';
import '../renderer/src/styles/tokens.css';
import '../renderer/src/styles/motion.css';
const i18n = createI18n('zh-CN');
const row: BotWorkRow = { id: 'synthetic-task', status: 'accepted', session: {
  sessionId: 'synthetic-task', title: '隔离动效验证', status: 'accepted', statusLabel: '已签收',
  spawnedAt: '2026-11-17T00:00:00.000Z', conversationId: 'synthetic-conversation', anchorMessageId: 'synthetic-anchor',
  modelLabel: '隔离夹具', evidenceRefs: [], progress: '',
  summary: '仅验证已保存任务详情的真实开合、反向和焦点；不执行任务或调用模型。',
} };
createRoot(document.getElementById('root')!).render(<main style={{ padding: 24, maxWidth: 600 }}>
  <DelegatedWork rows={[row]} botName="隔离验证" i18n={i18n} onOpen={() => {}} />
  <button type="button" id="after">下一项</button>
</main>);
