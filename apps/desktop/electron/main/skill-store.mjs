import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

  // 通用过滤规则：description 为空（缺失/纯空白）的 skill 视为无效噪音，直接丢弃。
  // 该判定只看 description，不针对任何特定前缀；由于 loadSingleSkill 是唯一解析入口，
  // 此处 return null 会让「本地加载」(loadSkillsFromRoot) 与「借用列表」(listAvailableSkills) 两条路径同时跳过。
  if (description.trim() === '') return null;

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

export function createSkillStore({ userDataPath, sourceRoots = [] }) {
  const skillsRoot = path.join(userDataPath, 'skills');
  // 「借用来源」目录（如 a1 公共 skill 仓 ~/.agents/skills）。
  // 注意：sourceRoots 不再被自动合并进 loadSkills —— 它们只作为
  // listAvailableSkills 的候选来源，用户显式 linkSkill 后才会在 skillsRoot
  // 建软链，从而被 loadSkills 当作本地技能加载。enable/disable/install 仍只写 skillsRoot。
  const borrowSourceRoots = (Array.isArray(sourceRoots) ? sourceRoots : [])
    .filter((root) => typeof root === 'string' && root && root !== skillsRoot);
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

  function loadSkillsFromRoot(root) {
    if (!existsSync(root)) return [];
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    return entries
      .map((entry) => {
        const skillDir = path.join(root, entry);
        try {
          if (!statSync(skillDir).isDirectory()) return null;
        } catch {
          return null;
        }
        return loadSingleSkill(skillDir, entry);
      })
      .filter(Boolean);
  }

  function loadSkills() {
    loadSettings();

    // 只扫描主目录 skillsRoot。借用自 sourceRoots 的技能以软链形式存在于
    // skillsRoot 下，statSync 跟随软链时会将其识别为目录，从而被一并加载。
    skills = loadSkillsFromRoot(skillsRoot).sort((a, b) => a.skillId.localeCompare(b.skillId));
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

  // 校验 skillId 合法且不含路径穿越，返回安全的目录名。非法返回 null。
  function safeSkillDirName(skillId) {
    if (typeof skillId !== 'string') return null;
    const trimmed = skillId.trim();
    if (!trimmed) return null;
    // 仅允许单段目录名：禁止分隔符、.. 与绝对路径。
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
    if (trimmed === '.' || trimmed === '..') return null;
    if (path.basename(trimmed) !== trimmed) return null;
    return trimmed;
  }

  // 判断 skillsRoot 下某个目录项当前是否为软链（借用而来）。
  function isLinkedEntry(entry) {
    try {
      return lstatSync(path.join(skillsRoot, entry)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  // 列出 sourceRoots（如 a1 公共仓）中可借用的技能，并标注是否已 link 到 skillsRoot。
  function listAvailableSkills() {
    const result = [];
    const seen = new Set();
    for (const root of borrowSourceRoots) {
      if (!existsSync(root)) continue;
      let entries;
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const sourceDir = path.join(root, entry);
        try {
          if (!statSync(sourceDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const skill = loadSingleSkill(sourceDir, entry);
        if (!skill) continue;
        if (seen.has(skill.skillId)) continue;
        seen.add(skill.skillId);
        // 已 link：skillsRoot 下存在同名软链。
        const linked = isLinkedEntry(skill.skillId);
        result.push({
          skillId: skill.skillId,
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          version: skill.version,
          dataLevel: skill.dataLevel,
          sourceRoot: root,
          sourceDir,
          linked,
        });
      }
    }
    return result.sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  // 在 skillsRoot 下建一个指向借用来源技能目录的软链，使其被 loadSkills 加载。
  function linkSkill(skillId) {
    const dirName = safeSkillDirName(skillId);
    if (!dirName) {
      return { ok: false, error: 'invalid-skill-id' };
    }
    const available = listAvailableSkills().find((s) => s.skillId === dirName);
    if (!available) {
      return { ok: false, error: 'source-not-found' };
    }
    const target = path.join(skillsRoot, dirName);
    if (existsSync(target) || isLinkedEntry(dirName)) {
      // 已存在同名目录或软链：若已是软链视作幂等成功，否则拒绝覆盖真实目录。
      if (isLinkedEntry(dirName)) {
        refresh();
        return { ok: true, alreadyLinked: true };
      }
      return { ok: false, error: 'target-exists' };
    }
    if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
    try {
      symlinkSync(available.sourceDir, target, 'dir');
    } catch (err) {
      return { ok: false, error: 'symlink-failed', detail: String(err && err.message ? err.message : err) };
    }
    refresh();
    return { ok: true };
  }

  // 解除借用：仅删除 skillsRoot 下的软链，绝不删除其指向的真实来源目录。
  function unlinkSkill(skillId) {
    const dirName = safeSkillDirName(skillId);
    if (!dirName) {
      return { ok: false, error: 'invalid-skill-id' };
    }
    const target = path.join(skillsRoot, dirName);
    let lst;
    try {
      lst = lstatSync(target);
    } catch {
      return { ok: false, error: 'not-linked' };
    }
    if (!lst.isSymbolicLink()) {
      // 真实目录（非软链）：拒绝，避免误删本地安装的技能。
      return { ok: false, error: 'not-a-link' };
    }
    try {
      unlinkSync(target);
    } catch (err) {
      return { ok: false, error: 'unlink-failed', detail: String(err && err.message ? err.message : err) };
    }
    refresh();
    return { ok: true };
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
    listAvailableSkills,
    linkSkill,
    unlinkSkill,
  };
}
