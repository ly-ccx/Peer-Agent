import assert from 'node:assert/strict';
import test from 'node:test';

import { toolActivityPreview } from './tool-activity-preview.ts';

test('缺失结果预览为空文本，失败载荷仍保留原因', () => {
  assert.deepEqual(toolActivityPreview(null, 4000), { text: '', truncated: false, redacted: false });
  assert.deepEqual(toolActivityPreview(undefined, 4000), { text: '', truncated: false, redacted: false });
  const failed = toolActivityPreview({ status: 'failed', reason: 'start_line_out_of_range' }, 4000);
  assert.match(failed.text, /start_line_out_of_range/);
  assert.notEqual(failed.text, 'null');
});
