# Peer TUI Performance Report

> Date: 2026-08-04  
> Code baseline: `dev/0.0.2` / `6d5c8e1b5e0ba821ab68cefde867123034eb0a41` plus the changes listed below  
> Runtime: Bun 1.2.17, macOS arm64  
> Scope: TUI event aggregation, render projections, Markdown parsing/highlighting, and large tool-result presentation

## 1. Goal

Establish a default-off measurement seam for Peer TUI, build repeatable fixtures, identify measured amplification, and make the smallest optimization supported by the data. A visual scheduler or state-store split is implemented only if its decision gate is triggered.

## 2. Reproduction

```bash
# Pure benchmark
pnpm --filter @peer-agent/tui perf:benchmark

# Runtime summary on normal exit
PEER_TUI_PERF=summary peer

# Bounded trace written outside the TUI surface
PEER_TUI_PERF=trace \
PEER_TUI_PERF_OUTPUT=/tmp/peer-tui-perf.jsonl \
peer
```

The benchmark source is `apps/tui/perf/tui-performance-benchmark.ts`.
Raw runs are retained as:

- `apps/tui/perf/baseline.json`
- `apps/tui/perf/optimized.json`

## 3. Fixtures

| Scenario | Fixture |
| --- | --- |
| Markdown parse | 40 sections with headings, inline markup, tables, and TypeScript fences |
| Streaming Markdown | 200 monotonically growing revisions of the Markdown fixture |
| Code highlight | 1,000 TypeScript source lines |
| Long conversation | render-window projection over 10,000 assistant messages |
| Tool burst | presentation projection of a 5,000-line / ~540K-character tool output |

Each scenario is warmed up before timed iterations. Reports include p50, p95, p99, max, and total duration.

## 4. Baseline results

| Scenario | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: |
| Markdown parse | 0.0834 ms | 0.1164 ms | 0.2705 ms | 1.7525 ms |
| Code highlight, 1,000 lines | 2.2883 ms | 2.9140 ms | 3.3182 ms | 3.5038 ms |
| Conversation projection, 10,000 messages | 0.0262 ms | 0.0478 ms | 0.0838 ms | 0.1845 ms |
| Tool presentation, 5,000 lines | 0.0055 ms | 0.0113 ms | 0.0165 ms | 0.0644 ms |

## 5. Diagnosis

The data rejects three initial hypotheses as primary local bottlenecks:

1. Conversation-window projection remains below 0.05 ms at p95 for 10,000 messages.
2. The existing tool-result presentation already projects a bounded summary; even a 5,000-line input remains near 0.01 ms p95.
3. Complex Markdown block parsing remains near 0.12 ms p95.

Code highlighting is the only measured operation in the multi-millisecond range. Completed Markdown messages may render again when unrelated snapshot fields change, making deterministic parse and highlight work a local amplification point.

## 6. Implemented changes

### Performance observation

`apps/tui/src/tui-perf.ts` adds a Module with:

- default-off `PEER_TUI_PERF` configuration;
- `summary` and bounded `trace` modes;
- p50/p95/p99/max aggregation;
- bounded duration samples and trace events;
- numeric field aggregation without recording message text;
- optional JSONL output;
- synchronous flush during governed TUI shutdown.

Instrumented seams:

- stream enqueue and flush;
- controller publish;
- App snapshot receipt;
- conversation render-window projection;
- Markdown parse and syntax highlight;
- Markdown/highlight cache hit and miss.

### Bounded render caches

`apps/tui/src/bounded-text-cache.ts` provides a small LRU bounded by both entry count and source-character budget.

Markdown block parsing:

- at most 256 entries;
- at most 64,000 characters per source;
- at most 1,000,000 source characters total.

Code highlighting:

- at most 128 entries;
- at most 256,000 characters per source;
- at most 2,000,000 source characters total.

The complete source plus language is the cache key. Completed content reuses immutable parse/token projections; a growing streaming tail naturally misses on every changed revision. No published `ChatSnapshot` object is mutated.

## 7. Optimized results

| Scenario | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: |
| Markdown parse, uncached control | ~0.083 ms | ~0.097 ms | ~0.13 ms | ~1.21 ms |
| Markdown parse, cache hit | ~0.0003 ms | ~0.0008 ms | ~0.006 ms | ~0.005–0.01 ms |
| 200 streaming Markdown revisions | ~0.021 ms | ~0.024 ms | ~0.024 ms | ~0.029 ms |
| Code highlight, uncached control | ~2.17 ms | ~2.56 ms | ~2.9 ms | ~2.96 ms |
| Code highlight, cache hit | ~0.054 ms | ~0.062 ms | ~0.080 ms | ~0.47 ms |
| Conversation projection | ~0.024 ms | ~0.046 ms | ~0.048 ms | ~0.063 ms |
| Tool presentation | ~0.005 ms | ~0.009 ms | ~0.012 ms | ~0.017 ms |

The repeated 1,000-line highlight path falls from a 2.914 ms baseline p95 to about 0.062 ms p95, a reduction of approximately **97.9%**. Streaming revisions remain independently invalidated and stay far below a 16–33 ms visual budget in the pure benchmark.

Exact values can vary with machine load; the raw JSON files are authoritative for each retained run.

## 8. Architecture decision gates

### Visual scheduler: closed

No visual scheduler was added.

Evidence:

- the measured projection and parse paths are well below 1 ms;
- the only multi-millisecond repeated operation was removed locally;
- no trace currently proves multi-lane commit collisions or event-loop long tasks;
- a global frame clock would manufacture work and increase architectural scope without measured benefit.

Reopen this gate only if runtime traces show multiple independent updates causing redundant visual commits or input starvation after the local optimization.

### State-store split: closed

`ChatSnapshot` was not split.

Evidence:

- 10,000-message window projection is about 0.046 ms p95;
- the measured repeated work was isolated at the Markdown seam;
- there is no evidence that React reconciliation is the dominant cost;
- preserving one business snapshot avoids cross-store consistency risks for turns, approvals, plans, accounting, persistence, and resume.

Reopen this gate only if runtime profiling shows non-conversation subtrees consuming material time on pure stream updates after selector/memo options are exhausted.

## 9. Verification

Passed:

- performance recorder tests: 5/5;
- new cache and Markdown cache tests;
- focused controller, render-window, and code-highlighter suite;
- TUI TypeScript check;
- TUI release build and binary signing;
- scoped `git diff --check`;
- optimized benchmark replay.

The first full-suite run exposed two stale test contracts while concurrent runtime work was present:

1. `conversation-persistence.test.ts` expected legacy `lifetimeUsage` without the new `byModel` field returned by the runtime data store.
2. `theme-governance.test.ts` treated helper names such as `colorToRgb(` and `mixRgb(` as raw `rgb(` color calls.

The product implementations were not changed. The persistence expectation was updated to verify the complete `byModel` aggregate, and the governance regex was narrowed to standalone `rgb/rgba` calls. Both focused tests then passed (29/29), and the final full TUI suite completed with exit code 0.

## 10. Outcome

The implementation does not chase a nominal 60Hz loop. It adds evidence, removes a measured deterministic recomputation, keeps streaming invalidation correct, and explicitly declines two larger architectural changes whose decision gates were not triggered.

The retained principle is:

> Render only changed work at the appropriate priority; do not create a global clock merely to redraw more often.
