import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatToolResultForStream, resolveCapabilityDisplayName } from './tool-orchestrator.mjs';

// 回归：MCP 工具卡标题透传。
// 背景：tool-call 事件此前只发裸 capability 名（如 mcp__server__tool），
// 导致渲染层「标题不见了」。displayName 是后端 Runtime Projection 注入的展示文案，
// 必须能按 name 反查并随事件透传给表达层。
describe('resolveCapabilityDisplayName', () => {
  const projection = {
    capabilities: [
      {
        name: 'mcp__dingtalk__create_document',
        capabilityId: 'local.mcp.dingtalk',
        displayName: '钉钉文档: create_document',
      },
      {
        name: 'read_file',
        capabilityId: 'local.file.read',
        // 本地工具没有 displayName —— 渲染层自有回退，不依赖这里。
      },
    ],
  };

  it('returns the projected displayName for an MCP capability by name', () => {
    assert.equal(
      resolveCapabilityDisplayName(projection, 'mcp__dingtalk__create_document'),
      '钉钉文档: create_document',
    );
  });

  it('returns null when the capability has no displayName', () => {
    assert.equal(resolveCapabilityDisplayName(projection, 'read_file'), null);
  });

  it('returns null when the capability is not in the projection', () => {
    assert.equal(resolveCapabilityDisplayName(projection, 'unknown_tool'), null);
  });

  it('is defensive against a missing/empty projection', () => {
    assert.equal(resolveCapabilityDisplayName(undefined, 'x'), null);
    assert.equal(resolveCapabilityDisplayName(null, 'x'), null);
    assert.equal(resolveCapabilityDisplayName({}, 'x'), null);
    assert.equal(resolveCapabilityDisplayName({ capabilities: [] }, 'x'), null);
  });

  it('treats an empty-string displayName as absent (falls back to null)', () => {
    const p = { capabilities: [{ name: 't', displayName: '' }] };
    assert.equal(resolveCapabilityDisplayName(p, 't'), null);
  });
});

describe('formatToolResultForStream', () => {
  it('keeps non-interaction tool results bounded for the UI stream', () => {
    const output = 'x'.repeat(4010);
    const result = formatToolResultForStream({ name: 'bash', args: {}, output });
    assert.equal(result.length, 4000);
  });

  it('streams a complete interaction projection for namespaced request_user_input', () => {
    const question = `需要确认：${'很长'.repeat(1500)}`;
    const result = formatToolResultForStream({
      name: 'local.interaction.request_user_input',
      args: { question, options: ['继续', '停止'], note: '请选择' },
      output: JSON.stringify({ ok: true, question }),
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.question, question);
    assert.deepEqual(parsed.options, ['继续', '停止']);
    assert.equal(parsed.note, '请选择');
  });
});
