import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function writeJsonl(filePath, items) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
}

export function createConversationStore({ storeDir = pathOf('conversations') } = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');

  function convFile(id) { return path.join(storeDir, `${id}.jsonl`); }

  function readIndex() { return readJsonl(indexFile); }

  function listConversations() {
    return readIndex().map((meta) => {
      const msgs = existsSync(convFile(meta.id)) ? readJsonl(convFile(meta.id)) : [];
      return { ...meta, messageCount: msgs.length };
    });
  }

  function listConversationsByWorkspace(workspacePath) {
    return listConversations().filter((c) => (c.workspacePath || null) === (workspacePath || null));
  }

  function createConversation({ title, workspacePath } = {}) {
    const meta = {
      id: randomUUID(),
      title: title || '',
      workspacePath: workspacePath || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    appendJsonl(indexFile, meta);
    return { ...meta, messageCount: 0 };
  }

  function getConversation(id) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const messages = readJsonl(convFile(id));
    return { ...meta, messages };
  }

  function updateTitle(id, title) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    const msgs = existsSync(convFile(id)) ? readJsonl(convFile(id)) : [];
    return { ...meta, messageCount: msgs.length };
  }

  function appendMessage(id, message) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    appendJsonl(convFile(id), message);
    if (!meta.title && message.role === 'user') {
      meta.title = message.content.slice(0, 50);
      meta.updatedAt = new Date().toISOString();
      writeJsonl(indexFile, index);
    }
    return { ...meta, messages: readJsonl(convFile(id)) };
  }

  function updateLastMessage(id, content) {
    const messages = readJsonl(convFile(id));
    if (!messages.length) return null;
    messages[messages.length - 1].content = content;
    writeJsonl(convFile(id), messages);
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (meta) { meta.updatedAt = new Date().toISOString(); writeJsonl(indexFile, index); }
    return meta ? { ...meta, messages } : null;
  }

  function replaceMessages(id, newMessages) {
    writeJsonl(convFile(id), newMessages);
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (meta) { meta.updatedAt = new Date().toISOString(); writeJsonl(indexFile, index); }
    return meta ? { ...meta, messages: newMessages } : null;
  }

  function deleteConversation(id) {
    const index = readIndex().filter((c) => c.id !== id);
    writeJsonl(indexFile, index);
    try { if (existsSync(convFile(id))) unlinkSync(convFile(id)); } catch {}
    return index.map((meta) => {
      const msgs = existsSync(convFile(meta.id)) ? readJsonl(convFile(meta.id)) : [];
      return { ...meta, messageCount: msgs.length };
    });
  }

  // 一次性迁移：如果旧 conversations.json 存在，转成 JSONL 格式
  const legacyFile = path.join(path.dirname(storeDir), 'conversations.json');
  if (existsSync(legacyFile) && !existsSync(indexFile)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, 'utf8'));
      if (Array.isArray(legacy)) {
        mkdirSync(storeDir, { recursive: true });
        for (const conv of legacy) {
          const { messages, ...meta } = conv;
          appendJsonl(indexFile, meta);
          if (messages?.length) writeJsonl(convFile(meta.id), messages);
        }
        console.log(`[conversation-store] migrated ${legacy.length} conversations from JSON to JSONL`);
      }
    } catch (err) {
      console.warn('[conversation-store] migration failed:', err?.message);
    }
  }

  return { listConversations, listConversationsByWorkspace, createConversation, getConversation, updateTitle, appendMessage, updateLastMessage, replaceMessages, deleteConversation };
}
