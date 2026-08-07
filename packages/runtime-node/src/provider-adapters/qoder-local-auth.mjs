import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// qodercli 内嵌 auth wasm 的变量名会被 minify 改写（历史为 MsC，新版如 G9_）。
// 统一按 wasm base64 magic（AGFzb...）匹配，并在多个命中时取最长串。
const WASM_BASE64_PATTERN = /var [A-Za-z0-9_$]+="(AGFzb[A-Za-z0-9+/=]+)"/g;
const MIN_EMBEDDED_WASM_BASE64_LENGTH = 1_000;
const TOKEN_ENV_NAMES = ['QODER_ACCESS_TOKEN', 'QODER_PERSONAL_ACCESS_TOKEN', 'QODER_PAT'];

let authWasmPromise = null;

/** Stable business codes → user-facing text (bubble shows error.message). */
const QODER_AUTH_ERROR_MESSAGES = {
  qoder_auth_not_found:
    'Qoder local login state not found. Open Qoder, sign in, then retry.',
  qoder_auth_token_missing:
    'Qoder local login state has no access token. Re-login in Qoder, then retry.',
  qoder_auth_expired:
    'Qoder local login has expired. Re-login in Qoder, then retry.',
  qoder_auth_permission_denied:
    'Cannot read Qoder local login state (permission denied). Check ~/.qoder/.auth permissions or re-login in Qoder.',
  qoder_auth_unavailable:
    'Unable to load Qoder local login state. Re-login in Qoder or set QODER_ACCESS_TOKEN.',
  qoder_auth_wasm_missing:
    'Qoder auth wasm is missing from the CLI binary. Reinstall or update qodercli.',
  qoder_auth_wasm_not_found:
    'Qoder CLI binary not found; cannot decrypt local login state. Install qodercli or set QODER_ACCESS_TOKEN.',
  qoder_cli_not_found:
    'Qoder CLI binary not found. Install qodercli or set QODER_CLI_PATH.',
};

function createQoderAuthError(code, cause = null) {
  const message = QODER_AUTH_ERROR_MESSAGES[code] || code;
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/** Map Node system errno (EPERM/EACCES/…) to stable qoder_auth_* codes; keep existing qoder codes. */
function mapQoderAuthCaughtError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.startsWith('qoder_auth_') || code === 'qoder_cli_not_found') {
    return error;
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return createQoderAuthError('qoder_auth_permission_denied', error);
  }
  if (code === 'ENOENT') {
    return createQoderAuthError('qoder_auth_not_found', error);
  }
  return createQoderAuthError('qoder_auth_unavailable', error);
}

function nonEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
}

function tokenFromEnv(env = process.env) {
  for (const name of TOKEN_ENV_NAMES) {
    const value = nonEmpty(env[name]);
    if (value) return { token: value, source: name };
  }
  return null;
}

export function resolveQoderConfigDir({ env = process.env, homeDir = os.homedir() } = {}) {
  const explicit = nonEmpty(env.QODER_CONFIG_DIR);
  if (explicit) return path.resolve(explicit);
  const cliHome = nonEmpty(env.QODER_CLI_HOME) || homeDir;
  return path.join(cliHome, '.qoder');
}

export async function resolveQoderInferenceEndpoint(options = {}) {
  const explicit = nonEmpty(options.env?.QODER_INFERENCE_ENDPOINT || options.env?.QODER_INFER_ENDPOINT);
  if (explicit) return explicit.replace(/\/+$/, '');
  const configDir = resolveQoderConfigDir(options);
  try {
    const raw = await fs.readFile(path.join(configDir, '.cache/endpoint-cache.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const envName = nonEmpty(options.env?.QODER_ENV || options.env?.QODER_ENVIRONMENT) || 'prod';
    const endpoint = nonEmpty(parsed?.entries?.[envName]?.endpoint)
      || nonEmpty(parsed?.entries?.prod?.endpoint)
      || nonEmpty(parsed?.entries?.[envName]?.inferEndpoints?.[0])
      || nonEmpty(parsed?.entries?.prod?.inferEndpoints?.[0]);
    if (endpoint) return endpoint.replace(/\/+$/, '');
  } catch {}
  const qoderEnv = String(options.env?.QODER_ENV || options.env?.QODER_ENVIRONMENT || '').trim().toLowerCase();
  if (qoderEnv === 'daily') return 'https://daily-api3.qoder.sh';
  if (qoderEnv === 'test') return 'https://test-api3.qoder.sh';
  return 'https://api3.qoder.sh';
}

async function existingFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function qoderCliBinaryCandidates({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  const executableNames = platform === 'win32'
    ? ['qodercli.exe', 'qodercli']
    : ['qodercli'];
  const candidates = [
    nonEmpty(env.QODER_CLI_PATH),
    nonEmpty(env.QODERCLI_PATH),
    ...executableNames.map((name) => path.join(homeDir, '.local/bin', name)),
    ...(platform === 'win32' ? [] : [
      '/usr/local/bin/qodercli',
      '/opt/homebrew/bin/qodercli',
    ]),
    ...(platform === 'darwin' ? [
      '/Applications/QoderWork.app/Contents/Resources/bin/qodercli',
    ] : []),
  ].filter(Boolean);

  const managedDir = path.join(homeDir, '.qoder/bin/qodercli');
  try {
    const entries = await fs.readdir(managedDir);
    for (const entry of entries.sort().reverse()) {
      if (entry.startsWith('qodercli-')) candidates.push(path.join(managedDir, entry));
    }
  } catch {}

  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames) candidates.push(path.join(dir, name));
  }
  return [...new Set(candidates)];
}

export async function resolveQoderCliBinary(options = {}) {
  for (const candidate of await qoderCliBinaryCandidates(options)) {
    const binary = await existingFile(candidate);
    if (binary) return binary;
  }
  return null;
}

export function extractEmbeddedAuthWasmBytes(content) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content || '');
  let best = null;
  for (const match of text.matchAll(WASM_BASE64_PATTERN)) {
    const payload = match?.[1];
    if (!payload) continue;
    if (!best || payload.length > best.length) best = payload;
  }
  if (!best || best.length < MIN_EMBEDDED_WASM_BASE64_LENGTH) return null;
  return Buffer.from(best, 'base64');
}

async function loadEmbeddedWasmBytes(options = {}) {
  let sawBinary = false;
  const explicitWasmBinary = nonEmpty((options.env ?? process.env).QODER_AUTH_WASM_BINARY);
  const candidates = [
    explicitWasmBinary,
    ...await qoderCliBinaryCandidates(options),
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const binary = await existingFile(candidate);
    if (!binary) continue;
    sawBinary = true;
    const content = await fs.readFile(binary);
    const wasmBytes = extractEmbeddedAuthWasmBytes(content);
    if (wasmBytes) return wasmBytes;
  }
  throw createQoderAuthError(sawBinary ? 'qoder_auth_wasm_missing' : 'qoder_auth_wasm_not_found');
}

function createHeap() {
  const heap = new Array(128).fill(undefined);
  heap.push(undefined, null, true, false);
  let next = heap.length;
  return {
    add(value) {
      if (next === heap.length) heap.push(heap.length + 1);
      const index = next;
      next = heap[index];
      heap[index] = value;
      return index;
    },
    get(index) {
      return heap[index];
    },
    drop(index) {
      if (index < 132) return;
      heap[index] = next;
      next = index;
    },
    take(index) {
      const value = heap[index];
      this.drop(index);
      return value;
    },
  };
}

async function createAuthWasm(options = {}) {
  const wasmBytes = await loadEmbeddedWasmBytes(options);
  const heap = createHeap();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  const encoder = new TextEncoder();
  let wasm = null;
  let memory = null;
  let dataView = null;
  let lastLength = 0;

  const memoryBytes = () => {
    if (!memory || memory.byteLength === 0) memory = new Uint8Array(wasm.memory.buffer);
    return memory;
  };
  const view = () => {
    if (!dataView || dataView.buffer !== wasm.memory.buffer) dataView = new DataView(wasm.memory.buffer);
    return dataView;
  };
  const readString = (pointer, length) => decoder.decode(memoryBytes().subarray(pointer >>> 0, (pointer >>> 0) + length));
  const readBytes = (pointer, length) => memoryBytes().slice(pointer >>> 0, (pointer >>> 0) + length);
  const passString = (value) => {
    const bytes = encoder.encode(String(value));
    const pointer = wasm.__wbindgen_export2(bytes.length, 1) >>> 0;
    memoryBytes().subarray(pointer, pointer + bytes.length).set(bytes);
    lastLength = bytes.length;
    return pointer;
  };
  const stringResult = (fn) => {
    const ret = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      fn(ret);
      const dv = view();
      const pointer = dv.getInt32(ret, true);
      const length = dv.getInt32(ret + 4, true);
      const error = dv.getInt32(ret + 8, true);
      const failed = dv.getInt32(ret + 12, true);
      if (failed) throw heap.take(error);
      const output = readString(pointer, length);
      wasm.__wbindgen_export4(pointer, length, 1);
      return output;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  };

  const imports = {
    './qoder_auth_wasm_bg.js': {
      __wbindgen_object_drop_ref: (index) => heap.drop(index),
      __wbindgen_object_clone_ref: (index) => heap.add(heap.get(index)),
      __wbg_set_08463b1df38a7e29: (target, key, value) => heap.add(heap.get(target).set(heap.get(key), heap.get(value))),
      __wbg_getRandomValues_d49329ff89a07af1: (pointer, length) => crypto.webcrypto.getRandomValues(memoryBytes().subarray(pointer, pointer + length)),
      __wbg_crypto_38df2bab126b63dc: (index) => heap.add(heap.get(index)?.crypto ?? crypto.webcrypto),
      __wbg_process_44c7a14e11e9f69e: (index) => heap.add(heap.get(index)?.process),
      __wbg_versions_276b2795b1c6a219: (index) => heap.add(heap.get(index)?.versions),
      __wbg_node_84ea875411254db1: (index) => heap.add(heap.get(index)?.node),
      __wbg_require_b4edbdcf3e2a1ef0: () => heap.add(require),
      __wbg_msCrypto_bd5a034af96bcba6: (index) => heap.add(heap.get(index).msCrypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: (target, value) => heap.get(target).getRandomValues(heap.get(value)),
      __wbg_randomFillSync_6c25eac9869eb53c: (target, value) => heap.get(target).randomFillSync(heap.take(value)),
      __wbg_call_d578befcc3145dee: (fn, self, arg) => heap.add(heap.get(fn).call(heap.get(self), heap.get(arg))),
      __wbg_new_with_length_9cedd08484b73942: (length) => heap.add(new Uint8Array(length >>> 0)),
      __wbg_length_0c32cb8543c8e4c8: (index) => heap.get(index).length,
      __wbg_prototypesetcall_3e05eb9545565046: (pointer, length, value) => Uint8Array.prototype.set.call(memoryBytes().subarray(pointer, pointer + length), heap.get(value)),
      __wbg_subarray_0f98d3fb634508ad: (index, start, end) => heap.add(heap.get(index).subarray(start >>> 0, end >>> 0)),
      __wbg_new_99cabae501c0a8a0: () => heap.add(new Map()),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => heap.add(globalThis),
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => heap.add(typeof self === 'undefined' ? null : self),
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => heap.add(global),
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => heap.add(typeof window === 'undefined' ? null : window),
      __wbg___wbindgen_throw_81fc77679af83bc6: (pointer, length) => { throw Error(readString(pointer, length)); },
      __wbg_Error_2e59b1b37a9a34c3: (pointer, length) => heap.add(Error(readString(pointer, length))),
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: (index) => {
        const value = heap.get(index);
        return typeof value === 'object' && value !== null;
      },
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (index) => typeof heap.get(index) === 'string',
      __wbg___wbindgen_is_function_49868bde5eb1e745: (index) => typeof heap.get(index) === 'function',
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (index) => heap.get(index) === undefined,
      __wbindgen_cast_0000000000000001: (pointer, length) => heap.add(memoryBytes().subarray(pointer, pointer + length)),
      __wbindgen_cast_0000000000000002: (pointer, length) => heap.add(readString(pointer, length)),
    },
  };

  wasm = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), imports).exports;
  const callStringPair = (fnName, first, second) => {
    const firstPointer = passString(first);
    const firstLength = lastLength;
    const secondPointer = passString(second);
    const secondLength = lastLength;
    return stringResult((ret) => wasm[fnName](ret, firstPointer, firstLength, secondPointer, secondLength));
  };
  const callStringSingle = (fnName, value) => {
    const pointer = passString(value);
    const length = lastLength;
    return stringResult((ret) => wasm[fnName](ret, pointer, length));
  };
  const makeQoderContext = ({ machineId, cosyVersion, userInfoJson, runtimeJson }) => {
    const machinePointer = passString(machineId);
    const machineLength = lastLength;
    const versionPointer = passString(cosyVersion);
    const versionLength = lastLength;
    const userPointer = passString(userInfoJson);
    const userLength = lastLength;
    const runtimePointer = passString(runtimeJson);
    const runtimeLength = lastLength;
    const ret = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.qodercontext_new(
        ret,
        machinePointer,
        machineLength,
        versionPointer,
        versionLength,
        userPointer,
        userLength,
        runtimePointer,
        runtimeLength,
      );
      const dv = view();
      const pointer = dv.getInt32(ret, true);
      const error = dv.getInt32(ret + 4, true);
      const failed = dv.getInt32(ret + 8, true);
      if (failed) throw heap.take(error);
      return pointer >>> 0;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  };
  const requestResultBody = (requestPtr) => {
    const ret = wasm.__wbindgen_add_to_stack_pointer(-16);
    let pointer = 0;
    let length = 0;
    try {
      wasm.requestresult_body(ret, requestPtr);
      const dv = view();
      pointer = dv.getInt32(ret, true);
      length = dv.getInt32(ret + 4, true);
      if (!pointer || !length) return new Uint8Array();
      return readBytes(pointer, length);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      if (pointer && length) wasm.__wbindgen_export4(pointer, length, 1);
    }
  };
  const requestResultUrl = (requestPtr) => {
    const ret = wasm.__wbindgen_add_to_stack_pointer(-16);
    let pointer = 0;
    let length = 0;
    try {
      wasm.requestresult_url(ret, requestPtr);
      const dv = view();
      pointer = dv.getInt32(ret, true);
      length = dv.getInt32(ret + 4, true);
      return pointer && length ? readString(pointer, length) : '';
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      if (pointer && length) wasm.__wbindgen_export4(pointer, length, 1);
    }
  };
  const requestResultHeaders = (requestPtr) => {
    const raw = heap.take(wasm.requestresult_headers(requestPtr));
    if (!raw || typeof raw.forEach !== 'function') return {};
    const headers = {};
    raw.forEach((value, key) => {
      headers[String(key)] = String(value);
    });
    return headers;
  };
  const prepareInferRequest = ({
    machineId,
    cosyVersion,
    userInfoJson,
    runtimeJson,
    endpoint,
    requestBody,
    modelKey,
    modelSource,
  }) => {
    const contextPtr = makeQoderContext({ machineId, cosyVersion, userInfoJson, runtimeJson });
    let requestPtr = 0;
    try {
      const endpointPointer = passString(endpoint);
      const endpointLength = lastLength;
      const bodyPointer = passString(requestBody);
      const bodyLength = lastLength;
      const modelPointer = passString(modelKey);
      const modelLength = lastLength;
      const sourcePointer = passString(modelSource);
      const sourceLength = lastLength;
      const ret = wasm.__wbindgen_add_to_stack_pointer(-16);
      try {
        wasm.qodercontext_prepareInferRequest(
          ret,
          contextPtr,
          endpointPointer,
          endpointLength,
          bodyPointer,
          bodyLength,
          modelPointer,
          modelLength,
          sourcePointer,
          sourceLength,
        );
        const dv = view();
        requestPtr = dv.getInt32(ret, true) >>> 0;
        const error = dv.getInt32(ret + 4, true);
        const failed = dv.getInt32(ret + 8, true);
        if (failed) throw heap.take(error);
      } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
      }
      return {
        url: requestResultUrl(requestPtr),
        headers: requestResultHeaders(requestPtr),
        body: requestResultBody(requestPtr),
      };
    } finally {
      if (requestPtr) wasm.__wbg_requestresult_free(requestPtr, 0);
      if (contextPtr) wasm.__wbg_qodercontext_free(contextPtr, 0);
    }
  };

  return {
    credentialStorageDecrypt(cipherText, key) {
      return callStringPair('credential_storage_decrypt', cipherText, key);
    },
    modelCacheDecrypt(cipherText, key) {
      return callStringPair('model_cache_decrypt', cipherText, key);
    },
    generateRuntimeAuthFields(userInfoJson) {
      return callStringSingle('generate_runtime_auth_fields', userInfoJson);
    },
    prepareInferRequest,
  };
}

async function getAuthWasm(options = {}) {
  if (!authWasmPromise) {
    authWasmPromise = createAuthWasm(options).catch((error) => {
      // 失败时清空缓存，避免进程内永久钉死为 wasm_missing。
      authWasmPromise = null;
      throw error;
    });
  }
  return authWasmPromise;
}

export async function decryptQoderModelCache(cipherText, key, options = {}) {
  const authWasm = await getAuthWasm(options);
  return authWasm.modelCacheDecrypt(String(cipherText || '').trim(), String(key || '').trim());
}

function qoderRuntimeJson(env = process.env) {
  return JSON.stringify({
    client_type: env.QODER_CLIENT_TYPE || '5',
    business_product: env.QODER_BUSINESS_PRODUCT || 'cli',
    business_type: env.QODER_BUSINESS_TYPE || 'agent',
    scene: env.QODER_SCENE || 'assistant',
  });
}

export async function prepareQoderInferRequest({
  requestBody,
  modelKey,
  modelSource = 'system',
  endpoint = null,
  options = {},
} = {}) {
  const configDir = resolveQoderConfigDir(options);
  const machinePath = path.join(configDir, '.auth/machine_id');
  const auth = await loadQoderLocalAuth(options);
  if (!auth.userInfo) throw createQoderAuthError('qoder_local_user_info_required');
  const machineId = (await fs.readFile(machinePath, 'utf8')).trim();
  const authWasm = await getAuthWasm(options);
  const userInfo = { ...auth.userInfo };
  if (!userInfo.encrypt_user_info || !userInfo.key) {
    const authFields = JSON.parse(authWasm.generateRuntimeAuthFields(JSON.stringify({
      uid: userInfo.uid,
      organization_id: userInfo.organization_id,
      organization_tags: userInfo.organization_tags,
      data_policy_agreed: userInfo.data_policy_agreed,
    })));
    userInfo.encrypt_user_info = authFields.encrypt_user_info;
    userInfo.key = authFields.key;
  }
  return authWasm.prepareInferRequest({
    machineId,
    cosyVersion: options.qoderCliVersion || '1.0.39',
    userInfoJson: JSON.stringify(userInfo),
    runtimeJson: qoderRuntimeJson(options.env),
    endpoint: endpoint || await resolveQoderInferenceEndpoint(options),
    requestBody: typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody),
    modelKey,
    modelSource,
  });
}

export async function loadQoderLocalAuth(options = {}) {
  const envToken = tokenFromEnv(options.env);
  if (envToken) return { token: envToken.token, source: envToken.source, userInfo: null };

  const configDir = resolveQoderConfigDir(options);
  const userPath = path.join(configDir, '.auth/user');
  const machinePath = path.join(configDir, '.auth/machine_id');
  if (!fsSync.existsSync(userPath) || !fsSync.existsSync(machinePath)) {
    throw createQoderAuthError('qoder_auth_not_found');
  }

  try {
    const [cipherText, machineId] = await Promise.all([
      fs.readFile(userPath, 'utf8'),
      fs.readFile(machinePath, 'utf8'),
    ]);
    const authWasm = await getAuthWasm(options);
    const raw = authWasm.credentialStorageDecrypt(cipherText.trim(), machineId.trim().slice(0, 16));
    const userInfo = JSON.parse(raw);
    const token = nonEmpty(userInfo.security_oauth_token) || nonEmpty(userInfo.access_token);
    if (!token) throw createQoderAuthError('qoder_auth_token_missing');
    const expireTime = Number(userInfo.expire_time || 0);
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (expireTime > 0 && expireTime <= nowSeconds + 60) throw createQoderAuthError('qoder_auth_expired');
    return { token, source: 'qoder_local_auth', userInfo };
  } catch (error) {
    // Do not rethrow bare Node errno codes (e.g. EPERM) — they surface as opaque bubbles.
    throw mapQoderAuthCaughtError(error);
  }
}

export async function loadQoderAccessToken(options = {}) {
  const auth = await loadQoderLocalAuth(options);
  return auth.token;
}
