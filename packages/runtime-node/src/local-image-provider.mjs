import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createEvidenceBundle } from '@peer-agent/runtime-core';
import { LOCAL_IMAGE_CAPABILITY, LOCAL_IMAGE_MAX_BYTES, LOCAL_IMAGE_MAX_PIXELS } from '@peer-agent/protocol';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';

const observations = new WeakMap();
/** @param {unknown} value @param {string} [toolCallId] @returns {value is import('@peer-agent/protocol').LocalImageObservation} */
export function isLocalImageObservation(value, toolCallId) {
  return Boolean(value && observations.has(value) && (toolCallId === undefined || observations.get(value) === toolCallId));
}

export function detectLocalImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Reject oversized headers before asking a decoder to allocate a pixel buffer.
function headerDimensions(b, type) {
  if (type === 'image/png' && b.length >= 24 && b.toString('ascii', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (type === 'image/gif' && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 255) return null;
      while (b[offset] === 255) offset++;
      const marker = b[offset++];
      if (marker === 217 || marker === 218) return null;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > b.length) return null;
      const size = b.readUInt16BE(offset);
      if (size < 2 || offset + size > b.length) return null;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) return { width: b.readUInt16BE(offset + 5), height: b.readUInt16BE(offset + 3) };
      offset += size;
    }
  }
  if (type === 'image/webp' && b.length >= 30) {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8 ' && b.subarray(23, 26).equals(Buffer.from([157,1,42]))) return { width: b.readUInt16LE(26) & 16383, height: b.readUInt16LE(28) & 16383 };
  }
  if (type === 'image/webp' && b.length >= 25 && b.toString('ascii', 12, 16) === 'VP8L' && b[20] === 47) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
  }
  return null;
}
function within(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function unchanged(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function failure(reason, status = 'failed') { return Object.assign(new Error(reason), { reason, status }); }
function checkSignal(signal) { if (signal?.aborted) throw failure('image_read_cancelled', 'cancelled'); }
function checkDimensions(size, maxPixels) {
  if (!Number.isSafeInteger(size?.width) || !Number.isSafeInteger(size?.height) || size.width <= 0 || size.height <= 0) throw failure('image_decode_failed');
  if (size.width * size.height > maxPixels) throw failure('image_pixel_limit_exceeded');
}

/**
 * Bounded file/permission/Evidence Module. The host injects its actual decoder.
 * @param {{ workspaceRoot?: string, decodeImage?: (bytes: Buffer, mediaType: import('@peer-agent/protocol').LocalImageMediaType, context: { signal?: AbortSignal }) => { width: number, height: number } | Promise<{ width: number, height: number }>, maxBytes?: number, maxPixels?: number }} options
 */
export function createLocalImageProvider({ workspaceRoot, decodeImage, maxBytes = LOCAL_IMAGE_MAX_BYTES, maxPixels = LOCAL_IMAGE_MAX_PIXELS } = {}) {
  return {
    providerId: 'local-image-provider',
    capabilityIds: [LOCAL_IMAGE_CAPABILITY],
    /**
     * @param {{ call: import('@peer-agent/protocol').ClientToolCall }} request
     * @param {{ locale?: string, workspaceRoot?: string, signal?: AbortSignal, toolContext?: { workspacePath?: string, supportsVision?: boolean, accessLevel?: string, turnRole?: string, readableRoots?: readonly string[], permissionPolicy?: { kind?: string } }, requestPermission?: (request: { capabilityId: string, toolName: string, args: Record<string, unknown>, scope: import('@peer-agent/protocol').LocalImagePermissionScope, riskLevel: string, dataLevel: string, reason: string }) => Promise<{ granted: boolean }> }} context
     * @returns {Promise<{ call: import('@peer-agent/protocol').ClientToolCall, grant: import('@peer-agent/protocol').LocalImagePermissionGrant, result: import('@peer-agent/protocol').LocalImageToolResult } | null>}
     */
    async executeCapability({ call }, { locale = 'zh-CN', toolContext = {}, requestPermission, signal, workspaceRoot: executionRoot } = {}) {
      if (call.capabilityId !== LOCAL_IMAGE_CAPABILITY) return null;
      const args = call.arguments || {};
      let granted = false;
      let scope = LOCAL_IMAGE_CAPABILITY;
      let handle;
      try {
        checkSignal(signal);
        if (toolContext.supportsVision === false) throw failure('model_vision_unavailable');
        if (toolContext.permissionPolicy?.kind === 'objective_probe') throw failure('objective_probe_capability_denied', 'denied');
        if (typeof args.path !== 'string' || !args.path.trim()) throw failure('image_path_required');
        const root = toolContext.workspacePath || executionRoot || workspaceRoot;
        if (!root && !isAbsolute(args.path)) throw failure('image_absolute_path_required');
        const path = await realpath(resolve(root || '.', args.path));
        const before = await stat(path);
        if (!before.isFile()) throw failure('image_regular_file_required');
        if (before.size > maxBytes) throw failure('image_byte_limit_exceeded');
        scope = { capabilityId: LOCAL_IMAGE_CAPABILITY, path, workspacePath: root || null, action: 'read_image_for_model' };
        const roots = Array.isArray(toolContext.readableRoots) ? toolContext.readableRoots : [root].filter(Boolean);
        const canonicalRoots = await Promise.all(roots.map(r => realpath(r).catch(() => null)));
        granted = canonicalRoots.some(r => r && within(path, r));
        if (!granted) {
          if (toolContext.accessLevel === 'restricted_local' || toolContext.turnRole === 'project_agent') throw failure('image_outside_read_scope', 'denied');
          const decision = await requestPermission?.({
            capabilityId: LOCAL_IMAGE_CAPABILITY, toolName: 'view_image',
            args: { path, workspacePath: root || null }, scope,
            riskLevel: 'L1_local_read', dataLevel: 'D2_sensitive',
            reason: 'Read this local image and send its pixels to the current model.',
          });
          granted = decision?.granted === true;
          if (!granted) throw failure('image_permission_denied', 'denied');
        }
        checkSignal(signal);
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        if (!unchanged(before, await handle.stat())) throw failure('image_changed_during_read');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          checkSignal(signal);
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw failure('image_changed_during_read');
          offset += read.bytesRead;
        }
        if (!unchanged(before, await handle.stat()) || !unchanged(before, await stat(path)) || await realpath(path) !== path) throw failure('image_changed_during_read');
        const mediaType = detectLocalImageMediaType(bytes);
        if (!mediaType) throw failure('image_type_unsupported');
        const header = headerDimensions(bytes, mediaType);
        if (!header) throw failure('image_decode_failed');
        checkDimensions(header, maxPixels);
        if (typeof decodeImage !== 'function') throw failure('image_decoder_unavailable');
        let dimensions;
        try { dimensions = await decodeImage(bytes, mediaType, { signal }); }
        catch { checkSignal(signal); throw failure('image_decode_failed'); }
        checkDimensions(dimensions, maxPixels);
        checkSignal(signal);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const metadata = { path, mediaType, width: dimensions.width, height: dimensions.height, byteLength: bytes.length, sha256, artifactRef: `local-image-artifact://${sha256}` };
        const observation = Object.freeze({ ...metadata, kind: 'local_image', dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}` });
        observations.set(observation, call.toolCallId);
        const result = {
          toolCallId: call.toolCallId, status: 'success', completedAt: nowIso(),
          outputPreview: { ...metadata, retrievalHint: `view_image(${JSON.stringify({ path })})` },
          evidence: createEvidenceBundle({ evidenceId: randomUUID(), toolCallId: call.toolCallId, locale, dataLevel: 'D2_sensitive', returnedToCloud: true, summary: `Local image read: ${path} (${dimensions.width} × ${dimensions.height})`, artifactRefs: [metadata.artifactRef], metadata }),
        };
        Object.defineProperty(result, 'modelContext', { value: Object.freeze({ visualObservations: Object.freeze([observation]) }), enumerable: false });
        return { call, grant: createPermissionGrant({ toolCallId: call.toolCallId, granted, scope }), result };
      } catch (error) {
        const reason = error.reason || (error.code === 'ENOENT' ? 'image_not_found' : 'image_read_failed');
        return { call, grant: createPermissionGrant({ toolCallId: call.toolCallId, granted, scope }), result: createFailedClientToolResult({ call, locale, reason, status: error.status || 'failed', dataLevel: 'D2_sensitive' }) };
      } finally { await handle?.close(); }
    },
  };
}
