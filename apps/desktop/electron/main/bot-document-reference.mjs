import path from 'node:path';
import { realpathSync, readFileSync, statSync } from 'node:fs';

const KNOWLEDGE = new Set(['peer-knowledge']);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const failure = status => ({ ok: false, status, content: '', error: status });
const permission = error => ['EACCES', 'EPERM'].includes(error?.code);
const identity = remote => /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)ly-ccx\/peer-knowledge(?:\.git)?\/?$/i.test(String(remote).trim());

/** Bounded resource resolution for the existing file:read service; never a model tool. */
export function createBotDocumentResolver({ getWorkspace, getKnownRoots = () => [], readGitOrigin,
  getTaskSession, getTaskPlan,
  environment = process.env, realpath = realpathSync, stat = statSync, readFile = readFileSync } = {}) {
  async function knowledgeRoot(root, { optional = false } = {}) {
    const configured = environment.PEER_KNOWLEDGE_ROOT;
    let hinted;
    try {
      if (!configured) {
        const value = JSON.parse(readFile(path.join(root, '.peer-workspace.local.json'), 'utf8'));
        if (typeof value?.peerKnowledgeRoot === 'string') hinted = path.resolve(root, value.peerKnowledgeRoot);
      }
    } catch (error) { if (error?.code !== 'ENOENT') return failure(permission(error) ? 'permission_denied' : 'invalid_path'); }
    const groups = configured ? [[configured]] : hinted ? [[hinted]] : [
      ['Peer-Knowledge', 'peer-knowledge'].map(name => path.join(path.dirname(root), name)),
      getKnownRoots().filter(candidate => KNOWLEDGE.has(path.basename(candidate).toLowerCase())),
    ];
    for (const candidates of groups) {
      const matched = new Set();
      for (const candidate of candidates) {
        try {
          const canonical = realpath(candidate);
          if (identity(await readGitOrigin(canonical))) matched.add(canonical);
        } catch (error) { if (permission(error)) return failure('permission_denied'); }
      }
      if (matched.size > 1) return failure('ambiguous_path');
      if (matched.size === 1) return { ok: true, root: [...matched][0] };
    }
    return optional && !configured && !hinted ? null : failure('workspace_unavailable');
  }

  function checkedFile(target, scope, kind = 'file') {
    if (!scope || !inside(scope, target)) return failure('scope_denied');
    try {
      const canonical = realpath(target);
      if (!inside(scope, canonical)) return failure('scope_denied');
      const info = stat(canonical);
      if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) return failure('not_file');
      return { ok: true, target: canonical, root: scope };
    } catch (error) {
      return failure(permission(error) ? 'permission_denied' : ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'not_found' : 'invalid_path');
    }
  }

  async function resolveTask(reference) {
    const task = reference.task;
    const validId = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
    if (!task || !validId(task.sessionId) || !validId(task.planId)) return failure('invalid_path');
    const session = await getTaskSession?.(task.sessionId);
    const plan = await getTaskPlan?.(task.planId);
    if (!session || !plan || session.workspaceId !== reference.workspaceId || session.sessionId !== task.sessionId
      || session.report?.planId !== task.planId || plan.planId !== task.planId
      || plan.delegationOrigin?.workspaceId !== reference.workspaceId || plan.delegationOrigin?.sessionId !== task.sessionId) return failure('scope_denied');
    const binding = plan.deliveryBinding;
    const baseline = binding?.baseCommit || plan.baseCommit;
    const recorded = binding?.executionIsolation === 'worktree' ? binding.worktreePath : binding?.targetWorkspacePath;
    if (!recorded || !path.isAbsolute(recorded) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseline ?? '')) return failure('workspace_unavailable');
    // Only this task's recorded root is admitted. No global roots or companion fallback.
    const scope = realpath(recorded);
    if (!stat(scope).isDirectory()) return failure('workspace_unavailable');
    let base = scope;
    if (reference.relativeTo) {
      const origin = realpath(reference.relativeTo);
      if (!inside(scope, origin) || !stat(origin).isFile()) return failure('scope_denied');
      base = path.dirname(origin);
    }
    const raw = reference.path.replace(/\\/g, '/');
    let target = path.resolve(base, raw);
    if (!inside(scope, target) && path.isAbsolute(raw)) {
      try { target = realpath(target); } catch { return failure('scope_denied'); }
    }
    return checkedFile(target, scope, reference.kind);
  }

  async function otherRelativeLocations(raw, root, known) {
    const companion = await knowledgeRoot(root, { optional: true });
    if (companion && !companion.ok) return companion;
    const roots = [...new Set([...known, ...(companion ? [companion.root] : [])])];
    const candidates = [], seen = new Set();
    let denied = false;
    for (const scope of roots) {
      if (scope === root) continue;
      const match = checkedFile(path.resolve(scope, raw), scope);
      if (match.status === 'permission_denied') denied = true;
      if (!match.ok || seen.has(match.target)) continue;
      seen.add(match.target); candidates.push({ path: match.target, root: scope });
      if (candidates.length === 16) break;
    }
    return candidates.length ? { ...failure('relative_base_required'), candidates } : failure(denied ? 'permission_denied' : 'not_found');
  }

  return async function resolve(reference) {
    if (!reference || typeof reference.workspaceId !== 'string' || typeof reference.path !== 'string'
      || !reference.path.trim() || reference.path.length > 8192 || /[\u0000-\u001f]/.test(reference.path)
      || (reference.kind !== undefined && !['file', 'directory'].includes(reference.kind))
      || (reference.metadataOnly !== undefined && typeof reference.metadataOnly !== 'boolean')
      || /^[a-z][\w+.-]*:\/\//i.test(reference.path)) return failure('invalid_path');
    const workspace = getWorkspace(reference.workspaceId);
    if (!workspace?.ok || !workspace.path) return failure('workspace_unavailable');
    try {
      if (reference.task !== undefined) return await resolveTask(reference);
      const root = realpath(workspace.path);
      const known = [...new Set([root, ...getKnownRoots().flatMap(value => {
        try { return [realpath(value)]; } catch { return []; }
      })])];
      const raw = reference.path.replace(/\\/g, '/');
      const parts = raw.replace(/^\.\//, '').split('/');
      const qualifiedKnowledge = KNOWLEDGE.has(parts[0].toLowerCase());
      const outside = path.isAbsolute(raw) && !known.some(base => inside(base, raw));
      const baseOutside = reference.relativeTo && !known.some(base => inside(base, reference.relativeTo));
      let companion;
      if (qualifiedKnowledge || outside || baseOutside) {
        companion = await knowledgeRoot(root);
        if (!companion.ok && qualifiedKnowledge) return companion;
        if (companion.ok) known.push(companion.root);
      }
      let candidates, scope, bareRelative = false;
      if (path.isAbsolute(raw)) {
        scope = known.find(base => inside(base, raw));
        let target = raw;
        if (!scope) {
          // Native tools may retain a physical root's OS alias (e.g. /var vs /private/var).
          // Resolve this exact target only; aliases never add an allowed root.
          try { target = realpath(raw); } catch { return failure('scope_denied'); }
          scope = known.find(base => inside(base, target));
        }
        candidates = [target];
      }
      else if (qualifiedKnowledge) { candidates = [path.resolve(companion.root, ...parts.slice(1))]; scope = companion.root; }
      else {
        const named = known.filter(base => path.basename(base).toLowerCase() === parts[0].toLowerCase());
        if (named.length > 1) return failure('ambiguous_path');
        if (named.length) { candidates = [path.resolve(named[0], ...parts.slice(1))]; scope = named[0]; }
        else {
          let base = root;
          bareRelative = !reference.relativeTo && !/^\.{1,2}(?:\/|$)/.test(raw);
          if (reference.relativeTo) {
            if (!known.some(value => inside(value, reference.relativeTo))) return failure('scope_denied');
            const origin = realpath(reference.relativeTo);
            if (!known.some(value => inside(value, origin)) || !stat(origin).isFile()) return failure('scope_denied');
            base = path.dirname(origin);
          }
          candidates = [path.resolve(base, raw)];
          scope = known.find(value => inside(value, base));
        }
      }
      const target = candidates[0];
      // Keep a qualified reference inside its own root, including its lexical traversal.
      const checked = checkedFile(target, scope, reference.kind);
      if (checked.status === 'not_found' && bareRelative && reference.kind !== 'directory') return await otherRelativeLocations(raw, root, known);
      if (!checked.ok) return checked;
      // Normalize identity only after checking the originally requested scope. A nested
      // registered root may narrow it, but never authorize an escape from a named root.
      const physicalScope = known.filter(base => inside(scope, base) && inside(base, checked.target))
        .sort((a, b) => b.length - a.length)[0] ?? scope;
      return { ...checked, root: physicalScope };
    } catch (error) {
      return failure(permission(error) ? 'permission_denied' : ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'not_found' : 'invalid_path');
    }
  };
}
