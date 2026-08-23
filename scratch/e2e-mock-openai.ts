/**
 * E2E 测试台：本地 mock OpenAI 端点。
 *
 * 契约（probe 阶段确认）：
 * - peer-dev 的 openai-compatible 通道 POST {baseUrl}/chat/completions（SSE 流式）。
 * - mock 按「对话推进状态机」回放工具调用：
 *   send() 轮：goal_create_plan 建计划；
 *   Runner tick 1：bash 写标记文件 + goal_update_task completed（带真实工具 evidence）；
 *   Runner tick 2：goal_update_task criterionResults + completed:true 声明完成。
 * - 通过 env MOCK_SCRIPT 环境变量选择剧本（happy / manual-dod）。
 */

const PORT = Number(process.env.MOCK_PORT ?? 18623);
const SCRIPT = process.env.MOCK_SCRIPT ?? 'happy';

function sse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}

function textDelta(content) {
  return { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] };
}

function toolCallDelta(id, name, argsJson, callIndex = 0) {
  return {
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: callIndex,
          id,
          type: 'function',
          function: { name, arguments: argsJson },
        }],
      },
      finish_reason: null,
    }],
  };
}

function finishChunk(reason = 'tool_calls') {
  return { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

/** 数一下历史里 goal 工具调用出现过几次，决定当前处于哪个阶段。 */
function stageOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let createPlan = 0;
  let updateTask = 0;
  let bash = 0;
  for (const message of messages) {
    const tools = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of tools) {
      const name = call?.function?.name ?? '';
      if (name === 'goal_create_plan') createPlan += 1;
      if (name === 'goal_update_task') updateTask += 1;
      if (name === 'bash' || name === 'local.bash' || name === 'shell') bash += 1;
    }
  }
  return { createPlan, updateTask, bash, messages };
}

const MARKER = '/tmp/peer-exec-goal-e2e-marker.txt';

function happyPlanArgs() {
  // manual-dod 剧本追加一条 manual 验收标准（留白触发人工确认闸门）。
  const manualCriteria = SCRIPT === 'manual-dod'
    ? [{ id: 'crit-human', kind: 'manual', detail: '人工验收结果可接受' }]
    : [];
  return JSON.stringify({
    title: 'E2E exec self-driven goal',
    goal: '在本次 peer exec 内自动创建并完成一个最小 goal：写入标记文件并验证',
    tasks: [
      { title: '写入标记文件并验证存在' },
      { title: '回填子任务完成状态与 DoD 证据' },
    ],
    successCriteria: [
      { id: 'crit-marker', kind: 'command', detail: `test -f ${MARKER}` },
      { id: 'crit-summary', kind: 'file-contains', detail: `${MARKER} 包含 self-driven` },
      ...manualCriteria,
    ],
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/chat/completions')) {
      const body = await req.json().catch(() => ({}));
      const stage = stageOf(body);
      // 调试：dump 请求 body（前 3 次每个请求）
      if (process.env.MOCK_DEBUG_DUMP) {
        const seq = (globalThis.__dumpSeq = (globalThis.__dumpSeq ?? 0) + 1);
        if (seq <= 8) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(`/tmp/mock-dump-${seq}.json`, JSON.stringify(body.messages?.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 300) : m.content, tool_calls: m.tool_calls?.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments?.slice(0, 200) })) })), null, 2));
        }
      }
      const log = `[mock] stage: createPlan=${stage.createPlan} updateTask=${stage.updateTask} bash=${stage.bash}`;
      console.error(log);

      // ---- send() 轮：模型建计划 ----
      if (stage.createPlan === 0 && stage.updateTask === 0 && stage.bash === 0) {
        return sse([toolCallDelta('call-plan', 'goal_create_plan', happyPlanArgs()), finishChunk()]);
      }

      // ---- Runner tick 1：bash 写标记（evidence 由工具结果带出） ----
      if (SCRIPT === 'happy' && stage.bash === 0) {
        return sse([
          toolCallDelta('call-bash', 'bash', JSON.stringify({
            command: `echo "self-driven exec goal e2e $(date +%s)" > ${MARKER} && cat ${MARKER}`,
            description: 'write and verify marker file',
          }), 0),
          finishChunk(),
        ]);
      }

      // ---- Runner tick 2（happy）：用 bash evidence 完成两个子任务 + criterion + 声明完成 ----
      if (SCRIPT === 'happy' && stage.bash >= 1) {
        const planId = planIdFromBody(body) ?? undefined;
        const taskIds = allTaskIds(body);
        const evidence = bashEvidenceRefs(body);
        return sse([
          toolCallDelta('call-task1', 'goal_update_task', JSON.stringify({
            planId,
            taskId: taskIds[0],
            status: 'completed',
            result: '标记文件已写入并读回验证',
            evidenceRefs: evidence,
          }), 0),
          toolCallDelta('call-task2', 'goal_update_task', JSON.stringify({
            planId,
            taskId: taskIds[1] ?? taskIds[0],
            status: 'completed',
            result: 'DoD 已回填，目标达成',
            evidenceRefs: evidence,
          }), 1),
          toolCallDelta('call-crit', 'goal_update_task', JSON.stringify({
            planId,
            criterionResults: [
              { criterionId: 'crit-marker', passed: true, evidenceRef: evidence[0] },
              { criterionId: 'crit-summary', passed: true, evidenceRef: evidence[0] },
            ],
          }), 2),
          textDelta('All subtasks completed with evidence; goal satisfied.'),
          finishChunk('stop'),
        ]);
      }

      // ---- manual-dod 剧本：机器部分完成，manual 留白 ----
      if (SCRIPT === 'manual-dod') {
        const planId = planIdFromBody(body) ?? undefined;
        const taskIds = allTaskIds(body);
        if (stage.bash === 0) {
          return sse([
            toolCallDelta('call-bash', 'bash', JSON.stringify({
              command: `echo "manual-dod e2e" > ${MARKER}`,
              description: 'write marker file',
            }), 0),
            finishChunk(),
          ]);
        }
        const evidence = bashEvidenceRefs(body);
        return sse([
          toolCallDelta('call-task1', 'goal_update_task', JSON.stringify({
            planId,
            taskId: taskIds[0],
            status: 'completed',
            result: '机器部分完成',
            evidenceRefs: evidence,
          }), 0),
          toolCallDelta('call-crit', 'goal_update_task', JSON.stringify({
            planId,
            criterionResults: [
              { criterionId: 'crit-marker', passed: true, evidenceRef: evidence[0] },
              // crit-human 故意不回填 → gate 应转 manual_confirmation_required
            ],
          }), 1),
          textDelta('Machine-verifiable criteria done; awaiting human acceptance.'),
          finishChunk('stop'),
        ]);
      }

      // 兜底：纯文本收尾
      return sse([textDelta('nothing more to do'), finishChunk('stop')]);
    }
    return new Response('not found', { status: 404 });
  },
});

// —— 请求 Body 解析辅助（从工具调用历史里提取 planId / taskId）——
function planIdFromBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // 1) assistant 的 goal_update_task 调用参数里带 planId
    const tools = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (let j = tools.length - 1; j >= 0; j -= 1) {
      try {
        const args = JSON.parse(tools[j]?.function?.arguments ?? '{}');
        if (typeof args?.planId === 'string' && args.planId) return args.planId;
      } catch { /* ignore */ }
    }
    // 2) tool 结果消息：{"status":"success","output":{"ok":true,"planId":...,"plan":{...,"tasks":[...]}}}
    const parsed = parseToolContent(message);
    const planId = parsed?.output?.planId ?? parsed?.planId ?? parsed?.output?.plan?.planId;
    if (typeof planId === 'string' && planId) return planId;
  }
  return null;
}

/** 从消息历史中提取 bash 工具结果里的 evidenceRefs（host 执行成功后带出）。 */
function bashEvidenceRefs(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'tool') continue;
    const content = typeof message?.content === 'string' ? message.content : '';
    if (!content.includes('evidenceRefs')) continue;
    try {
      const parsed = JSON.parse(content);
      const refs = Array.isArray(parsed?.evidenceRefs)
        ? parsed.evidenceRefs
        : Array.isArray(parsed?.output?.evidenceRefs) ? parsed.output.evidenceRefs : [];
      const valid = refs.filter((r) => typeof r === 'string' && r.length > 0);
      if (valid.length > 0) return valid;
    } catch { /* not json */ }
  }
  return [];
}

function findFirstTaskId(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === 'string' && content.includes('"taskId"')) {
      try {
        const parsed = JSON.parse(content);
        const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        if (tasks[0]?.taskId) return tasks[0].taskId;
      } catch { /* not json */ }
    }
  }
  return undefined;
}

function allTaskIds(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parsed = parseToolContent(messages[i]);
    const tasks = parsed?.output?.plan?.tasks ?? parsed?.tasks ?? parsed?.output?.tasks;
    if (Array.isArray(tasks)) {
      const ids = tasks.map((t) => t?.taskId).filter(Boolean);
      if (ids.length > 0) return ids;
    }
    // assistant 工具调用参数里的 taskId 也是线索（单个）
    const tools = Array.isArray(messages[i]?.tool_calls) ? messages[i].tool_calls : [];
    for (const call of tools) {
      try {
        const args = JSON.parse(call?.function?.arguments ?? '{}');
        if (typeof args?.taskId === 'string' && args.taskId) return [args.taskId];
      } catch { /* ignore */ }
    }
  }
  return [];
}

/** 解析 tool 消息 content：兼容 {"status":"success","output":{...}} 包装与裸对象。 */
function parseToolContent(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  if (!content.startsWith('{')) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

console.error(`[mock-openai] listening on :${PORT} script=${SCRIPT}`);
export default server;
