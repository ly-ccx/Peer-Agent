import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpHostPromptSource } from './mcp-host-source.mjs';

function fakeRegistry({ path = '/home/u/.peer-agent/mcp-registry.json', servers = [] } = {}) {
  return {
    path() {
      return path;
    },
    listInstalled() {
      return servers;
    },
  };
}

const DMS_SERVER = {
  id: 'dms',
  displayName: 'DMS MCP',
  enabled: true,
  transport: 'streamable_http',
  toolsCount: 12,
};

describe('mcp-host prompt source', () => {
  it('injects host self-awareness with registry path and installed servers', () => {
    const source = createMcpHostPromptSource();
    const observation = source.observe({ mcpRegistry: fakeRegistry({ servers: [DMS_SERVER] }) });
    const sections = source.render(observation);

    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.equal(section.layer, 'L1_AGENT');
    assert.equal(section.trust, 'builtin');
    // 必须声明「我自己是 MCP host」这条身份事实。
    assert.match(section.content, /you .*are yourself an mcp host/i);
    // 必须给出真实注册表路径与已装 server。
    assert.match(section.content, /mcp-registry\.json/);
    assert.match(section.content, /DMS MCP/);
    assert.match(section.content, /tools=12/);
    // 必须给出「先查自己、再看外部」的行为准则。
    assert.match(section.content, /own local registry/i);
    assert.equal(section.source.kind, 'mcp-host-self-awareness');
    assert.equal(section.source.serverCount, 1);
    assert.equal(section.source.degraded, false);
  });

  it('still declares host identity when no servers are installed', () => {
    const source = createMcpHostPromptSource();
    const observation = source.observe({ mcpRegistry: fakeRegistry({ servers: [] }) });
    const sections = source.render(observation);

    assert.equal(sections.length, 1);
    assert.match(sections[0].content, /you .*are yourself an mcp host/i);
    assert.match(sections[0].content, /none yet/i);
    assert.equal(sections[0].source.serverCount, 0);
    assert.equal(sections[0].source.degraded, false);
  });

  it('degrades gracefully when the registry handle is missing', () => {
    const source = createMcpHostPromptSource();
    const observation = source.observe({});
    const sections = source.render(observation);

    assert.equal(sections.length, 1);
    // 句柄缺失也要声明身份，并标记 degraded。
    assert.match(sections[0].content, /you .*are yourself an mcp host/i);
    assert.equal(sections[0].source.degraded, true);
    assert.equal(sections[0].source.serverCount, 0);
  });

  it('is resilient when listInstalled throws', () => {
    const source = createMcpHostPromptSource();
    const observation = source.observe({
      mcpRegistry: {
        path() {
          return '/tmp/mcp-registry.json';
        },
        listInstalled() {
          throw new Error('registry unavailable');
        },
      },
    });
    const sections = source.render(observation);

    assert.equal(sections.length, 1);
    assert.equal(sections[0].source.degraded, true);
    assert.match(sections[0].content, /mcp-registry\.json/);
  });
});
