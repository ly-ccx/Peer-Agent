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

  // 回归（方案 B2）：batch_search 的聚合结果是一整段 JSON，超过字节上限时若按
  // `slice` 字节截断会变成非法 JSON，导致渲染层 JSON.parse 失败、卡片永远卡在
  // searching。这里断言：超限聚合结果经格式化后仍是**合法 JSON**，lanes 完整保留，
  // matches 按条数封顶并标记 truncated，preview 纯文本副本被剔除。
  it('keeps an oversized batch_search aggregate result as valid bounded JSON', () => {
    const lanes = Array.from({ length: 6 }, (_, i) => ({
      id: `lane${i}`,
      label: `lane ${i}`,
      query: 'q',
      status: 'completed',
      matchCount: 80,
    }));
    const matches = Array.from({ length: 80 }, (_, i) => ({
      path: `apps/some/very/long/path/to/file-${i}.ts`,
      line: i,
      text: `match text ${'x'.repeat(80)} ${i}`,
      laneIds: ['lane0'],
      hitCount: 1,
    }));
    const output = JSON.stringify({
      kind: 'local_capability_result_ref',
      tool: 'batch_search',
      capabilityId: 'local.search.aggregate',
      status: 'success',
      outputPreview: {
        status: 'success',
        tool: 'batch_search',
        lanes,
        aggregated: { totalUniqueMatches: 80, truncated: false, matches },
        preview: 'PLAINTEXT '.repeat(500),
      },
    });
    assert.ok(output.length > 4000, 'fixture must exceed the byte limit to exercise truncation');

    const result = formatToolResultForStream({ name: 'batch_search', args: {}, output });

    // 必须仍可被解析（旧实现在此处会抛错）。
    const parsed = JSON.parse(result);
    assert.equal(parsed.tool, 'batch_search');
    assert.equal(parsed.outputPreview.status, 'success');
    // lanes 全量保留，卡片才能逐路还原状态。
    assert.equal(parsed.outputPreview.lanes.length, 6);
    // matches 按条数封顶并标记 truncated。
    assert.equal(parsed.outputPreview.aggregated.matches.length, 50);
    assert.equal(parsed.outputPreview.aggregated.truncated, true);
    // totalUniqueMatches 保留真实总数，不被裁剪条数覆盖。
    assert.equal(parsed.outputPreview.aggregated.totalUniqueMatches, 80);
    // 给模型看的 preview 纯文本副本不应出现在 UI 流里。
    assert.equal(parsed.outputPreview.preview, undefined);
  });

  // 边界：聚合结果本身在条数上限内时，原样透传且保持合法 JSON、不误标 truncated。
  it('passes through a small batch_search aggregate result unchanged', () => {
    const output = JSON.stringify({
      kind: 'local_capability_result_ref',
      tool: 'batch_search',
      status: 'success',
      outputPreview: {
        status: 'success',
        lanes: [{ id: 'l0', query: 'q', status: 'completed', matchCount: 1 }],
        aggregated: {
          totalUniqueMatches: 1,
          truncated: false,
          matches: [{ path: 'a.ts', line: 1, text: 't', laneIds: ['l0'], hitCount: 1 }],
        },
      },
    });
    const result = formatToolResultForStream({ name: 'batch_search', args: {}, output });
    assert.equal(result, output);
  });
});
