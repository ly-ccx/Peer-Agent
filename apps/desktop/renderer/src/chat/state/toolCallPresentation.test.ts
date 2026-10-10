import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { presentToolCall, toolResultFailureReason } from './toolCallPresentation.ts';

const base = { turnSettled: true, interrupted: false, isZh: true };

describe('presentToolCall', () => {
  it('keeps a missing result spinning only while the turn is still live', () => {
    const live = presentToolCall({ ...base, result: undefined, turnSettled: false });
    assert.equal(live.phase, 'running');
    assert.equal(live.body, null);
    assert.equal(live.statusLabel, null);

    const liveNull = presentToolCall({ ...base, result: null, turnSettled: false });
    assert.equal(liveNull.phase, 'running');
  });

  it('shows a cancelled placeholder when the turn was interrupted and no result arrived', () => {
    for (const result of [undefined, null, 'null', '  null  '] as const) {
      const view = presentToolCall({ ...base, result, interrupted: true });
      assert.equal(view.phase, 'cancelled', `result ${String(result)}`);
      assert.equal(view.statusLabel, '已取消');
      assert.match(view.body ?? '', /没有返回内容/);
      assert.equal(view.body?.includes('null'), false);
    }
  });

  it('shows 未返回 for a settled turn that was not interrupted', () => {
    const view = presentToolCall({ ...base, result: undefined, interrupted: false });
    assert.equal(view.phase, 'incomplete');
    assert.equal(view.statusLabel, '未返回');
    assert.match(view.body ?? '', /没有返回内容/);
  });

  it('treats the literal string null as settled even while the turn is still streaming', () => {
    const view = presentToolCall({
      ...base,
      result: 'null',
      turnSettled: false,
      interrupted: false,
    });
    assert.equal(view.phase, 'incomplete');
    assert.notEqual(view.phase, 'running');
  });

  it('maps stored interrupt notes to 已取消 and missing-result notes to 未返回', () => {
    const cancelled = presentToolCall({ ...base, result: '工具调用已中断（生成停止）' });
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.body, '工具调用已中断（生成停止）');

    const bare = presentToolCall({ ...base, result: '工具调用已中断' });
    assert.equal(bare.phase, 'cancelled');

    const missing = presentToolCall({ ...base, result: '工具结果未返回（本轮已结束）' });
    assert.equal(missing.phase, 'incomplete');
    assert.equal(missing.statusLabel, '未返回');
    assert.equal(missing.body, '工具结果未返回（本轮已结束）');
  });

  it('does not treat file text that merely mentions the interrupt phrase as cancelled', () => {
    const file = 'line\n工具调用已中断（生成停止）\nmore';
    const view = presentToolCall({ ...base, result: file });
    assert.equal(view.phase, 'completed');
    assert.equal(view.body, file);
  });

  it('surfaces a read_file failure reason instead of a raw null', () => {
    const raw = JSON.stringify({
      kind: 'read_file_result',
      tool: 'read_file',
      status: 'failed',
      reason: 'start_line_out_of_range',
      path: 'apps/desktop/renderer/src/styles/inputs.css',
    }, null, 2);
    const view = presentToolCall({ ...base, result: raw });
    assert.equal(view.phase, 'failed');
    assert.equal(view.statusLabel, '失败');
    assert.match(view.body ?? '', /start_line_out_of_range/);
    assert.equal(toolResultFailureReason(raw), 'start_line_out_of_range');
  });

  it('keeps a successful file read as completed content', () => {
    const raw = JSON.stringify({
      kind: 'local_file_ref',
      tool: 'read_file',
      status: 'success',
      preview: '.input {}',
    }, null, 2);
    const view = presentToolCall({ ...base, result: raw });
    assert.equal(view.phase, 'completed');
    assert.equal(view.statusLabel, null);
    assert.match(view.body ?? '', /local_file_ref/);
    assert.equal(toolResultFailureReason(raw), null);
  });

  it('surfaces Error: strings from materializeToolOutput as failures', () => {
    const view = presentToolCall({ ...base, result: 'Error: File not found: /tmp/missing.css' });
    assert.equal(view.phase, 'failed');
    assert.match(view.body ?? '', /File not found/);
  });

  it('does not render an empty successful result as the word null', () => {
    const view = presentToolCall({ ...base, result: '' });
    assert.equal(view.phase, 'completed');
    assert.equal(view.body, null);
  });
});
