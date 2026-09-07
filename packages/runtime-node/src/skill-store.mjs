import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { parse as parseYaml } from 'yaml';

const SKILL_FILENAME = 'SKILL.md';
const ASSETS_DIR = 'assets';
const SETTINGS_FILENAME = 'settings.json';
const MANAGED_INSTALL_SOURCES = new Set(['skillhub', 'qoder-marketplace']);

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

/**
 * YAML 失败时的宽松 frontmatter 回退。
 * SkillHub 等来源常把 description 写成未加引号的单行文本，内部又含 "Use when:" 这类冒号，
 * 严格 YAML 会报 Nested mappings 并导致整份 frontmatter 被清空。
 * 这里只按「首个冒号」拆键值，足够恢复 name / description / version 等标量字段。
 */
function parseLooseFrontmatter(yamlText) {
  const frontmatter = {};
  for (const rawLine of String(yamlText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return frontmatter;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };
  const body = content.slice(match[0].length).replace(/^[\r\n]+/, '');
  try {
    const frontmatter = parseYaml(match[1]) ?? {};
    return { frontmatter, body };
  } catch {
    // 严格 YAML 失败时回退宽松键值，避免 description 含冒号的 Skill 被静默丢弃。
    return { frontmatter: parseLooseFrontmatter(match[1]), body };
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

function readSkillMeta(skillDir) {
  const metaPath = path.join(skillDir, '_meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSkillMeta(skillDir, patch = {}) {
  const metaPath = path.join(skillDir, '_meta.json');
  const existing = readSkillMeta(skillDir) || {};
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    next[key] = value;
  }
  writeFileSync(metaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function resolveSkillPresentation(frontmatter, skillDir) {
  const meta = readSkillMeta(skillDir) || {};
  const sourceFromFm =
    typeof frontmatter['x-source'] === 'string'
      ? frontmatter['x-source']
      : typeof frontmatter.source === 'string'
        ? frontmatter.source
        : '';
  const sourceFromMeta = typeof meta.source === 'string' ? meta.source : '';
  const iconFromFm =
    typeof frontmatter['x-icon-url'] === 'string'
      ? frontmatter['x-icon-url']
      : typeof frontmatter.iconUrl === 'string'
        ? frontmatter.iconUrl
        : '';
  const iconFromMeta = typeof meta.iconUrl === 'string' ? meta.iconUrl : '';
  const source = (sourceFromFm || sourceFromMeta || '').trim() || null;
  const managedSource = sourceFromMeta.trim().toLowerCase();
  const iconUrl = (iconFromFm || iconFromMeta || '').trim() || null;
  return { source, managedSource, iconUrl };
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
  const { source, managedSource, iconUrl } = resolveSkillPresentation(frontmatter, skillDir);

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
    source,
    managedSource,
    iconUrl,
  };
}

/**
 * @param {{
 *   userDataPath?: string,
 *   sourceRoots?: string[],
 *   workspacePath?: string | null,
 * }} options
 */
export function createSkillStore({ userDataPath, sourceRoots = [], workspacePath = null } = {}) {
  const skillsRoot = path.join(userDataPath, 'skills');
  // 「借用来源」目录（如 a1 公共 skill 仓 ~/.agents/skills）。
  // 注意：sourceRoots 不再被自动合并进 loadSkills —— 它们只作为
  // listAvailableSkills 的候选来源，用户显式 linkSkill 后才会在 skillsRoot
  // 建软链，从而被 loadSkills 当作本地技能加载。install/link 仍只写 skillsRoot。
  // 开关挂载（enable/disable）按工作区隔离：全局库可共享，是否对本工作区生效单独记。
  const borrowSourceRoots = (Array.isArray(sourceRoots) ? sourceRoots : [])
    .filter((root) => typeof root === 'string' && root && root !== skillsRoot);
  let skills = [];
  /** @type {Set<string>} 全局硬禁用（对所有工作区生效） */
  let globalDisabledSet = new Set();
  /**
   * 工作区级卸载集合：workspaceKey -> Set(skillId)
   * 语义：skill 仍安装在全局库，但对本工作区不挂载（list/injection 视为 disabled）。
   * 未出现在 map 中的工作区：默认挂载全部「未全局禁用」的 skill（兼容旧行为）。
   */
  let workspaceDisabledMap = new Map();
  /** 工作区显式挂载集合，用于覆盖旧版全局 disabled 状态。 */
  let workspaceEnabledMap = new Map();
  let activeWorkspaceKey = normalizeWorkspaceKey(workspacePath);

  function workspaceSkillsRoot(wsKey = activeWorkspaceKey) {
    return wsKey ? path.join(wsKey, 'skills') : null;
  }

  function settingsPath() {
    return path.join(skillsRoot, SETTINGS_FILENAME);
  }

  function normalizeWorkspaceKey(wsPath) {
    if (typeof wsPath !== 'string') return null;
    const trimmed = wsPath.trim();
    if (!trimmed) return null;
    try {
      return path.resolve(trimmed);
    } catch {
      return trimmed;
    }
  }

  function loadSettings() {
    try {
      if (existsSync(settingsPath())) {
        const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
        globalDisabledSet = new Set(Array.isArray(raw.disabled) ? raw.disabled : []);
        workspaceDisabledMap = new Map();
        workspaceEnabledMap = new Map();
        const workspaceDisabled = raw && typeof raw.workspaceDisabled === 'object' && raw.workspaceDisabled
          ? raw.workspaceDisabled
          : {};
        const workspaceEnabled = raw && typeof raw.workspaceEnabled === 'object' && raw.workspaceEnabled
          ? raw.workspaceEnabled
          : {};
        for (const [key, value] of Object.entries(workspaceDisabled)) {
          const nk = normalizeWorkspaceKey(key);
          if (!nk) continue;
          workspaceDisabledMap.set(
            nk,
            new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.trim()) : []),
          );
        }
        for (const [key, value] of Object.entries(workspaceEnabled)) {
          const nk = normalizeWorkspaceKey(key);
          if (!nk) continue;
          workspaceEnabledMap.set(
            nk,
            new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.trim()) : []),
          );
        }
      }
    } catch {
      globalDisabledSet = new Set();
      workspaceDisabledMap = new Map();
      workspaceEnabledMap = new Map();
    }
  }

  function saveSettings() {
    try {
      if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
      const workspaceDisabled = {};
      const workspaceEnabled = {};
      for (const [key, set] of workspaceDisabledMap.entries()) {
        workspaceDisabled[key] = [...set];
      }
      for (const [key, set] of workspaceEnabledMap.entries()) {
        workspaceEnabled[key] = [...set];
      }
      writeFileSync(
        settingsPath(),
        JSON.stringify(
          {
            disabled: [...globalDisabledSet],
            workspaceDisabled,
            workspaceEnabled,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      // silent
    }
  }

  function workspaceDisabledSetFor(wsKey = activeWorkspaceKey) {
    if (!wsKey) return new Set();
    return workspaceDisabledMap.get(wsKey) ?? new Set();
  }

  function isSkillMounted(skillId, wsKey = activeWorkspaceKey) {
    if (!wsKey) return !globalDisabledSet.has(skillId);
    if (workspaceEnabledMap.get(wsKey)?.has(skillId)) return true;
    if (globalDisabledSet.has(skillId)) return false;
    return !workspaceDisabledSetFor(wsKey).has(skillId);
  }

  function setWorkspacePath(wsPath) {
    activeWorkspaceKey = normalizeWorkspaceKey(wsPath);
    loadSkills();
    return activeWorkspaceKey;
  }

  function getWorkspacePath() {
    return activeWorkspaceKey;
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

    const globalSkills = loadSkillsFromRoot(skillsRoot).map((skill) => ({
      ...skill,
      scope: 'global',
      workspacePath: null,
    }));
    const workspaceRoot = workspaceSkillsRoot();
    const workspaceSkills = workspaceRoot
      ? loadSkillsFromRoot(workspaceRoot).map((skill) => ({
        ...skill,
        scope: 'workspace',
        workspacePath: activeWorkspaceKey,
      }))
      : [];
    // 当前工作空间的同名 Skill 优先于全局版本，避免运行时注入两个同 ID Skill。
    const workspaceIds = new Set(workspaceSkills.map((skill) => skill.skillId));
    skills = [
      ...workspaceSkills,
      ...globalSkills.filter((skill) => !workspaceIds.has(skill.skillId)),
    ].sort((a, b) => a.skillId.localeCompare(b.skillId));
    return skills;
  }

  function isManagedWorkspaceSkill(skill) {
    if (skill?.scope !== 'workspace' || !MANAGED_INSTALL_SOURCES.has(skill.managedSource)) return false;
    const workspaceRoot = workspaceSkillsRoot(skill.workspacePath);
    if (!workspaceRoot) return false;
    const expectedTarget = path.join(workspaceRoot, safeSkillDirName(skill.skillId) || '');
    if (path.resolve(skill.skillDir) !== path.resolve(expectedTarget)) return false;
    try {
      const lst = lstatSync(expectedTarget);
      if (lst.isSymbolicLink() || !lst.isDirectory()) return false;
      const rootReal = realpathSync(workspaceRoot);
      const targetReal = realpathSync(expectedTarget);
      const relative = path.relative(rootReal, targetReal);
      return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  function summarizeSkill(skill, wsKey = activeWorkspaceKey) {
    return {
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      // Layer 2 清单 reminder 的发现性提示。空字符串保留以便消费方判空。
      whenToUse: skill.whenToUse || '',
      version: skill.version,
      dataLevel: skill.dataLevel,
      // enabled = 对目标工作区是否挂载（全局硬禁用优先）。
      enabled: isSkillMounted(skill.skillId, wsKey),
      scope: skill.scope,
      workspacePath: skill.workspacePath,
      iconUrl: skill.iconUrl ?? null,
      source: skill.source ?? null,
      canUninstall: skill.scope === 'global' || isManagedWorkspaceSkill(skill),
    };
  }

  /**
   * 默认返回运行时（当前激活工作区）投影。
   * 传入 workspacePaths 时，为公共管理页返回所有目标工作区 Skill，并只附带一份全局 Skill。
   */
  function listSkills(workspacePaths) {
    if (!Array.isArray(workspacePaths)) return skills.map((skill) => summarizeSkill(skill));

    loadSettings();
    const normalizedPaths = [...new Set(workspacePaths.map(normalizeWorkspaceKey).filter(Boolean))];
    const workspaceSkills = normalizedPaths.flatMap((wsKey) => {
      const root = workspaceSkillsRoot(wsKey);
      return root
        ? loadSkillsFromRoot(root).map((skill) => summarizeSkill({
            ...skill,
            scope: 'workspace',
            workspacePath: wsKey,
          }, wsKey))
        : [];
    });
    const globalSkills = loadSkillsFromRoot(skillsRoot).map((skill) => summarizeSkill({
      ...skill,
      scope: 'global',
      workspacePath: null,
    }, null));
    return [...workspaceSkills, ...globalSkills];
  }

  function ensureWorkspaceDisabledSet(wsKey = activeWorkspaceKey) {
    if (!wsKey) return null;
    if (!workspaceDisabledMap.has(wsKey)) {
      // 首次对本工作区写入时，从「当前默认全挂载」物化一个空卸载集。
      workspaceDisabledMap.set(wsKey, new Set());
    }
    return workspaceDisabledMap.get(wsKey);
  }

  /** 对目标工作区挂载 skill（打开开关）；未指定时沿用当前激活工作区。 */
  function enableSkill(skillId, workspacePath) {
    if (typeof skillId !== 'string' || !skillId.trim()) return listSkills();
    const id = skillId.trim();
    const wsKey = workspacePath === undefined ? activeWorkspaceKey : normalizeWorkspaceKey(workspacePath);
    if (wsKey) {
      const set = ensureWorkspaceDisabledSet(wsKey);
      set?.delete(id);
      if (!workspaceEnabledMap.has(wsKey)) workspaceEnabledMap.set(wsKey, new Set());
      workspaceEnabledMap.get(wsKey).add(id);
    } else {
      globalDisabledSet.delete(id);
    }
    saveSettings();
    return workspacePath === undefined ? listSkills() : listSkills(wsKey ? [wsKey] : []);
  }

  /**
   * 对目标工作区卸载 skill（关闭开关）。不删除全局安装包。
   * 未指定工作区时沿用当前上下文；显式 null 回退为全局禁用。
   */
  function disableSkill(skillId, workspacePath) {
    if (typeof skillId !== 'string' || !skillId.trim()) return listSkills();
    const id = skillId.trim();
    const wsKey = workspacePath === undefined ? activeWorkspaceKey : normalizeWorkspaceKey(workspacePath);
    if (wsKey) {
      const set = ensureWorkspaceDisabledSet(wsKey);
      set?.add(id);
      workspaceEnabledMap.get(wsKey)?.delete(id);
    } else {
      globalDisabledSet.add(id);
    }
    saveSettings();
    return workspacePath === undefined ? listSkills() : listSkills(wsKey ? [wsKey] : []);
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

  function clearSkillEnablement(skillId) {
    globalDisabledSet.delete(skillId);
    for (const set of workspaceEnabledMap.values()) set.delete(skillId);
    for (const set of workspaceDisabledMap.values()) set.delete(skillId);
    saveSettings();
  }

  /**
   * 卸载用户安装的 Skill：
   * - userData/skills 下的软链：仅取消借用（不删除来源）
   * - userData/skills 下的真实目录：递归删除
   * - workspace/skills 下由支持的市场来源安装的真实目录：递归删除
   * - workspace 手写 Skill、符号链接、路径逃逸：拒绝删除
   */
  function uninstallSkill(skillId, workspacePath) {
    const dirName = safeSkillDirName(skillId);
    if (!dirName) return { ok: false, error: 'invalid-skill-id' };

    const skill = findSkill(skillId, workspacePath);
    if (!skill) return { ok: false, error: 'not-found' };

    const root = skill.scope === 'workspace' ? workspaceSkillsRoot(skill.workspacePath) : skillsRoot;
    if (!root) return { ok: false, error: 'workspace-skill-not-uninstallable' };
    if (skill.scope === 'workspace' && !isManagedWorkspaceSkill(skill)) {
      return { ok: false, error: 'workspace-skill-not-uninstallable' };
    }

    const target = path.join(root, dirName);
    const relativeTarget = path.relative(root, target);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      return { ok: false, error: 'path-escape' };
    }
    if (path.resolve(skill.skillDir) !== path.resolve(target)) {
      return { ok: false, error: 'path-mismatch' };
    }
    if (!existsSync(target)) return { ok: false, error: 'not-found' };

    let mode = 'deleted';
    try {
      const lst = lstatSync(target);
      if (lst.isSymbolicLink()) {
        if (skill.scope === 'workspace') return { ok: false, error: 'workspace-skill-not-uninstallable' };
        unlinkSync(target);
        mode = 'unlinked';
      } else {
        const rootReal = realpathSync(root);
        const targetReal = realpathSync(target);
        const relative = path.relative(rootReal, targetReal);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          return { ok: false, error: 'path-escape' };
        }
        // 只允许删除受管 skills 根目录下的一级安装目录。
        if (path.dirname(targetReal) !== rootReal) {
          return { ok: false, error: 'path-escape' };
        }
        rmSync(target, { recursive: true, force: false });
        mode = 'deleted';
      }
    } catch (err) {
      return {
        ok: false,
        error: mode === 'unlinked' ? 'unlink-failed' : 'delete-failed',
        detail: String(err && err.message ? err.message : err),
      };
    }

    clearSkillEnablement(skillId);
    refresh();
    return { ok: true, mode };
  }

  function findSkill(skillId, workspacePath) {
    if (workspacePath === undefined) return skills.find((s) => s.skillId === skillId) ?? null;
    const wsKey = normalizeWorkspaceKey(workspacePath);
    const root = wsKey ? workspaceSkillsRoot(wsKey) : skillsRoot;
    const skill = loadSkillsFromRoot(root).find((candidate) => candidate.skillId === skillId);
    return skill
      ? {
          ...skill,
          scope: wsKey ? 'workspace' : 'global',
          workspacePath: wsKey || null,
        }
      : null;
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

  function getSkillDetail(skillId, workspacePath) {
    const skill = findSkill(skillId, workspacePath);
    if (!skill) return null;
    return {
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse || '',
      version: skill.version,
      dataLevel: skill.dataLevel,
      enabled: isSkillMounted(skill.skillId, workspacePath === undefined ? activeWorkspaceKey : normalizeWorkspaceKey(workspacePath)),
      scope: skill.scope,
      workspacePath: skill.workspacePath,
      iconUrl: skill.iconUrl ?? null,
      source: skill.source ?? null,
      canUninstall: skill.scope === 'global' || isManagedWorkspaceSkill(skill),
      instructions: skill.instructions,
      sourcePath: path.join(skill.skillDir, SKILL_FILENAME),
    };
  }

  /**
   * 安装 ZIP Skill。
   * @param {Buffer} zipBuffer
   * @param {{
   *   scope?: 'global' | 'workspace',
   *   workspacePath?: string | null,
   *   source?: string | null,
   *   iconUrl?: string | null,
   *   meta?: Record<string, unknown>,
   * }} [options]
   * - global（默认）：写入 userData/skills
   * - workspace：优先写入本次明确指定的 workspacePath/skills，否则回退当前工作区；均缺失时抛 workspace_required
   * - source / iconUrl / meta：安装后合并写入 _meta.json（市场图标与来源）
   */
  function installSkillFromZip(zipBuffer, {
    scope = 'global',
    workspacePath: requestedWorkspacePath = null,
    source = null,
    iconUrl = null,
    meta = null,
  } = {}) {
    const installScope = scope === 'workspace' ? 'workspace' : 'global';
    let targetRoot = skillsRoot;
    if (installScope === 'workspace') {
      const ws = normalizeWorkspaceKey(requestedWorkspacePath) ?? getWorkspacePath();
      if (!ws) throw new Error('workspace_required');
      targetRoot = path.join(ws, 'skills');
    }

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

    // Parse frontmatter to get skillId — prefer name > skillId > prefix（与 tgz 安装对齐）
    const skillMdEntry = rootSkill || entries.find((e) => e.entryName === `${prefix}${SKILL_FILENAME}`);
    const content = skillMdEntry.getData().toString('utf8');
    const { frontmatter } = parseFrontmatter(content);
    const rawPrefix = prefix.replace(/\/$/, '');
    const skillId =
      frontmatter.name ||
      frontmatter.skillId ||
      (rawPrefix && rawPrefix !== 'package' ? rawPrefix : '') ||
      `skill-${Date.now()}`;

    const destDir = path.join(targetRoot, skillId);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const relative = prefix ? entry.entryName.slice(prefix.length) : entry.entryName;
      if (!relative) continue;
      const target = path.resolve(destDir, relative);
      const relativeToRoot = path.relative(destDir, target);
      if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        throw new Error('zip_path_escape');
      }
      const targetDir = path.dirname(target);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, entry.getData());
    }

    // 市场安装元数据：在 zip 自带 _meta.json 之上合并 source / iconUrl。
    const metaPatch = {
      ...(meta && typeof meta === 'object' ? meta : {}),
    };
    if (typeof source === 'string' && source.trim()) metaPatch.source = source.trim();
    if (typeof iconUrl === 'string' && iconUrl.trim()) metaPatch.iconUrl = iconUrl.trim();
    if (Object.keys(metaPatch).length > 0) {
      writeSkillMeta(destDir, metaPatch);
    }

    refresh();
    const installedInActiveScope = listSkills().find((s) => s.skillId === skillId) ?? null;
    const installedAtTarget = installedInActiveScope ?? loadSingleSkill(destDir, skillId);
    if (!installedAtTarget) {
      // 文件已落盘但无法加载（如 description 为空）时明确失败，避免 UI 假成功。
      throw new Error('skill_install_unreadable');
    }
    if (installedInActiveScope) return { ...installedInActiveScope, installScope };
    return {
      skillId: installedAtTarget.skillId,
      name: installedAtTarget.name,
      description: installedAtTarget.description,
      whenToUse: installedAtTarget.whenToUse || '',
      version: installedAtTarget.version,
      dataLevel: installedAtTarget.dataLevel,
      enabled: false,
      scope: 'workspace',
      workspacePath: normalizeWorkspaceKey(requestedWorkspacePath),
      iconUrl: installedAtTarget.iconUrl ?? null,
      source: installedAtTarget.source ?? null,
      canUninstall: true,
      installScope,
    };
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
    const installed = listSkills().find((s) => s.skillId === skillId) ?? null;
    if (!installed) {
      throw new Error('skill_install_unreadable');
    }
    return installed;
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
    getSkillDetail,
    refresh,
    enableSkill,
    disableSkill,
    setWorkspacePath,
    getWorkspacePath,
    isSkillMounted,
    installSkillFromZip,
    installSkillFromTgz,
    listAvailableSkills,
    linkSkill,
    unlinkSkill,
    uninstallSkill,
  };
}
