import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { parse as parseYaml } from 'yaml';

const SKILL_FILENAME = 'SKILL.md';
const ASSETS_DIR = 'assets';
const SETTINGS_FILENAME = 'settings.json';

/**
 * Minimal tar parser — extracts regular files from a tar buffer.
 */
function parseTar(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    // Check for end-of-archive (all zeros)
    if (header.every((b) => b === 0)) break;

    const name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeFlag = header[156];
    const size = parseInt(sizeStr, 8) || 0;

    // GNU long name extension
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512; // move past header

    // typeFlag: 0 or '\0' or '0' = regular file
    if ((typeFlag === 0 || typeFlag === 48) && size > 0 && fullName && !fullName.endsWith('/')) {
      const data = buffer.slice(offset, offset + size);
      files.push({ name: fullName, data });
    }

    // Advance past data, rounded up to 512-byte boundary
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const frontmatter = parseYaml(match[1]) ?? {};
    const body = content.slice(match[0].length).replace(/^[\r\n]+/, '');
    return { frontmatter, body };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function listAttachments(skillDir) {
  const assetsDir = path.join(skillDir, ASSETS_DIR);
  if (!existsSync(assetsDir)) return [];
  try {
    return readdirSync(assetsDir)
      .filter((entry) => {
        try {
          return statSync(path.join(assetsDir, entry)).isFile();
        } catch {
          return false;
        }
      })
      .sort()
      .map((entry) => {
        const filePath = path.join(assetsDir, entry);
        const stat = statSync(filePath);
        return {
          path: `${ASSETS_DIR}/${entry}`,
          byteLength: stat.size,
        };
      });
  } catch {
    return [];
  }
}

function loadSingleSkill(skillDir, dirName) {
  const skillFile = path.join(skillDir, SKILL_FILENAME);
  if (!existsSync(skillFile)) return null;

  let raw;
  try {
    raw = readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  const skillId = frontmatter.skillId || dirName;
  const name = frontmatter.name || skillId;
  const description = frontmatter.description || '';
  // 对齐 Claude Code skill frontmatter：whenToUse 用于 Layer 2 清单 reminder 的发现性提示，
  // 兼容 camelCase 与 kebab-case 两种写法。
  const whenToUse =
    typeof frontmatter.whenToUse === 'string'
      ? frontmatter.whenToUse
      : typeof frontmatter['when-to-use'] === 'string'
        ? frontmatter['when-to-use']
        : '';
  const version = frontmatter.version || '0.0.0';
  const dataLevel = frontmatter.dataLevel || 'D1_internal';
  const allowedTools = Array.isArray(frontmatter['allowed-tools'])
    ? frontmatter['allowed-tools']
    : [];
  const declaredAttachments = Array.isArray(frontmatter.attachments)
    ? frontmatter.attachments
    : [];
  // 对齐 Claude Code SKILL.md frontmatter。license 可能是字符串、文件路径引用、或不写。
  const license = typeof frontmatter.license === 'string' ? frontmatter.license : null;

  return {
    skillId,
    name,
    description,
    whenToUse,
    version,
    license,
    dataLevel,
    allowedTools,
    declaredAttachments,
    instructions: body,
    skillDir,
  };
}

export function createSkillStore({ userDataPath }) {
  const skillsRoot = path.join(userDataPath, 'skills');
  let skills = [];
  let disabledSet = new Set();

  function settingsPath() {
    return path.join(skillsRoot, SETTINGS_FILENAME);
  }

  function loadSettings() {
    try {
      if (existsSync(settingsPath())) {
        const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
        disabledSet = new Set(Array.isArray(raw.disabled) ? raw.disabled : []);
      }
    } catch {
      disabledSet = new Set();
    }
  }

  function saveSettings() {
    try {
      if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
      writeFileSync(settingsPath(), JSON.stringify({ disabled: [...disabledSet] }, null, 2), 'utf8');
    } catch {
      // silent
    }
  }

  function loadSkills() {
    loadSettings();
    if (!existsSync(skillsRoot)) {
      skills = [];
      return skills;
    }

    const entries = readdirSync(skillsRoot);
    skills = entries
      .map((entry) => {
        const skillDir = path.join(skillsRoot, entry);
        try {
          if (!statSync(skillDir).isDirectory()) return null;
        } catch {
          return null;
        }
        return loadSingleSkill(skillDir, entry);
      })
      .filter(Boolean)
      .sort((a, b) => a.skillId.localeCompare(b.skillId));

    return skills;
  }

  function listSkills() {
    return skills.map(({ skillId, name, description, whenToUse, version, dataLevel }) => ({
      skillId,
      name,
      description,
      // Layer 2 清单 reminder 的发现性提示。空字符串保留以便消费方判空。
      whenToUse: whenToUse || '',
      version,
      dataLevel,
      enabled: !disabledSet.has(skillId),
    }));
  }

  function enableSkill(skillId) {
    disabledSet.delete(skillId);
    saveSettings();
    return listSkills();
  }

  function disableSkill(skillId) {
    disabledSet.add(skillId);
    saveSettings();
    return listSkills();
  }

  function findSkill(skillId) {
    return skills.find((s) => s.skillId === skillId) ?? null;
  }

  function readSkillContext(skillId) {
    const skill = findSkill(skillId);
    if (!skill) return null;

    const attachments = listAttachments(skill.skillDir);

    return {
      skillId: skill.skillId,
      // 绝对路径，供云端 LLM 拼接 cd / 本地 shell 作 cwd。
      baseDir: skill.skillDir,
      frontmatter: {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse || '',
        version: skill.version,
        license: skill.license,
        dataLevel: skill.dataLevel,
        allowedTools: skill.allowedTools,
        declaredAttachments: skill.declaredAttachments,
      },
      instructions: skill.instructions,
      attachments,
    };
  }

  function installSkillFromZip(zipBuffer) {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // Find SKILL.md — could be at root or inside a single top-level folder
    let prefix = '';
    const rootSkill = entries.find((e) => e.entryName === SKILL_FILENAME);
    if (!rootSkill) {
      const nested = entries.find((e) => e.entryName.endsWith(`/${SKILL_FILENAME}`) && e.entryName.split('/').length === 2);
      if (!nested) throw new Error('zip must contain SKILL.md at the root');
      prefix = nested.entryName.split('/')[0] + '/';
    }

    // Parse frontmatter to get skillId
    const skillMdEntry = rootSkill || entries.find((e) => e.entryName === `${prefix}${SKILL_FILENAME}`);
    const content = skillMdEntry.getData().toString('utf8');
    const { frontmatter } = parseFrontmatter(content);
    const skillId = frontmatter.skillId || prefix.replace(/\/$/, '') || `skill-${Date.now()}`;

    const destDir = path.join(skillsRoot, skillId);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const relative = prefix ? entry.entryName.slice(prefix.length) : entry.entryName;
      if (!relative) continue;
      const target = path.join(destDir, relative);
      const targetDir = path.dirname(target);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, entry.getData());
    }

    refresh();
    return listSkills().find((s) => s.skillId === skillId) ?? null;
  }

  function installSkillFromTgz(tgzBuffer) {
    const tarBuffer = gunzipSync(tgzBuffer);
    const files = parseTar(tarBuffer);

    // Find SKILL.md — could be at root or inside a single top-level folder (e.g. "package/")
    let prefix = '';
    const rootSkill = files.find((f) => f.name === SKILL_FILENAME);
    if (!rootSkill) {
      const nested = files.find((f) => f.name.endsWith(`/${SKILL_FILENAME}`) && f.name.split('/').length === 2);
      if (!nested) throw new Error('tgz must contain SKILL.md');
      prefix = nested.name.split('/')[0] + '/';
    }

    // Parse frontmatter to get skillId — prefer name > skillId > prefix
    const skillMdFile = rootSkill || files.find((f) => f.name === `${prefix}${SKILL_FILENAME}`);
    const content = skillMdFile.data.toString('utf8');
    const { frontmatter } = parseFrontmatter(content);
    const rawPrefix = prefix.replace(/\/$/, '');
    const skillId = frontmatter.name || frontmatter.skillId || (rawPrefix !== 'package' ? rawPrefix : '') || `skill-${Date.now()}`;

    const destDir = path.join(skillsRoot, skillId);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    for (const file of files) {
      const relative = prefix ? file.name.slice(prefix.length) : file.name;
      if (!relative) continue;
      const target = path.join(destDir, relative);
      const targetDir = path.dirname(target);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, file.data);
    }

    refresh();
    return listSkills().find((s) => s.skillId === skillId) ?? null;
  }

  function refresh() {
    return loadSkills();
  }

  // Initial load
  loadSkills();

  return {
    loadSkills,
    listSkills,
    findSkill,
    readSkillContext,
    refresh,
    enableSkill,
    disableSkill,
    installSkillFromZip,
    installSkillFromTgz,
  };
}
