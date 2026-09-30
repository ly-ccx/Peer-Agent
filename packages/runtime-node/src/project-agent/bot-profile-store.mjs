/**
 * 机器人档案。真源是 projects/<workspaceId>/profile.json。
 * 不写 settings.workspaces。头像图片放在同一目录的 avatar.<ext>。
 * 「换一个」用 avatarSalt 重新生成；盐存在档案里，否则下次还会得到同一张图。
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { generateAvatar } from '@peer-agent/protocol';

import { pathOf } from '../data-store.mjs';

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const NAME_MAX = 40;
const AVATAR_BYTES = 1024 * 1024;
const IMAGE_EXT = new Set(['png', 'jpg', 'webp']);

function fail(code) {
  return { ok: false, code };
}

export function isBotWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_DIR.test(value);
}

/** 去掉控制字符和路径分隔符，最多 40 个字。空结果返回空串。 */
export function cleanDisplayName(value) {
  const stripped = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim();
  return Array.from(stripped).slice(0, NAME_MAX).join('');
}

function stamp(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function avatarFiles(dir) {
  return ['png', 'jpg', 'webp'].map((ext) => path.join(dir, `avatar.${ext}`));
}

function removeAvatarFiles(dir) {
  for (const file of avatarFiles(dir)) {
    if (existsSync(file)) rmSync(file);
  }
}

export function createBotProfileStore({
  rootDir = null,
  now = () => new Date(),
} = {}) {
  function projectsDir() {
    return rootDir ? path.join(rootDir, 'projects') : pathOf('projects');
  }

  function directory(workspaceId) {
    return path.join(projectsDir(), workspaceId);
  }

  function file(workspaceId) {
    return path.join(directory(workspaceId), 'profile.json');
  }

  function read(workspaceId) {
    if (!isBotWorkspaceId(workspaceId)) return null;
    const target = file(workspaceId);
    if (!existsSync(target)) return null;
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (!parsed || parsed.workspaceId !== workspaceId) return null;
      if (typeof parsed.displayName !== 'string' || !parsed.displayName) return null;
      if (!parsed.avatar || typeof parsed.avatar !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function write(profile) {
    const dir = directory(profile.workspaceId);
    mkdirSync(dir, { recursive: true });
    const target = file(profile.workspaceId);
    const temporary = path.join(dir, `profile.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
    return profile;
  }

  function generatedAvatar(workspaceId, salt) {
    const key = salt ? `${workspaceId}:${salt}` : workspaceId;
    return generateAvatar(key);
  }

  function generatedSignature(avatar, workspaceId) {
    if (avatar?.kind !== 'generated') return null;
    const variant = Number.isInteger(avatar.variant)
      ? avatar.variant
      : generateAvatar(workspaceId).variant;
    return `${avatar.shape}:${avatar.color}:${variant}`;
  }

  function occupiedAvatars(exceptWorkspaceId) {
    const occupied = new Set();
    let entries = [];
    try {
      entries = readdirSync(projectsDir(), { withFileTypes: true });
    } catch {
      return occupied;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === exceptWorkspaceId || !isBotWorkspaceId(entry.name)) continue;
      const profile = read(entry.name);
      if (!profile || profile.status === 'archived') continue;
      const signature = generatedSignature(profile.avatar, entry.name);
      if (signature) occupied.add(signature);
    }
    return occupied;
  }

  function chooseGeneratedAvatar(workspaceId, startSalt, { differentFrom = null, differentColor = null } = {}) {
    const occupied = occupiedAvatars(workspaceId);
    let numericSalt = Number.parseInt(String(startSalt || '0'), 10);
    if (!Number.isInteger(numericSalt) || numericSalt < 0) numericSalt = 0;
    for (let tries = 0; tries < 2048; tries += 1) {
      const avatarSalt = numericSalt === 0 ? '' : String(numericSalt);
      const avatar = generatedAvatar(workspaceId, avatarSalt);
      const signature = generatedSignature(avatar, workspaceId);
      if (!occupied.has(signature) && signature !== differentFrom && avatar.color !== differentColor) {
        return { avatar, avatarSalt };
      }
      numericSalt += 1;
    }
    return null;
  }

  function create({
    workspaceId,
    displayName,
    managed = false,
    agentConversationId,
    avatarSalt = '',
  }) {
    if (!isBotWorkspaceId(workspaceId)) return fail('INVALID_WORKSPACE');
    const name = cleanDisplayName(displayName);
    if (!name) return fail('INVALID_NAME');
    if (typeof agentConversationId !== 'string' || !agentConversationId.trim()) {
      return fail('CONVERSATION_REQUIRED');
    }
    const existing = read(workspaceId);
    if (existing) return { ok: true, profile: existing, created: false };
    const at = stamp(now);
    const selected = chooseGeneratedAvatar(workspaceId, avatarSalt);
    if (!selected) return fail('AVATAR_EXHAUSTED');
    const profile = {
      schemaVersion: 1,
      workspaceId,
      displayName: name,
      avatar: selected.avatar,
      avatarSalt: selected.avatarSalt,
      managed: managed === true,
      agentConversationId: agentConversationId.trim(),
      proactivity: 'inherit',
      modelPolicy: null,
      status: 'active',
      readmeOffer: null,
      familiarize: null,
      createdAt: at,
      updatedAt: at,
    };
    return { ok: true, profile: write(profile), created: true };
  }

  function save(profile) {
    if (!profile || !isBotWorkspaceId(profile.workspaceId)) return fail('INVALID_WORKSPACE');
    const current = read(profile.workspaceId);
    if (!current) return fail('NOT_FOUND');
    const next = {
      ...current,
      ...profile,
      workspaceId: current.workspaceId,
      agentConversationId: current.agentConversationId,
      createdAt: current.createdAt,
      updatedAt: stamp(now),
    };
    return { ok: true, profile: write(next) };
  }

  function regenerateAvatar(workspaceId) {
    const current = read(workspaceId);
    if (!current) return fail('NOT_FOUND');
    const previous = Number.parseInt(String(current.avatarSalt || '0'), 10);
    const selected = chooseGeneratedAvatar(
      workspaceId,
      Number.isInteger(previous) && previous >= 0 ? previous + 1 : 1,
      {
        differentFrom: generatedSignature(current.avatar, workspaceId),
        differentColor: current.avatar?.kind === 'generated' ? current.avatar.color : null,
      },
    );
    if (!selected) return fail('AVATAR_EXHAUSTED');
    return save({
      ...current,
      avatarSalt: selected.avatarSalt,
      avatar: selected.avatar,
    });
  }

  function installAvatar(workspaceId, sourcePath) {
    const current = read(workspaceId);
    if (!current) return fail('NOT_FOUND');
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) return fail('INVALID_IMAGE');
    let info;
    try {
      info = statSync(sourcePath);
    } catch {
      return fail('INVALID_IMAGE');
    }
    if (!info.isFile() || info.size <= 0 || info.size > AVATAR_BYTES) return fail('INVALID_IMAGE');
    const ext = imageExtension(sourcePath);
    if (!ext) return fail('INVALID_IMAGE');
    const dir = directory(workspaceId);
    mkdirSync(dir, { recursive: true });
    removeAvatarFiles(dir);
    const target = path.join(dir, `avatar.${ext}`);
    copyFileSync(sourcePath, target);
    return save({
      ...current,
      avatar: { kind: 'image', ref: `avatar.${ext}` },
    });
  }

  function readAvatar(workspaceId) {
    const profile = read(workspaceId);
    if (!profile) return fail('NOT_FOUND');
    const ref = profile.avatar?.kind === 'image' ? profile.avatar.ref : null;
    const mime = ref === 'avatar.png' ? 'image/png'
      : ref === 'avatar.jpg' ? 'image/jpeg'
        : ref === 'avatar.webp' ? 'image/webp' : null;
    if (!mime) return fail('INVALID_IMAGE');
    const target = path.join(directory(workspaceId), ref);
    try {
      const info = lstatSync(target);
      if (!info.isFile() || info.size <= 0 || info.size > AVATAR_BYTES) return fail('INVALID_IMAGE');
      if (imageExtension(target) !== ref.slice('avatar.'.length)) return fail('INVALID_IMAGE');
      return { ok: true, mime, bytes: readFileSync(target) };
    } catch {
      return fail('INVALID_IMAGE');
    }
  }

  return {
    file,
    read,
    create,
    save,
    regenerateAvatar,
    installAvatar,
    readAvatar,
    generatedAvatar,
  };
}

function imageExtension(file) {
  let header;
  try {
    header = readFileSync(file).subarray(0, 16);
  } catch {
    return null;
  }
  if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return 'png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpg';
  if (header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return IMAGE_EXT.has(path.extname(file).slice(1).toLowerCase()) ? null : null;
}
