import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const STREAM_INPUT = 'RC_NATIVE_STREAM';
export const STOP_INPUT = 'RC_NATIVE_STOP';
export const LONG_INPUT = 'RC_STREAM_LONG';
export const RETRY_INPUT = 'RC_NATIVE_RETRY';
export const WORK_INPUT = 'RC_NATIVE_WORK';
export const CLASSIC_IMAGE_INPUT = 'RC_NATIVE_CLASSIC_IMAGE';
export const PRIVATE_REASONING = 'PRIVATE_REASONING_MUST_NOT_RENDER';
export const FIRST_PARAGRAPH = '我先看看项目的整体情况，整理好后告诉你重点。';
export const SECOND_PARAGRAPH = '项目把界面和本地执行分开了，我再确认它们如何连接。';
export const STREAM_REPLY = '**项目概况**\n\n- 界面展示结果，本地负责执行能力。\n- 开始修改前，先核对项目规则。';

export async function startBotShellModelFixture() {
  const requests = [];
  const errors = [];
  const active = new Map();
  let classicImagePath;

  function answer(body, res) {
    const messages = body.messages;
    const text = messages.findLast(message => message.role === 'user')?.content;
    const scenario = typeof text === 'string' ? text
      : Array.isArray(text) ? text.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
    const record = { scenario, model: body.model, effort: body.reasoning_effort, finished: false, disconnected: false };
    const round = 1 + requests.filter(request => request.scenario === scenario).length;
    requests.push(record);
    res.once('close', () => {
      record.disconnected = !record.finished;
      if (active.get(scenario)?.record === record) active.delete(scenario);
    });

    if (scenario === RETRY_INPUT && round === 1) {
      record.finished = true;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'RC controlled provider rejection', code: 'invalid_request' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    function send(delta, finish_reason, usage) {
      res.write(`data: ${JSON.stringify({ id: 'rc-smoke', choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`);
    }
    function finish(finishReason = 'stop') {
      record.finished = true;
      send({}, finishReason, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
      res.end('data: [DONE]\n\n');
    }
    if (scenario === CLASSIC_IMAGE_INPUT && messages.at(-1)?.role !== 'tool') {
      assert.ok(classicImagePath, 'Classic image path must belong to the isolated fixture');
      assert.ok(body.tools.some(tool => tool.function?.name === 'view_image'), 'the real Classic runtime must project view_image');
      send({ role: 'assistant', tool_calls: [{
        index: 0, id: 'rc-classic-image', type: 'function',
        function: { name: 'view_image', arguments: JSON.stringify({ path: classicImagePath }) },
      }] }, null);
      finish('tool_calls');
      return;
    }
    if (scenario === STREAM_INPUT || scenario === LONG_INPUT || (scenario === STOP_INPUT && round === 1)) {
      send({ role: 'assistant', reasoning_content: PRIVATE_REASONING }, null);
      active.set(scenario, { record, text: content => send({ content }, null), finish });
      return;
    }
    if (scenario === WORK_INPUT && messages.at(-1)?.role !== 'tool') {
      const args = {
        title: '核对项目说明',
        brief: '请读取 README.md 并汇报标记。',
        kind: 'research',
        readOnly: true,
        requiredCapabilities: ['local.file.read'],
        successCriteria: [{ kind: 'file-contains', description: '说明文件包含验收标记', path: 'README.md', expect: 'RC_FIXTURE_OK' }],
      };
      send({ role: 'assistant', tool_calls: [{
        index: 0, id: 'rc-native-spawn', type: 'function',
        function: { name: 'spawn_session', arguments: JSON.stringify(args) },
      }] }, null);
      finish('tool_calls');
      return;
    }
    if (scenario.startsWith('Delegated Task: 核对项目说明')) {
      if (messages.at(-1)?.role === 'tool') {
        const observation = JSON.parse(messages.at(-1).content);
        assert.match(JSON.stringify(observation), /RC_FIXTURE_OK/);
        send({ content: '已读取项目说明并核对 RC_FIXTURE_OK。' }, null);
        finish();
      } else {
        send({ role: 'assistant', tool_calls: [{
          index: 0, id: 'rc-native-read', type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
        }] }, null);
        finish('tool_calls');
      }
      return;
    }

    const reply = scenario === WORK_INPUT
      ? '正在核对项目说明。'
      : scenario.startsWith('[Host Wake Event Payload')
        ? (scenario.includes('RC_FIXTURE_OK') ? '项目说明已核对，找到 RC_FIXTURE_OK。' : 'NO_REPLY')
        : scenario ? 'RC scripted reply: ' + scenario : 'NO_REPLY';
    send({ role: 'assistant', content: reply }, null);
    finish();
  }

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      errors.push(`Unexpected fixture request: ${req.method} ${req.url}`);
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      answer(JSON.parse(Buffer.concat(chunks).toString('utf8')), res);
    } catch (error) {
      errors.push(error.message);
      res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    errors,
    setClassicImagePath: file => { classicImagePath = file; },
    streaming: scenario => active.has(scenario),
    send(scenario, content) {
      assert.ok(active.has(scenario), `No active request for ${scenario}`);
      active.get(scenario).text(content);
    },
    finish(scenario) {
      assert.ok(active.has(scenario), `No active request for ${scenario}`);
      active.get(scenario).finish();
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
