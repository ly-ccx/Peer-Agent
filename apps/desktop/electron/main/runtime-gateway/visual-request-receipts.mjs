import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ensurePreviewDirectory, readPreviewFile } from './desktop-preview-artifacts.mjs';

/** Host-only evidence writer. A receipt never changes admission/judgment truth. */
export function createVisualRequestReceiptStore({ userDataPath }) {
  function start({ streamId, model, modelRunId, observations }) {
    const requestId = randomUUID();
    const directory = ensurePreviewDirectory(userDataPath, 'ui-delivery/requests');
    const filePath = path.join(directory, `${requestId}.json`);
    const record = { kind: 'visual_request_transport', version: 2, requestId, streamId, model, modelRunId,
      startedAt: new Date().toISOString(), observations, attempts: [], status: 'prepared', judgment: 'not-evaluated' };
    const save = () => {
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, filePath);
    };
    save();
    return {
      requestId,
      attempt({ attemptId = randomUUID(), wire, model, bodyHash, imagesPresent }) {
        const attempt = { attemptId, wire, model, bodyHash, imagesPresent,
          status: 'transport-started', startedAt: new Date().toISOString() };
        record.attempts.push(attempt); save();
        return ({ status, httpStatus }) => {
          attempt.status = status;
          if (Number.isInteger(httpStatus)) attempt.httpStatus = httpStatus;
          attempt.completedAt = new Date().toISOString(); save();
        };
      },
      finish(status, responseBinding = { status: 'unbound', reason: 'request-incomplete' }) {
        record.status = status;
        record.responseBinding = responseBinding;
        record.completedAt = new Date().toISOString(); save();
      },
    };
  }
  function read(requestId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error('visual-request-id');
    return JSON.parse(readPreviewFile(userDataPath, `ui-delivery/requests/${requestId}.json`).bytes.toString('utf8'));
  }
  return { start, read };
}
