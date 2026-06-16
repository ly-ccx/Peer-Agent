#!/usr/bin/env node
/**
 * 清理因 reattach bug 在会话 jsonl 中写重的"进行中 assistant 快照"。
 *
 * 背景:重新打开进行中会话时,旧的 reattach 逻辑会在已落盘的进行中 assistant
 * 消息之后再追加一条几乎相同(内容互为前缀)的消息,经 persistMessages 整体回写
 * 后被永久固化,每重开一次叠加一条。
 *
 * 去重规则(保守):在一段【连续的 assistant 消息】中,凡其 content 是同段内另一条
 * content 的前缀的,删除,只保留每条"非任何其他消息前缀"的消息(即最长的快照)。
 * - 不跨越 user/system 消息合并,保留真实多轮结构。
 * - 连续 assistant 之间若无前缀关系(即真正不同的内容),全部保留,绝不误删。
 *
 * 用法:
 *   node scripts/dedup-conversations.mjs            # dry-run,仅报告
 *   node scripts/dedup-conversations.mjs --apply    # 实际写入(先备份 .bak-dedup-<ts>)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const dir = path.join(os.homedir(), '.peer-agent', 'conversations');

function norm(s) {
  return (s ?? '').trim();
}

/** 对一段连续 assistant 消息做前缀去重,返回保留下来的子集。 */
function dedupRun(run) {
  if (run.length <= 1) return run;
  const contents = run.map((m) => norm(m.content));
  const keep = run.filter((_, i) => {
    const ci = contents[i];
    if (ci === '') {
      // 空 assistant 占位:若同段存在任何非空内容,则丢弃这个空占位。
      return !contents.some((c, j) => j !== i && c !== '');
    }
    // 若 ci 是同段另一条的【严格前缀】(对方更长且以 ci 开头),则 ci 是旧快照,删除。
    const isPrefixOfAnother = contents.some(
      (cj, j) => j !== i && cj.length > ci.length && cj.startsWith(ci),
    );
    return !isPrefixOfAnother;
  });
  return keep;
}

function processMessages(msgs) {
  const out = [];
  let i = 0;
  while (i < msgs.length) {
    if (msgs[i].role !== 'assistant') {
      out.push(msgs[i]);
      i += 1;
      continue;
    }
    // 收集一段连续 assistant
    let j = i;
    while (j < msgs.length && msgs[j].role === 'assistant') j += 1;
    const run = msgs.slice(i, j);
    out.push(...dedupRun(run));
    i = j;
  }
  return out;
}

function main() {
  if (!fs.existsSync(dir)) {
    console.error('conversations dir not found:', dir);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  let totalRemoved = 0;
  let affectedFiles = 0;
  const ts = Date.now();

  for (const file of files) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    let msgs;
    try {
      msgs = lines.map((l) => JSON.parse(l));
    } catch (e) {
      console.warn('SKIP (parse error):', file, e.message);
      continue;
    }
    const before = msgs.length;
    const kept = processMessages(msgs);
    const removed = before - kept.length;
    if (removed > 0) {
      affectedFiles += 1;
      totalRemoved += removed;
      console.log(`${file}: ${before} -> ${kept.length}  (removed ${removed})`);
      if (APPLY) {
        fs.copyFileSync(full, `${full}.bak-dedup-${ts}`);
        const next = kept.map((m) => JSON.stringify(m)).join('\n') + '\n';
        fs.writeFileSync(full, next, 'utf8');
      }
    }
  }

  console.log('---');
  console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: files affected=${affectedFiles}, records removed=${totalRemoved}`);
  if (!APPLY && affectedFiles > 0) {
    console.log('Re-run with --apply to write changes (originals backed up as .bak-dedup-<ts>).');
  }
}

main();
