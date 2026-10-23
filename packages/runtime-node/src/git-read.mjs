import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redactShellOutput } from './project-agent/output-redaction.mjs';

const fail = (reason, status = 'failed') => Object.assign(new Error(reason), { reason, status });
const spawnFailure = error => fail(error.code === 'ENOENT' ? 'git_unavailable'
  : ['EACCES', 'EPERM'].includes(error.code) ? 'git_execution_permission_denied' : 'git_query_spawn_failed');
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const PREFIX = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', `core.hooksPath=${nullDevice}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.quotePath=false',
  '-c', 'log.showSignature=false', '-c', 'status.submoduleSummary=false'];

export function validateGitReadQuery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['path', 'operation', 'limit'].includes(key))
    || typeof input.path !== 'string' || !input.path.trim() || input.path.includes('\0') || input.path.includes('\n')
    || input.operation !== undefined && !['snapshot', 'status', 'log'].includes(input.operation)
    || input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) throw fail('git_query_invalid_input');
  return { path: input.path, operation: input.operation || 'snapshot', limit: input.limit ?? 40 };
}

/** Fixed argv and a clean Git environment are the execution seam, never a shell. */
export function createGitRead({ binary = 'git', timeoutMs = 15_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return async function query(input, { signal, authorize, checkAuthority = () => {} } = {}) {
    const args = validateGitReadQuery(input);
    const startedAt = new Date().toISOString();
    let remainingMs = timeoutMs;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^(PAGER|LESS|LV)$/i.test(key)));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: '',
      GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', LANG: 'C' });
    let remaining = maxBytes;
    const filterOverrides = [];
    let repositoryBinding = [];
    function guard() { if (signal?.aborted) throw fail('git_query_cancelled', 'cancelled'); checkAuthority(); }
    async function run(cwd, argv, allowedCodes = [0]) {
      guard();
      const wait = remainingMs, processStartedAt = Date.now();
      if (wait <= 0) throw fail('git_query_timeout', 'timeout');
      const result = await new Promise((resolveResult, reject) => {
        let child, settled = false, out = [], err = [], terminalError, killTimer;
        const stop = error => {
          if (terminalError) return;
          terminalError = error; child?.kill();
          killTimer = setTimeout(() => child?.kill('SIGKILL'), 1000);
        };
        const abort = () => stop(fail('git_query_cancelled', 'cancelled'));
        const timer = setTimeout(() => stop(fail('git_query_timeout', 'timeout')), wait);
        const done = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolveResult(value);
        };
        try { child = spawn(binary, [...PREFIX, ...repositoryBinding, ...filterOverrides, ...argv], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { done(spawnFailure(error)); return; }
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const collect = list => chunk => {
          remaining -= chunk.length;
          if (remaining < 0) { stop(fail('git_query_output_limit')); return; }
          list.push(chunk);
        };
        child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
        child.on('error', error => done(spawnFailure(error)));
        child.on('close', code => done(terminalError, { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
      });
      remainingMs -= Date.now() - processStartedAt;
      guard();
      if (!allowedCodes.includes(result.code)) {
        const reason = /not a git repository/.test(result.stderr) ? 'git_not_repository'
          : /must be run in a work tree/.test(result.stderr) ? 'git_worktree_required'
          : /dubious ownership/.test(result.stderr) ? 'git_repository_untrusted' : 'git_query_failed';
        throw Object.assign(fail(reason), { detail: redactShellOutput(result.stderr).slice(0, 800) });
      }
      return result;
    }
    const path = await realpath(args.path);
    await authorize(path); guard();
    const top = (await run(path, ['rev-parse', '--show-toplevel'])).stdout.replace(/\r?\n$/, '');
    const repositoryPath = await realpath(top);
    const gitDirectory = await realpath((await run(path, ['rev-parse', '--absolute-git-dir'])).stdout.replace(/\r?\n$/, ''));
    const common = (await run(path, ['rev-parse', '--git-common-dir'])).stdout.replace(/\r?\n$/, '');
    const commonDirectory = await realpath(resolve(path, common));
    for (const directory of new Set([repositoryPath, gitDirectory, commonDirectory])) { await authorize(directory); guard(); }
    repositoryBinding = [`--git-dir=${gitDirectory}`, `--work-tree=${repositoryPath}`];
    env.GIT_COMMON_DIR = commonDirectory;
    const config = await run(path, ['config', '--includes', '--show-origin', '--name-only', '--null', '--list']);
    const configFields = config.stdout.split('\0'), configurationSources = [];
    for (let i = 0; i + 1 < configFields.length; i += 2) {
      if (!configFields[i].startsWith('file:')) continue;
      const source = await realpath(resolve(path, configFields[i].slice(5)));
      if (!configurationSources.includes(source)) { await authorize(source); guard(); configurationSources.push(source); }
    }
    // Status may hash files through configured clean/process filters. Disable every
    // effective filter before observing the worktree, including included config.
    const filters = await run(path, ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], [0, 1]);
    const keys = [...new Set(filters.stdout.split('\0').filter(Boolean))];
    if (keys.length > 128 || keys.some(key => key.length > 512)) throw fail('git_query_filter_limit');
    for (const key of keys) filterOverrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    async function identity() {
      const head = await run(path, ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]);
      const branch = await run(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
      return { head: head.code === 0 ? head.stdout.trim() : null, branch: branch.code === 0 ? branch.stdout.trimEnd() : null };
    }
    const before = await identity();
    const originResult = await run(path, ['config', '--includes', '--get-all', 'remote.origin.url'], [0, 1]);
    const origin = originResult.stdout.split('\n').filter(Boolean).map(value => redactShellOutput(value)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, '$1[redacted]@').replace(/([?&](?:token|key|password|secret|access_token)=)[^&\s]*/gi, '$1[redacted]'));
    let rawStatus = null;
    let submoduleCount = 0;
    if (args.operation !== 'log') rawStatus = (await run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).stdout;
    if (rawStatus !== null) {
      const index = await run(path, ['ls-files', '--stage', '-z']);
      submoduleCount = index.stdout.split('\0').filter(entry => entry.startsWith('160000 ')).length;
    }
    const commits = [];
    if (before.head && args.operation !== 'status') {
      const log = await run(path, ['log', `--max-count=${args.operation === 'log' ? args.limit : 1}`, '--no-decorate', '--format=%H%x00%cI%x00%s%x00']);
      const fields = log.stdout.split('\0');
      for (let i = 0; i + 2 < fields.length; i += 3) commits.push({ hash: fields[i].trim(), committedAt: fields[i + 1], subject: redactShellOutput(fields[i + 2]) });
    }
    const after = await identity();
    let consistent = JSON.stringify(before) === JSON.stringify(after);
    if (rawStatus !== null) consistent &&= rawStatus === (await run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).stdout;
    const entries = [];
    if (rawStatus !== null) {
      const fields = rawStatus.split('\0');
      for (let i = 0; i < fields.length; i++) {
        const value = fields[i]; if (!value) continue;
        const rename = /[RC]/.test(value.slice(0, 2));
        entries.push({ index: value[0], worktree: value[1], path: value.slice(3), ...(rename ? { from: fields[++i] } : {}) });
      }
    }
    guard();
    return { repositoryPath, gitDirectory, commonDirectory, configurationSources, operation: args.operation, startedAt, finishedAt: new Date().toISOString(),
      ...before, unborn: !before.head, origin, consistent, atomic: false, commits,
      ...(rawStatus !== null ? { status: { clean: !consistent || keys.length ? null : entries.length ? false : submoduleCount ? null : true,
        filtersDisabled: keys.length > 0,
        submoduleCount, submodulesInspected: false, changed: entries.filter(row => row.index !== '?').length,
        untracked: entries.filter(row => row.index === '?').length, entries, truncated: false } } : {}) };
  };
}
