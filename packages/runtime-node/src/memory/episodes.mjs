/**
 * 事件卡与整理时钟。项目目录 projects/<workspaceId>/memory/。
 * 同一项目两次整理至少间隔 10 分钟；用户输入每累计 8 条才形成一段材料。
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isMemoryWorkspaceId } from './memory-store.mjs';

export const CURATOR_INTERVAL_MS = 10 * 60 * 1000;
export const USER_INPUTS_PER_RUN = 8;

const TASK_END = new Set(['session_verified', 'result_ready', 'failed', 'cancelled', 'interrupted']);
const FINGERPRINT_MAX = 200;

export function isTaskEndEvent(event) {
  return TASK_END.has(event?.kind);
}

export function fingerprintMaterial(material) {
  const body = {
    trigger: material?.trigger || '',
    texts: Array.isArray(material?.texts) ? material.texts : [],
    evidenceRefs: Array.isArray(material?.evidenceRefs) ? material.evidenceRefs : [],
    sessionIds: Array.isArray(material?.sessionIds) ? material.sessionIds : [],
    untrusted: material?.untrusted === true,
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * @param {{ rootDir: string }} options
 */
export function createEpisodeLog({ rootDir } = {}) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) {
    throw new TypeError('episode log requires rootDir');
  }
  const root = rootDir;

  function memoryDir(workspaceId) {
    return path.join(root, 'projects', workspaceId, 'memory');
  }

  function episodeFile(workspaceId) {
    return path.join(memoryDir(workspaceId), 'episodes.jsonl');
  }

  function candidateFile(workspaceId) {
    return path.join(memoryDir(workspaceId), 'candidates.jsonl');
  }

  function clockFile(workspaceId) {
    return path.join(memoryDir(workspaceId), 'curator-clock.json');
  }

  function ensure(workspaceId) {
    if (!isMemoryWorkspaceId(workspaceId)) return false;
    mkdirSync(memoryDir(workspaceId), { recursive: true });
    return true;
  }

  function readClock(workspaceId) {
    const file = clockFile(workspaceId);
    const empty = { lastRunAt: null, userInputs: 0, pendingTexts: [], fingerprints: [] };
    if (!existsSync(file)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return {
        lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
        userInputs: Number.isInteger(parsed.userInputs) && parsed.userInputs > 0 ? parsed.userInputs : 0,
        pendingTexts: stringList(parsed.pendingTexts, 32, 2000),
        fingerprints: stringList(parsed.fingerprints, FINGERPRINT_MAX, 80),
      };
    } catch {
      return empty;
    }
  }

  function writeClock(workspaceId, clock) {
    if (!ensure(workspaceId)) return;
    writeFileSync(clockFile(workspaceId), `${JSON.stringify(clock)}\n`, 'utf8');
  }

  function updateClock(workspaceId, mutate) {
    const clock = readClock(workspaceId);
    mutate(clock);
    writeClock(workspaceId, clock);
    return clock;
  }

  function readFolded(file, keyName) {
    if (!existsSync(file)) return [];
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const byKey = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const key = record?.[keyName];
        if (typeof key === 'string' && key) byKey.set(key, record);
      } catch {
        // 坏行跳过。
      }
    }
    return [...byKey.values()];
  }

  function appendJson(file, record) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  return {
    episodeFile,
    candidateFile,
    noteUserTexts(workspaceId, texts) {
      const incoming = stringList(texts, 32, 2000);
      if (!isMemoryWorkspaceId(workspaceId) || incoming.length === 0) {
        return { userInputs: 0, pendingTexts: [] };
      }
      const clock = updateClock(workspaceId, (next) => {
        next.userInputs += incoming.length;
        next.pendingTexts = stringList([...next.pendingTexts, ...incoming], 32, 2000);
      });
      return { userInputs: clock.userInputs, pendingTexts: [...clock.pendingTexts] };
    },
    takeUserMaterial(workspaceId) {
      const clock = readClock(workspaceId);
      if (clock.userInputs < USER_INPUTS_PER_RUN || clock.pendingTexts.length === 0) return null;
      const texts = [...clock.pendingTexts];
      updateClock(workspaceId, (next) => {
        next.userInputs = 0;
        next.pendingTexts = [];
      });
      return texts;
    },
    userInputCount(workspaceId) {
      return readClock(workspaceId).userInputs;
    },
    seen(workspaceId, fingerprint) {
      return readClock(workspaceId).fingerprints.includes(fingerprint);
    },
    rememberFingerprint(workspaceId, fingerprint) {
      if (typeof fingerprint !== 'string' || !fingerprint) return;
      updateClock(workspaceId, (next) => {
        if (next.fingerprints.includes(fingerprint)) return;
        next.fingerprints = [...next.fingerprints, fingerprint].slice(-FINGERPRINT_MAX);
      });
    },
    due(workspaceId, atIso) {
      const last = readClock(workspaceId).lastRunAt;
      if (!last) return true;
      const lastMs = Date.parse(last);
      const atMs = Date.parse(atIso);
      if (!Number.isFinite(lastMs) || !Number.isFinite(atMs)) return true;
      return atMs - lastMs >= CURATOR_INTERVAL_MS;
    },
    nextDueAt(workspaceId) {
      const last = readClock(workspaceId).lastRunAt;
      const lastMs = Date.parse(last || '');
      const base = Number.isFinite(lastMs) ? lastMs : Date.now();
      return new Date(base + CURATOR_INTERVAL_MS).toISOString();
    },
    markRan(workspaceId, atIso) {
      updateClock(workspaceId, (next) => {
        next.lastRunAt = atIso;
      });
    },
    appendEpisode(episode) {
      if (!episode || !isMemoryWorkspaceId(episode.workspaceId) || !episode.id) return null;
      appendJson(episodeFile(episode.workspaceId), episode);
      return episode;
    },
    listEpisodes(workspaceId) {
      if (!isMemoryWorkspaceId(workspaceId)) return [];
      return readFolded(episodeFile(workspaceId), 'id');
    },
    markExtracted(workspaceId, episodeId) {
      const current = readFolded(episodeFile(workspaceId), 'id').find((item) => item.id === episodeId);
      if (!current) return null;
      const next = { ...current, extracted: true };
      appendJson(episodeFile(workspaceId), next);
      return next;
    },
    nextUnextracted(workspaceId) {
      return readFolded(episodeFile(workspaceId), 'id')
        .filter((item) => item.extracted !== true)
        .sort((left, right) => String(left.openedAt).localeCompare(String(right.openedAt)))[0] || null;
    },
    readCandidate(workspaceId, key) {
      if (!key) return null;
      return readFolded(candidateFile(workspaceId), 'key').find((item) => item.key === key) || null;
    },
    writeCandidate(workspaceId, candidate) {
      if (!isMemoryWorkspaceId(workspaceId) || !candidate?.key) return null;
      appendJson(candidateFile(workspaceId), candidate);
      return candidate;
    },
  };
}

export function createEpisodeId() {
  return `ep-${randomUUID()}`;
}

function stringList(value, max, itemMax) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.length > itemMax ? trimmed.slice(0, itemMax) : trimmed);
    if (out.length >= max) break;
  }
  return out;
}
