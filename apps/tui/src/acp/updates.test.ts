import { expect, test } from 'bun:test';
import type { ChatSnapshot } from '../chat-controller.ts';
import type { ToolPresentation, ToolPresentationStatus } from '../tool-result-summary.ts';
import { createAcpUpdateProjector } from './updates.ts';

for (const ending of ['completed', 'failed', 'cancelled', 'denied', 'unknown'] as ToolPresentationStatus[]) {
  test(`text and tool updates preserve order and identity / ${ending}`, () => {
    const project = createAcpUpdateProjector();
    const tool: ToolPresentation = { capabilityId: 'local.shell', toolName: 'bash', toolCallId: 'real-id', argumentSummary: '', arguments: { command: 'pwd' }, status: 'running', detail: '', detailLines: [] };
    const snapshot = (text: string, current: ToolPresentation): ChatSnapshot => ({ status: 'idle', mode: 'chat', messages: [{ id: 'assistant', role: 'assistant', content: text, segments: [{ type: 'text', content: text }, { type: 'tool-call', tool: current }] }] });
    const first = project(snapshot('hello', tool));
    expect(first.map((u) => u.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call']);
    expect(project(snapshot('hello', tool))).toEqual([]);
    const final = project(snapshot('hello world', { ...tool, status: ending, detail: 'structured result' }));
    expect(final[0]).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } });
    expect(final[1]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'real-id', status: ending === 'completed' ? 'completed' : ending === 'unknown' ? 'pending' : 'failed' });
    expect(project(snapshot('hello world', { ...tool, status: ending, detail: 'structured result' }))).toEqual([]);
  });
}

test('assistant prose cannot manufacture a tool call and projectors are isolated', () => {
  const snapshot: ChatSnapshot = { status: 'idle', mode: 'chat', messages: [{ id: 'same', role: 'assistant', content: '[Tool call] bash' }] };
  const a = createAcpUpdateProjector();
  const b = createAcpUpdateProjector();
  expect(a(snapshot)).toEqual(b(snapshot));
  expect(a(snapshot)).toEqual([]);
});
