import { performance } from 'node:perf_hooks';

import type { ChatMessage } from '../src/chat-controller.ts';
import {
  createConversationRenderWindowState,
  projectConversationRenderWindow,
} from '../src/conversation-render-window.ts';
import { highlightCode } from '../src/code-highlighter.ts';
import {
  highlightCodeCached,
  parseMarkdownBlocks,
  parseMarkdownBlocksCached,
} from '../src/markdown-view.tsx';
import { createToolPresentation } from '../src/tool-result-summary.ts';

interface BenchmarkResult {
  readonly scenario: string;
  readonly iterations: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly totalMs: number;
  readonly metadata: Readonly<Record<string, number | string>>;
}

function percentile(values: readonly number[], fraction: number): number {
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] ?? 0;
}

function benchmark(
  scenario: string,
  iterations: number,
  run: () => void,
  metadata: Readonly<Record<string, number | string>>,
): BenchmarkResult {
  for (let index = 0; index < Math.min(iterations, 20); index += 1) run();
  const durations: number[] = [];
  const totalStartedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    run();
    durations.push(performance.now() - startedAt);
  }
  const totalMs = performance.now() - totalStartedAt;
  durations.sort((left, right) => left - right);
  return {
    scenario,
    iterations,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.at(-1) ?? 0,
    totalMs,
    metadata,
  };
}

function assistantMessage(id: number, content: string): ChatMessage {
  return {
    id: `assistant-${id}`,
    role: 'assistant',
    content,
    timestamp: id,
    pending: false,
    segments: [{ type: 'text', content }],
  };
}

const markdownFixture = Array.from({ length: 40 }, (_, index) => [
  `## Section ${index}`,
  '',
  `Paragraph ${index} with **bold**, *emphasis*, and \`inline code\`.`,
  '',
  '| Name | Value | Status |',
  '| --- | ---: | :---: |',
  `| item-${index} | ${index * 17} | ok |`,
  '',
  '```typescript',
  `export const value${index} = ${index};`,
  '```',
].join('\n')).join('\n\n');

const codeFixture = Array.from({ length: 1_000 }, (_, index) => (
  `export function value${index}(input: number): number { return input + ${index}; }`
)).join('\n');
const streamRevisions = Array.from({ length: 200 }, (_, index) => (
  markdownFixture.slice(0, Math.ceil(markdownFixture.length * ((index + 1) / 200)))
));

const longConversation = Array.from({ length: 10_000 }, (_, index) => (
  assistantMessage(index, `message ${index}: ${'content '.repeat(20)}`)
));
const renderWindowState = createConversationRenderWindowState(longConversation);

const toolOutput = Array.from({ length: 5_000 }, (_, index) => (
  `line ${String(index).padStart(5, '0')} ${'tool output '.repeat(8)}`
)).join('\n');

const results = [
  benchmark('markdown.parse', 250, () => {
    parseMarkdownBlocks(markdownFixture);
  }, { chars: markdownFixture.length }),
  benchmark('markdown.parse.cached', 250, () => {
    parseMarkdownBlocksCached(markdownFixture);
  }, { chars: markdownFixture.length }),
  benchmark('markdown.stream.revisions', 25, () => {
    for (const revision of streamRevisions) parseMarkdownBlocksCached(revision);
  }, { revisions: streamRevisions.length, finalChars: markdownFixture.length }),
  benchmark('code.highlight', 100, () => {
    highlightCode(codeFixture, 'typescript');
  }, { chars: codeFixture.length, lines: 1_000 }),
  benchmark('code.highlight.cached', 100, () => {
    highlightCodeCached(codeFixture, 'typescript');
  }, { chars: codeFixture.length, lines: 1_000 }),
  benchmark('conversation.project', 1_000, () => {
    projectConversationRenderWindow(longConversation, renderWindowState);
  }, { messages: longConversation.length }),
  benchmark('tool.presentation', 1_000, () => {
    createToolPresentation({
      capabilityId: 'local.shell.exec',
      status: 'completed',
      outputPreview: toolOutput,
      arguments: { command: 'generate fixture' },
    });
  }, { chars: toolOutput.length, lines: 5_000 }),
] satisfies BenchmarkResult[];

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  results,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
