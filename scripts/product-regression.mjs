import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedUiShots = ['diagnostics', 'appearance', 'automation-list', 'automation-receipt', 'automation-editor', 'classic-chat', 'classic-image-lightbox', 'classic-artifacts', 'classic-diff']
  .flatMap(scene => [`ui-${scene}-1280-dark.png`, `ui-${scene}-760-light.png`]);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = fileURLToPath(new URL('..', import.meta.url));
export function sourceFingerprint(root) {
  const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean));
  const digest = createHash('sha256');
  for (const file of [...files].sort()) {
    digest.update(file).update('\0');
    const absolute = path.join(root, file);
    digest.update(existsSync(absolute) ? readFileSync(absolute) : '<deleted>').update('\0');
  }
  return digest.digest('hex');
}

const requiredShots = [...sharedUiShots, 'quick-chat-bots-dark.png', 'quick-chat-bots-light.png', 'evidence-list-dark.png', 'evidence-file-dark.png', 'evidence-history-dark.png', 'evidence-missing-dark.png', 'evidence-missing-760-light.png', 'pending-reply-1600-dark.png', 'pending-reply-docked-light.png', 'pending-reply-760-light.png',
  'history-dark.png', 'history-light.png', 'history-preview.png', 'history-narrow-large.png',
  'choice-send-1280-dark-before.png', 'choice-send-1280-dark-after.png', 'choice-send-760-light-before.png', 'choice-send-760-light-after.png',
  'updater-minimize-1280-dark-before.png', 'updater-minimize-1280-dark-after.png',
  'updater-minimize-760-light-before.png', 'updater-minimize-760-light-after.png', 'bot-footer-progress-dark-narrow.png',
  'task-report-loading.png', 'task-report-unavailable.png', 'task-report-stale.png',
  'conversation-updates-dark.png', 'conversation-updates-light.png', 'conversation-complete.png', 'conversation-complete-light.png', 'conversation-details.png', 'task-main-note.png', 'task-follow-up-draft.png', 'task-decision.png', 'task-main-question.png', 'task-detail-running.png', 'task-detail-waiting_user.png', 'task-detail-accepted.png',
  'task-detail-failed.png', 'task-detail-1280-dark.png', 'task-detail-1280-light.png',
  'task-detail-760-dark.png', 'task-detail-760-light.png', 'work-running.png', 'work-waiting.png', 'work-waiting-760-light.png', 'bot-overview.png', 'bot-memory.png', 'chat-process-summary.png',
  'task-cancel-failed-dark.png', 'task-cancelled-dark.png', 'task-cancel-detail-760-light.png',
  'long-error-760-dark.png', 'long-error-docked-light.png',
  'background-work-1600-dark.png', 'background-work-760-light.png',
  'fallback-vision-1280-dark.png', 'fallback-vision-1280-light.png', 'fallback-vision-760-dark.png', 'fallback-vision-760-light.png',
  'providers-1280-dark.png', 'providers-expanded-1280-dark.png',
  'composer-empty-1280-dark.png', 'composer-empty-1280-light.png', 'composer-empty-760-dark.png',
  'composer-multiline-760-light.png', 'composer-attachment-1280-dark.png',
  'reply-dark.png', 'reply-light.png', 'reply-narrow-quote.png', 'reply-narrow-sent.png',
  ...['purple', 'pink', 'green'].flatMap(color => [`bot-message-${color}-dark.png`, `bot-message-${color}-light.png`]),
  'quote-sent-1280-dark.png', 'quote-sent-1280-light.png',
  'quote-reply-1280-dark.png', 'quote-reply-1280-light.png', 'quote-reply-760-dark.png', 'quote-reply-760-light.png',
  'selection-quote-1280-dark.png', 'selection-quote-760-light.png', 'selection-quote-docked-light.png',
  'completion-review-card.png', 'completion-review-report.png', 'completion-review-760-light.png',
  'process-timing-dark.png', 'process-timing-light.png', 'budget-exhausted-dark.png', 'budget-exhausted-light.png', 'manual-wake-retry-dark.png', 'manual-wake-retry-light.png',
  'work-verifying.png', 'reply-entry-idle-dark.png', 'reply-entry-hover-dark.png', 'reply-entry-idle-light.png', 'reply-entry-hover-light.png'];
export function createReviewPacket({ root, output, artifactRoot, machine }) {
  const requiredStates = ['running', 'waiting_user', 'result_ready', 'accepted', 'failed', 'queued', 'paused', 'cancelled', 'unavailable'];
  const requiredErrorLayouts = [[1280, false], [1280, true], [760, false]].flatMap(([width, docked]) =>
    ['dark', 'light'].map(appearance => ({ width, docked, appearance })));
  if (!machine.sharedUiConventions?.keyboardDisclosure || !machine.sharedUiConventions?.svgSelect
    || !machine.sharedUiConventions?.rectangularPreviews || !machine.sharedUiConventions?.keyboardImagePreview
    || machine.sharedUiConventions?.cases?.length !== sharedUiShots.length
    || !machine.ok || machine.pageErrors?.length || machine.mainAuthorizationErrors?.length
    || !machine.botMessageColors?.identitySwitch || !machine.botMessageColors?.savedColorApplied
    || machine.botMessageColors?.cases?.length !== 32
    || !machine.botMessageColors.cases.every(sample => sample.bodyContrast >= 4.5 && sample.quoteContrast >= 4.5 && sample.fits)
    || !machine.choiceSendMotion?.focusRestored || machine.choiceSendMotion?.cases?.length !== 3
    || !machine.choiceSendMotion.cases.every(sample => sample.continuous && sample.oneReceipt)
    || !machine.updaterMinimize?.errorRecoverable || !machine.updaterMinimize?.fastCompletion
    || machine.updaterMinimize?.cases?.length !== 3 || !machine.updaterMinimize.cases.every(sample => sample.passed)
    || !['grouping', 'search', 'preview', 'keyboard', 'errorRecovery', 'continuation', 'animations', 'reducedMotion'].every(check => machine.historyRegression?.[check] === true)
    || !['anchored', 'scrollTracking', 'offscreenDismissed', 'keyboard', 'mouseClick', 'draftPreserved', 'bodyBoundary', 'widthReflow', 'dockedFits'].every(check => machine.selectionQuote?.[check] === true)
    || ![1280, 760].every(width => ['dark', 'light'].every(appearance => machine.shortReplyQuote?.some(item =>
      item.width === width && item.appearance === appearance && item.inside && item.horizontal && item.compact && item.fits)))
    || !['multilineScroll', 'widthReflow', 'attachmentFits', 'keyboard'].every(check => machine.composerLayout?.[check] === true)
    || ![1280, 760].every(width => ['dark', 'light'].every(appearance => machine.composerLayout?.cases?.some(item =>
      item.width === width && item.appearance === appearance && item.fits && item.grouped && item.centered && item.distinctSurface && item.sendFilled)))
    || !['incrementalParagraphs', 'stableParagraphs', 'narrationOutsideProcess', 'retainedAfterCompletion', 'retainedFromHistory', 'separateToolUpdates', 'noPrivateThinking', 'reducedMotion', 'messageBubbles', 'detailsAtEnd', 'detailsCollapsed', 'detailsKeyboard', 'detailsInDrawer', 'detailsFocusRestored', 'detailsReadingPosition']
      .every(check => machine.conversationFlow?.[check] === true)
    || !['staleActionExplained', 'disappearedCardRetired', 'separateCompletionStage', 'fullReportInDrawer', 'keyboard', 'narrowFits', 'retryAfterSavedReview'].every(check => machine.completionReview?.[check] === true)
    || !['subsecond', 'seconds', 'persisted', 'unknownHidden', 'narrowFits'].every(check => machine.processTiming?.[check] === true)
    || !['reasonVisible', 'diagnosticInDrawer', 'retryVisible', 'narrowFits'].every(check => machine.budgetFailure?.[check] === true)
    || !['progressBeforeCompletion', 'stopVisible', 'completed', 'narrationRetained', 'noPrivateThinking', 'narrowFits'].every(check => machine.manualWakeRetry?.[check] === true)
    || ![1600, 1280, 760].every(width => ['dark', 'light'].every(appearance => (width === 1280 ? [false, true] : [false]).every(docked =>
      machine.pendingReplyLayout?.some(item => item.width === width && item.appearance === appearance && item.docked === docked && item.aligned))))
    || !machine.taskDetails?.reportFromDetail || !machine.taskDetails?.metadataCollapsed
    || !['reportReadFailureExplained', 'reportLoadingVisible', 'staleReportPreserved', 'reportRetryRecovers', 'nestedEscapeRetainsTask'].every(check => machine.taskDetails?.[check] === true)
    || !machine.taskDetails?.primaryActionReturnsToBot || !machine.taskDetails?.listClassification || !machine.modelSwitch?.rollbackVerified
    || !machine.replyDetailsEntry?.keyboard || !machine.replyDetailsEntry?.rightAligned || !machine.replyDetailsEntry?.collapsedHeight
    || !['dark', 'light'].every(theme => machine.replyDetailsEntry?.themes?.some(item => item.theme === theme && item.hiddenUntilHover))
    || !machine.verificationPresentation?.currentPhaseWins || !machine.verificationPresentation?.exitsToFollowUp
    || !['directWaitingAction', 'keyboard', 'detailAction', 'sharedPending', 'failureRetry', 'latestReceipt', 'noDuplicate', 'unrelatedPreserved', 'narrowFits', 'focusReturned'].every(check => machine.taskCancellation?.[check] === true)
    || !['internalInstructionsHidden', 'relatedNoteLocated', 'followUpDraftFocused', 'existingDraftPreserved', 'concreteQuestionLocated', 'noAutomaticExecution']
      .every(check => machine.taskDetails?.[check] === true)
    || !['compactControls','persistedModel','persistedEffort','perBot','failedSaveRetained','keyboardTrigger','aligned','sentSelection'].every(check => machine.quickChatBots?.[check] === true)
    || !machine.replyEvidenceReturn?.sameReply || !machine.replyEvidenceReturn?.focusInDetails
    || !['namedSources','savedFile','exactHistory','missingBodyExplained','unknownRefDistinct','diagnosticsCollapsed','commandReadable','narrowFits'].every(check=>machine.evidenceSources?.[check]===true)
    || !machine.delegatedWorkHandoff?.reply || !machine.delegatedWorkHandoff?.background
    || !machine.delegatedWorkHandoff?.noDirectHandling || !machine.delegatedWorkHandoff?.detailReturnsToBot
    || !['dark', 'light'].every(appearance => machine.delegatedWorkHandoff?.hintChecks?.some(item =>
      item.appearance === appearance && item.contrast >= 4.5 && item.fits && item.hintSize < item.progressSize))
    || !machine.messageLayout?.completeText || !machine.messageLayout?.fitBounds
    || !machine.messageLayout?.diagnosticsCollapsed || !machine.messageLayout?.detailsKeyboard
    || !machine.fallbackVision?.openingAnimated || !machine.fallbackVision?.closingAnimated
    || !machine.fallbackVision?.persisted || !machine.fallbackVision?.serviceManagement || !machine.fallbackVision?.keyboard
    || ![1600, 1280, 760].every(width => ['dark', 'light'].every(appearance => [false, true].every(expanded =>
      machine.backgroundWorkLayout?.some(item => item.width === width && item.appearance === appearance && item.expanded === expanded
        && item.aligned && item.contentFits && item.expandedFits))))
    || ![1280, 760].every(width => ['dark', 'light'].every(appearance => machine.fallbackVision?.cases?.some(item =>
      item.width === width && item.appearance === appearance && item.centered && item.fits && item.helpSize < item.labelSize)))
    || !requiredErrorLayouts.every(expected => machine.messageLayout.cases?.some(item =>
      item.viewportWidth === expected.width && item.docked === expected.docked && item.appearance === expected.appearance
      && item.textFits && item.cardFits && item.conversationFits))
    || !requiredStates.every(status => machine.taskDetails.states?.includes(status))) {
    throw new Error('Machine regression failed or required product scenarios did not run');
  }
  mkdirSync(path.join(output, 'screenshots'), { recursive: true });
  const screenshots = requiredShots.map(id => {
    const bytes = readFileSync(path.join(artifactRoot, id));
    writeFileSync(path.join(output, 'screenshots', id), bytes);
    return { id, path: `screenshots/${id}`, sha256: hash(bytes) };
  });
  const packet = { schemaVersion: 1, runId: randomUUID(), capturedAt: new Date().toISOString(),
    sourceFingerprint: sourceFingerprint(root), sourceHead: machine.sourceHead, platform: machine.platform,
    status: 'awaiting-ai-review', machineScope: machine.scope, screenshots,
    checks: { historyRegression: machine.historyRegression, disclosureFrames: machine.disclosureFrames,
      quickChatBots: machine.quickChatBots, taskDetails: machine.taskDetails, modelSwitch: machine.modelSwitch, messageLayout: machine.messageLayout, workSurfaces: machine.workSurfaces,
      chatDetails: machine.chatDetails, conversationFlow: machine.conversationFlow, composerLayout: machine.composerLayout, botMessageColors: machine.botMessageColors, accessibility: machine.accessibility, fallbackVision: machine.fallbackVision,
      backgroundWorkLayout: machine.backgroundWorkLayout, pendingReplyLayout: machine.pendingReplyLayout, evidenceSources: machine.evidenceSources,
      delegatedWorkHandoff: machine.delegatedWorkHandoff, taskCancellation: machine.taskCancellation, completionReview: machine.completionReview,
      processTiming: machine.processTiming, budgetFailure: machine.budgetFailure, manualWakeRetry: machine.manualWakeRetry, choiceSendMotion: machine.choiceSendMotion, updaterMinimize: machine.updaterMinimize,
      replyDetailsEntry: machine.replyDetailsEntry, verificationPresentation: machine.verificationPresentation,
      selectionQuote: machine.selectionQuote, shortReplyQuote: machine.shortReplyQuote },
    supplementalCoverage: machine.sharedUiConventions,
    reviewCriteria: [
      '默认内容能回答任务目标、当前进展和下一步；动作写明去向，主机器人负责对用户传达。',
      '内部 ID、模型机制和原始参数按需披露；状态来自结构化事实，目标与完成结论不得混淆。',
      '排版有清晰层级；说明小而轻；无裁切、溢出、过宽导航按钮、重复空字段或字符图标。',
      '对照自动交互证据检查键盘、展开收起、状态过渡和失败恢复；单张截图不能证明动画或性能。',
    ], limits: ['Scripted model cognition; no real provider quality or network timing', 'Source Electron; not an installed RC', 'No full screen-reader or long-duration acceptance'] };
  writeFileSync(path.join(output, 'packet.json'), JSON.stringify(packet, null, 2));
  writeFileSync(path.join(output, 'review-template.json'), JSON.stringify({ schemaVersion: 1, runId: packet.runId,
    sourceFingerprint: packet.sourceFingerprint, reviewer: { kind: 'ai', name: '', independent: false },
    screenshots: screenshots.map(({ id, sha256 }) => ({ id, sha256, verdict: 'not_checked', notes: '' })), findings: [] }, null, 2));
  writeFileSync(path.join(output, 'review-instructions.md'), `# AI 产品回归审查\n\n读取 packet.json、machine.json 与所有截图，逐张检查 reviewCriteria。\n\n将实际观察填入 review-template.json 的副本 review.json，每张截图写出具体判断依据。无法判断记 not_checked，不能补填 pass。实现者自审必须保留 independent=false。\n\n发现问题先修复，再从新源码重新 capture；旧截图、旧 runId 或未完成审查均不通过。完成后运行 pnpm qa:product:verify --output <此目录>。\n\n当前范围不包含真实模型、安装包或长期使用验收。\n`);
  return packet;
}

export function verifyReview({ packet, review, root, output }) {
  if (packet.schemaVersion !== 1 || review?.schemaVersion !== 1 || review.runId !== packet.runId
    || review.sourceFingerprint !== packet.sourceFingerprint || sourceFingerprint(root) !== packet.sourceFingerprint) {
    throw new Error('Review is missing, stale or bound to different source');
  }
  if (review.reviewer?.kind !== 'ai' || !review.reviewer.name?.trim() || typeof review.reviewer.independent !== 'boolean') {
    throw new Error('AI reviewer and independence must be stated');
  }
  if (!Array.isArray(review.screenshots) || review.screenshots.length !== packet.screenshots.length
    || new Set(review.screenshots.map(item => item.id)).size !== packet.screenshots.length) throw new Error('Incomplete screenshot review');
  for (const shot of packet.screenshots) {
    const checked = review.screenshots.find(item => item.id === shot.id);
    if (hash(readFileSync(path.join(output, shot.path))) !== shot.sha256 || checked?.sha256 !== shot.sha256
      || checked.verdict !== 'pass' || typeof checked.notes !== 'string' || checked.notes.trim().length < 12) {
      throw new Error(`Screenshot has no accepted, evidenced review: ${shot.id}`);
    }
  }
  if (!Array.isArray(review.findings) || review.findings.some(item =>
    !packet.screenshots.some(shot => shot.id === item.screenshot)
    || typeof item.description !== 'string' || !item.description.trim()
    || !['blocking', 'minor'].includes(item.severity)
    || !['resolved', 'accepted-limitation'].includes(item.disposition)
    || (item.severity === 'blocking' && item.disposition !== 'resolved'))) {
    throw new Error('Open product findings remain');
  }
  return { status: 'passed', runId: packet.runId, sourceFingerprint: packet.sourceFingerprint,
    reviewedAt: new Date().toISOString(), reviewer: review.reviewer, limits: packet.limits };
}

function command(binary, args, logfile) {
  const fd = openSync(logfile, 'w');
  try { execFileSync(binary, args, { cwd: repo, stdio: ['ignore', fd, fd], env: process.env }); }
  finally { closeSync(fd); }
}
function main() {
  const args = process.argv.slice(2).filter(value => value !== '--');
  const index = args.indexOf('--output');
  if (index >= 0 && !args[index + 1]) throw new Error('--output requires a directory');
  const output = path.resolve(index >= 0 ? args[index + 1] : mkdtempSync(path.join(os.tmpdir(), 'peer-product-regression-')));
  if (output === repo || output.startsWith(`${repo}${path.sep}`)) throw new Error('Use an output directory outside the source repository');
  mkdirSync(output, { recursive: true });
  // An earlier passing artifact must not survive a failed or incomplete new run.
  writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'not-accepted', updatedAt: new Date().toISOString() }, null, 2));
  if (args.includes('--verify')) {
    const result = verifyReview({ root: repo, output, packet: JSON.parse(readFileSync(path.join(output, 'packet.json'))),
      review: JSON.parse(readFileSync(path.join(output, 'review.json'))) });
    writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ output, ...result })); return;
  }
  command('pnpm', ['--filter', '@peer-agent/desktop', 'build'], path.join(output, 'build.log'));
  const fingerprint = sourceFingerprint(repo);
  command(process.execPath, ['apps/desktop/scripts/bot-shell-electron-smoke.mjs', '--accessibility', '--diagnostics',
    '--streaming', '--effort-stability', '--work-surfaces', '--output', path.join(output, 'machine.json')], path.join(output, 'capture.log'));
  // The long-history selection fixture has its own Electron data directory;
  // it must not change the baseline stream-following scenario's history.
  command(process.execPath, ['apps/desktop/scripts/bot-shell-electron-smoke.mjs', '--selection-quote-only',
    '--output', path.join(output, 'selection-machine.json')], path.join(output, 'selection-capture.log'));
  command(process.execPath, ['apps/desktop/scripts/bot-shell-electron-smoke.mjs', '--shared-ui-only',
    '--output', path.join(output, 'shared-ui-machine.json')], path.join(output, 'shared-ui-capture.log'));
  if (sourceFingerprint(repo) !== fingerprint) throw new Error('Source changed during capture; rerun on stable source');
  const line = readFileSync(path.join(output, 'capture.log'), 'utf8').trim().split('\n').findLast(value => value.startsWith('{'));
  const { root: artifactRoot } = JSON.parse(line);
  const machine = JSON.parse(readFileSync(path.join(output, 'machine.json')));
  const selectionLine = readFileSync(path.join(output, 'selection-capture.log'), 'utf8').trim().split('\n').findLast(value => value.startsWith('{'));
  const selection = JSON.parse(selectionLine);
  if (!selection.ok || selection.pageErrors?.length || selection.mainAuthorizationErrors?.length) throw new Error('Selection quote interaction failed');
  const sharedLine = readFileSync(path.join(output, 'shared-ui-capture.log'), 'utf8').trim().split('\n').findLast(value => value.startsWith('{'));
  const shared = JSON.parse(sharedLine);
  if (!shared.ok || shared.pageErrors?.length || shared.mainAuthorizationErrors?.length) throw new Error('Shared UI interaction failed');
  machine.sharedUiConventions = shared.sharedUiConventions;
  for (const file of sharedUiShots) copyFileSync(path.join(shared.root, file), path.join(artifactRoot, file));
  machine.selectionQuote = selection.selectionQuote;
  machine.selectionQuoteRun = { startedAt: selection.startedAt, finishedAt: selection.finishedAt, scope: selection.scope };
  for (const file of ['selection-quote-1280-dark.png', 'selection-quote-760-light.png', 'selection-quote-docked-light.png'])
    copyFileSync(path.join(selection.root, file), path.join(artifactRoot, file));
  writeFileSync(path.join(output, 'machine.json'), JSON.stringify(machine, null, 2));
  const packet = createReviewPacket({ root: repo, output, artifactRoot, machine });
  writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: packet.status, runId: packet.runId }, null, 2));
  copyFileSync(path.join(artifactRoot, 'main.log'), path.join(output, 'main.log'));
  console.log(JSON.stringify({ output, status: packet.status, runId: packet.runId, next: 'AI must inspect screenshots and write review.json, then run qa:product:verify' }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
