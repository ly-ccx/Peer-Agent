import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const DEFAULT_MAX_CHARS_PER_FILE = 24_000;

function isPlainFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readProjectInstructionFile(filePath, maxChars) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.length <= maxChars) {
    return {
      content: raw.trim(),
      truncated: false,
      originalChars: raw.length,
      includedChars: raw.length,
    };
  }

  return {
    content: raw.slice(0, maxChars).trimEnd(),
    truncated: true,
    originalChars: raw.length,
    includedChars: maxChars,
  };
}

function trimInstructionContent(raw, maxChars) {
  const value = String(raw ?? '');
  if (value.length <= maxChars) {
    return {
      content: value.trim(),
      truncated: false,
      originalChars: value.length,
      includedChars: value.length,
    };
  }

  return {
    content: value.slice(0, maxChars).trimEnd(),
    truncated: true,
    originalChars: value.length,
    includedChars: maxChars,
  };
}

function isInsideOrEqual(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getDataHomePath() {
  const override = process.env.PEER_AGENT_HOME;
  return override && override.trim()
    ? override.trim()
    : path.join(os.homedir(), '.peer-agent');
}

function getTargetDirectory(workspacePath, targetPath) {
  const absoluteTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspacePath, targetPath);
  if (!isInsideOrEqual(workspacePath, absoluteTarget)) return null;

  try {
    if (fs.statSync(absoluteTarget).isDirectory()) return absoluteTarget;
  } catch {
    // Missing target paths are allowed; treat them as file-like paths.
  }
  return path.dirname(absoluteTarget);
}

function listInstructionDirs(workspacePath, targetPaths = []) {
  const workspaceDir = path.resolve(workspacePath);
  const dirs = [workspaceDir];

  for (const targetPath of targetPaths) {
    if (!targetPath || typeof targetPath !== 'string') continue;
    const targetDir = getTargetDirectory(workspaceDir, targetPath);
    if (!targetDir || !isInsideOrEqual(workspaceDir, targetDir)) continue;

    const relative = path.relative(workspaceDir, targetDir);
    if (!relative) continue;

    const parts = relative.split(path.sep).filter(Boolean);
    let current = workspaceDir;
    for (const part of parts) {
      current = path.join(current, part);
      dirs.push(current);
    }
  }

  return [...new Set(dirs)];
}

function makeSectionId(file, workspacePath) {
  if (file.scope === 'config') {
    const id = String(file.id || file.title || 'instruction')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-');
    return `project.instructions.config.${id}`;
  }
  if (file.scope === 'global') {
    return `project.instructions.global.${file.filename.toLowerCase()}`;
  }
  const relativePath = path.relative(workspacePath, file.path) || file.filename;
  const normalized = relativePath
    .split(path.sep)
    .join('.')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
  return `project.instructions.${normalized}`;
}

function formatInstructionSection({ filePath, workspacePath, scope, content, truncated, originalChars, includedChars }) {
  if (scope === 'config') {
    const truncationNotice = truncated
      ? `\n\n[Config instruction truncated: included ${includedChars} of ${originalChars} chars.]`
      : '';
    return [
      `Project instructions from configured Peer Agent settings${filePath ? `: ${filePath}` : '.'}`,
      'These instructions are configured guidance. Follow them unless they conflict with higher-priority core system rules, tool contracts, permission requirements, evidence discipline, or workspace-scoped instructions.',
      '',
      content,
      truncationNotice,
    ].filter((part) => part !== '').join('\n');
  }

  const relativePath = scope === 'global'
    ? filePath
    : (path.relative(workspacePath, filePath) || path.basename(filePath));
  const truncationNotice = truncated
    ? `\n\n[Instruction file truncated: included ${includedChars} of ${originalChars} chars.]`
    : '';

  return [
    `Project instructions from ${relativePath}.`,
    'These instructions are workspace guidance. Follow them unless they conflict with higher-priority core system rules, tool contracts, permission requirements, or evidence discipline.',
    '',
    content,
    truncationNotice,
  ].filter((part) => part !== '').join('\n');
}

export function createProjectInstructionsPromptSource(options = {}) {
  const filenames = options.filenames ?? DEFAULT_FILENAMES;
  const globalFilenames = options.globalFilenames ?? ['AGENTS.md'];
  const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;
  const includeGlobalInstructions = options.includeGlobalInstructions ?? false;
  const defaultConfigInstructions = options.configInstructions ?? [];

  function collectConfigInstructions(input = {}) {
    const items = [
      ...defaultConfigInstructions,
      ...(input.configInstructions ?? []),
    ];
    return items
      .map((item, index) => {
        const normalized = typeof item === 'string'
          ? { content: item }
          : (item && typeof item === 'object' ? item : null);
        if (!normalized?.content) return null;
        const instruction = trimInstructionContent(normalized.content, maxCharsPerFile);
        return {
          scope: 'config',
          id: normalized.id || `instruction-${index + 1}`,
          title: normalized.title || normalized.id || `Instruction ${index + 1}`,
          path: normalized.source || null,
          priority: Number.isFinite(normalized.priority) ? normalized.priority : index,
          ...instruction,
        };
      })
      .filter(Boolean);
  }

  function collectCandidateFiles(workspacePath, input = {}) {
    const candidates = [];
    let priority = collectConfigInstructions(input).length;

    if (includeGlobalInstructions || input.includeGlobalInstructions) {
      const dataHome = path.resolve(input.dataHomePath ?? getDataHomePath());
      for (const filename of globalFilenames) {
        candidates.push({
          scope: 'global',
          filename,
          path: path.join(dataHome, filename),
          priority: priority++,
        });
      }
    }

    const instructionDirs = listInstructionDirs(workspacePath, input.targetPaths ?? []);
    for (const dir of instructionDirs) {
      for (const filename of filenames) {
        candidates.push({
          scope: dir === workspacePath ? 'workspace' : 'scoped',
          filename,
          path: path.join(dir, filename),
          priority: priority++,
        });
      }
    }

    return candidates;
  }

  return {
    id: 'project.instructions',
    layer: 'L3_INSTRUCTIONS',
    priority: 0,
    trust: 'workspace',
    observe(input = {}) {
      const workspacePath = input.workspacePath ? path.resolve(input.workspacePath) : null;
      if (!workspacePath) return { workspacePath: null, files: [] };

      const files = collectConfigInstructions(input);
      const seenPaths = new Set();
      for (const candidate of collectCandidateFiles(workspacePath, input)) {
        if (seenPaths.has(candidate.path)) continue;
        seenPaths.add(candidate.path);
        if (!isPlainFile(candidate.path)) continue;
        try {
          const file = readProjectInstructionFile(candidate.path, maxCharsPerFile);
          files.push({
            scope: candidate.scope,
            filename: candidate.filename,
            path: candidate.path,
            priority: candidate.priority,
            ...file,
          });
        } catch (error) {
          files.push({
            scope: candidate.scope,
            filename: candidate.filename,
            path: candidate.path,
            priority: candidate.priority,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { workspacePath, files };
    },
    render(observation) {
      if (!observation.workspacePath || observation.files.length === 0) return [];

      return observation.files
        .filter((file) => file.content)
        .map((file) => ({
          id: makeSectionId(file, observation.workspacePath),
          layer: 'L3_INSTRUCTIONS',
          priority: file.priority,
          title: file.scope === 'config'
            ? `Project instructions: ${file.title}`
            : `Project instructions: ${file.filename}`,
          content: formatInstructionSection({
            filePath: file.path,
            workspacePath: observation.workspacePath,
            scope: file.scope,
            content: file.content,
            truncated: file.truncated,
            originalChars: file.originalChars,
            includedChars: file.includedChars,
          }),
          source: {
            id: 'project.instructions',
            kind: file.scope === 'config'
              ? 'config'
              : (file.scope === 'global' ? 'global-file' : 'workspace-file'),
            path: file.path,
            scope: file.scope,
            filename: file.filename ?? null,
            title: file.title ?? null,
            truncated: file.truncated,
            originalChars: file.originalChars,
            includedChars: file.includedChars,
          },
          trust: file.scope === 'config' ? 'user' : 'workspace',
        }));
    },
  };
}
