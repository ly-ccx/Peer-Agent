import type { CapabilityManifest, LocaleCode, LocalizedText } from '@peer-agent/protocol';
import {remoteAccessZh,remoteAccessEn,type RemoteAccessTranslationKey} from './remote-access.ts';

export type { LocaleCode };

export const DEFAULT_LOCALE: LocaleCode = 'zh-CN';

export const AVAILABLE_LOCALES = ['zh-CN', 'en-US'] as const satisfies readonly LocaleCode[];

export type TranslationKey =
  | RemoteAccessTranslationKey
  | 'app.newTask'
  | 'searchChats.open'
  | 'searchChats.placeholder'
  | 'searchChats.section.chats'
  | 'searchChats.section.suggested'
  | 'searchChats.workspace.current'
  | 'searchChats.workspace.unassigned'
  | 'searchChats.empty'
  | 'searchChats.untitled'
  | 'searchChats.newTask'
  | 'searchChats.shortcut'
  | 'app.search'
  | 'app.plugins'
  | 'app.agents'
  | 'app.automations'
  | 'app.pinned'
  | 'app.projects'
  | 'app.settings'
  | 'app.run'
  | 'app.open'
  | 'app.workspaceFallback'
  | 'account.personal'
  | 'account.usageRemaining'
  | 'developer.title'
  | 'developer.subtitle'
  | 'developer.currentMode'
  | 'developer.enable'
  | 'developer.cloudMode'
  | 'developer.gatewayUrl'
  | 'developer.streamUrl'
  | 'developer.runtimeGatewayUrl'
  | 'developer.auth'
  | 'developer.bucEnv'
  | 'developer.lastRequest'
  | 'developer.probe'
  | 'developer.apply'
  | 'developer.reset'
  | 'developer.saving'
  | 'developer.probing'
  | 'developer.loadFailed'
  | 'developer.saveFailed'
  | 'developer.probeFailed'
  | 'developer.ipcUnavailable'
  | "projectAgent.chat.taskFallback"
  | "projectAgent.chat.inputTooLong"
  | "projectAgent.quick.title"
  | "projectAgent.quick.content"
  | "projectAgent.quick.placeholder"
  | "projectAgent.quick.chooseBot"
  | "projectAgent.quick.noBots"
  | "projectAgent.quick.textOnly"
  | "projectAgent.quick.empty"
  | "projectAgent.quick.workspace"
  | "projectAgent.quick.attach"
  | "projectAgent.quick.attachmentLimit"
  | "projectAgent.quick.imageLimit"
  | "projectAgent.quick.fileLimit"
  | "projectAgent.quick.sending"
  | "projectAgent.quick.failed"
  | "projectAgent.background.title"
  | "projectAgent.background.device"
  | "projectAgent.background.close"
  | "projectAgent.background.readFailed"
  | "projectAgent.background.previous"
  | "projectAgent.background.retry"
  | "projectAgent.background.loading"
  | "projectAgent.background.unavailable"
  | "projectAgent.background.empty"
  | "projectAgent.background.history"
  | "projectAgent.background.more"
  | "projectAgent.background.refresh"
  | "projectAgent.settings.quietStart"
  | "projectAgent.settings.quietEnd"
  | "projectAgent.settings.hour"
  | "projectAgent.settings.minute"
  | 'projectAgent.host.title'
  | 'projectAgent.host.hint'
  | 'projectAgent.host.action'
  | 'projectAgent.host.requested'
  | 'projectAgent.host.ready'
  | 'projectAgent.host.failed'
  | 'developer.projectAgent.nav'
  | 'developer.projectAgent.title'
  | 'developer.projectAgent.description'
  | 'developer.projectAgent.switch'
  | 'developer.projectAgent.diagnostics'
  | 'developer.projectAgent.inactive'
  | 'developer.diagnostics.description'
  | 'developer.diagnostics.refresh'
  | 'developer.diagnostics.export'
  | 'developer.diagnostics.busy'
  | 'developer.diagnostics.saved'
  | 'developer.diagnostics.cancelled'
  | 'developer.diagnostics.failed'
  | 'developer.diagnostics.unknown'
  | 'developer.diagnostics.generated'
  | 'developer.diagnostics.bots'
  | 'developer.diagnostics.slots'
  | 'developer.diagnostics.waiting'
  | 'developer.diagnostics.errors'
  | 'developer.diagnostics.preview'
  | 'projectAgent.list.brand'
  | 'projectAgent.list.newBot'
  | 'projectAgent.list.searchPlaceholder'
  | 'projectAgent.list.needsYou'
  | 'projectAgent.list.empty'
  | 'projectAgent.list.emptyHint'
  | 'projectAgent.list.emptyNeedsYou'
  | 'projectAgent.list.emptySearch'
  | 'projectAgent.list.me'
  | 'projectAgent.list.settings'
  | 'projectAgent.list.automations'
  | 'projectAgent.list.capabilities'
  | 'projectAgent.list.capabilitiesHint'
  | 'projectAgent.list.history'
  | 'projectAgent.shell.classicNotice'
  | 'projectAgent.shell.banner'
  | 'projectAgent.shell.bannerTitle'
  | 'projectAgent.shell.bannerWhere'
  | 'projectAgent.shell.bannerPath'
  | 'projectAgent.shell.bannerSwitch'
  | 'projectAgent.shell.bannerDismiss'
  | 'projectAgent.onboarding.connectTitle'
  | 'projectAgent.onboarding.connectBody'
  | 'projectAgent.onboarding.connectAction'
  | 'projectAgent.onboarding.createTitle'
  | 'projectAgent.onboarding.createBody'
  | 'projectAgent.onboarding.createAction'
  | 'projectAgent.search.placeholder'
  | 'projectAgent.search.empty'
  | 'projectAgent.search.section.bots'
  | 'projectAgent.search.section.messages'
  | 'projectAgent.search.section.tasks'
  | 'projectAgent.search.section.memory'
  | 'projectAgent.list.loading'
  | 'projectAgent.list.unavailable'
  | 'projectAgent.list.loadFailed'
  | 'projectAgent.list.noPreview'
  | 'projectAgent.list.mainEmptyTitle'
  | 'projectAgent.list.mainEmptyBody'
  | 'projectAgent.list.recentBots'
  | 'projectAgent.list.openBot'
  | 'projectAgent.list.mainPlaceholder'
  | 'projectAgent.list.profile'
  | 'projectAgent.list.unread'
  | 'projectAgent.list.running'
  | 'projectAgent.list.needsYouBadge'
  | 'projectAgent.list.newSheetTitle'
  | 'projectAgent.list.bindFolder'
  | 'projectAgent.list.bindFolderHint'
  | 'projectAgent.list.blankBot'
  | 'projectAgent.list.blankBotHint'
  | 'projectAgent.list.namePlaceholder'
  | 'projectAgent.list.nameInvalid'
  | 'projectAgent.list.nameWillUse'
  | 'projectAgent.list.create'
  | 'projectAgent.list.creating'
  | 'projectAgent.list.createFailed'
  | 'projectAgent.list.nameExhausted'
  | 'projectAgent.list.columnResize'
  | 'projectAgent.list.backToBots'
  | 'projectAgent.list.close'
  | 'projectAgent.chat.empty'
  | 'projectAgent.chat.loadFailed'
  | 'projectAgent.chat.thinking'
  | 'projectAgent.chat.waiting'
  | 'projectAgent.chat.generating'
  | 'projectAgent.chat.toolLabel.read'
  | 'projectAgent.chat.toolLabel.search'
  | 'projectAgent.chat.toolLabel.edit'
  | 'projectAgent.chat.toolLabel.command'
  | 'projectAgent.chat.toolRunning'
  | 'projectAgent.chat.toolDone'
  | 'projectAgent.chat.toolFailed'
  | 'projectAgent.chat.stop'
  | 'projectAgent.chat.stopHint'
  | 'projectAgent.chat.stopping'
  | 'projectAgent.chat.stopped'
  | 'projectAgent.chat.stopFailed'
  | 'projectAgent.chat.latest'
  | 'projectAgent.chat.received'
  | 'projectAgent.chat.loadOlder'
  | 'projectAgent.chat.loadingOlder'
  | 'projectAgent.chat.olderFailed'
  | 'projectAgent.chat.sending'
  | 'projectAgent.chat.failed'
  | 'projectAgent.chat.retry'
  | 'projectAgent.chat.replied'
  | 'projectAgent.chat.disposition.answered'
  | 'projectAgent.chat.disposition.merged'
  | 'projectAgent.chat.disposition.stopped'
  | 'projectAgent.chat.disposition.superseded'
  | 'projectAgent.chat.disposition.parallel'
  | 'projectAgent.chat.disposition.queued'
  | 'projectAgent.chat.disposition.outOfScope'
  | 'projectAgent.chat.quote'
  | 'projectAgent.chat.quoteRemove'
  | 'projectAgent.chat.placeholder'
  | 'projectAgent.chat.attach'
  | 'projectAgent.chat.previewAttachment'
  | 'projectAgent.chat.removeAttachment'
  | 'projectAgent.chat.attachmentMetadataOnly'
  | 'projectAgent.chat.readingAttachments'
  | 'projectAgent.chat.dropAttachments'
  | 'projectAgent.chat.send'
  | 'projectAgent.chat.hint'
  | 'projectAgent.chat.source'
  | 'projectAgent.chat.evidenceMore'
  | 'projectAgent.chat.evidenceCollapse'
  | 'projectAgent.chat.evidence'
  | 'projectAgent.chat.process'
  | 'projectAgent.chat.chooseAnswer'
  | 'projectAgent.chat.you'
  | 'projectAgent.process.reply'
  | 'projectAgent.process.sessions'
  | 'projectAgent.process.session'
  | 'projectAgent.process.start'
  | 'projectAgent.process.resume'
  | 'projectAgent.process.cancel'
  | 'projectAgent.process.update'
  | 'projectAgent.process.verification'
  | 'projectAgent.process.memory'
  | 'projectAgent.process.objective'
  | 'projectAgent.process.tool'
  | 'projectAgent.process.runningTitle'
  | 'projectAgent.process.preparingTitle'
  | 'projectAgent.process.organizing'
  | 'projectAgent.process.preparingReply'
  | 'projectAgent.process.preparing'
  | 'projectAgent.process.running'
  | 'projectAgent.process.stopped'
  | 'projectAgent.process.awaitingContent'
  | 'projectAgent.process.receiving'
  | 'projectAgent.process.preparingNote'
  | 'projectAgent.process.runningNote'
  | 'projectAgent.process.parameters'
  | 'projectAgent.process.output'
  | 'projectAgent.process.truncated'
  | 'projectAgent.process.redacted'
  | 'projectAgent.process.previewLimit'
  | 'projectAgent.process.seconds'
  | 'projectAgent.process.minutes'
  | 'projectAgent.process.done'
  | 'projectAgent.process.failed'
  | 'projectAgent.process.suppressed'
  | 'projectAgent.process.unknown'
  | 'projectAgent.process.sent'
  | 'projectAgent.process.count'
  | 'projectAgent.process.technical'
  | 'projectAgent.process.input'
  | 'projectAgent.process.result'
  | 'projectAgent.process.empty'
  | 'projectAgent.chat.openProcess'
  | 'projectAgent.chat.memoryUsed'
  | 'projectAgent.chat.memoryLearned'
  | 'projectAgent.chat.digest'
  | 'projectAgent.chat.today'
  | 'projectAgent.chat.earlierDay'
  | 'projectAgent.chat.replyTo'
  | 'projectAgent.chat.sessionState.paused'
  | 'projectAgent.chat.sessionState.queued'
  | 'projectAgent.chat.sessionState.starting'
  | 'projectAgent.chat.work.heading'
  | 'projectAgent.chat.work.more'
  | 'projectAgent.chat.work.related'
  | 'projectAgent.chat.work.unavailable'
  | 'projectAgent.chat.work.unavailableHint'
  | 'projectAgent.chat.work.handle'
  | 'projectAgent.chat.work.open'
  | 'projectAgent.chat.work.background'
  | 'projectAgent.chat.context.basis'
  | 'projectAgent.chat.originalMessage'
  | 'projectAgent.chat.context.details'
  | 'projectAgent.chat.context.memoryUnavailable'
  | 'projectAgent.drawer.inspectBack'
  | 'projectAgent.drawer.evidenceUnavailable'
  | 'projectAgent.drawer.botDescription'
  | 'projectAgent.drawer.acceptance.confirm'
  | 'projectAgent.drawer.memory.details'
  | 'projectAgent.chat.sessionState.running'
  | 'projectAgent.chat.sessionState.waiting_user'
  | 'projectAgent.chat.sessionState.verifying'
  | 'projectAgent.chat.sessionState.result_ready'
  | 'projectAgent.chat.sessionState.accepted'
  | 'projectAgent.chat.sessionState.failed'
  | 'projectAgent.chat.sessionState.cancelled'
  | 'projectAgent.chat.sessionState.superseded'
  | 'projectAgent.chat.verdict.passed'
  | 'projectAgent.chat.verdict.failed'
  | 'projectAgent.chat.verdict.partial'
  | 'projectAgent.chat.verdict.unverifiable'
  | 'projectAgent.chat.surfacingLabel'
  | 'projectAgent.chat.surfacing.interrupt'
  | 'projectAgent.chat.surfacing.message'
  | 'projectAgent.chat.surfacing.digest'
  | 'projectAgent.chat.surfacing.silent'
  | 'projectAgent.chat.approve'
  | 'projectAgent.chat.allowOnce'
  | 'projectAgent.chat.allowTask'
  | 'projectAgent.chat.approveContinue'
  | 'projectAgent.chat.reject'
  | 'projectAgent.chat.answer'
  | 'projectAgent.policy.planApproval'
  | 'projectAgent.policy.planApproval.never'
  | 'projectAgent.policy.planApproval.writes'
  | 'projectAgent.policy.planApproval.always'
  | 'projectAgent.policy.acceptance.auto'
  | 'projectAgent.policy.acceptance.confirm'
  | 'projectAgent.policy.models'
  | 'projectAgent.model.defaults'
  | 'projectAgent.model.botOnly'
  | 'projectAgent.model.nextReply'
  | 'projectAgent.model.runningReply'
  | 'projectAgent.model.unavailable'
  | 'projectAgent.model.select'
  | 'projectAgent.model.noEffort'
  | 'projectAgent.model.saveFailed'
  | 'projectAgent.policy.modelsHint'
  | 'projectAgent.policy.inherit'
  | 'projectAgent.policy.autoPool'
  | 'projectAgent.policy.moreRoles'
  | 'projectAgent.policy.fewerRoles'
  | 'projectAgent.policy.scope'
  | 'projectAgent.policy.scope.all'
  | 'projectAgent.policy.scope.restricted'
  | 'projectAgent.policy.localOnly'
  | 'projectAgent.chat.confirmResult'
  | 'projectAgent.chat.acceptReadme'
  | 'projectAgent.chat.actionFailed'
  | 'projectAgent.drawer.title'
  | 'projectAgent.drawer.close'
  | 'projectAgent.drawer.back'
  | 'projectAgent.drawer.missing'
  | 'projectAgent.drawer.tab.overview'
  | 'projectAgent.drawer.tab.tasks'
  | 'projectAgent.drawer.tab.objectives'
  | 'projectAgent.drawer.tab.memory'
  | 'projectAgent.drawer.tab.settings'
  | 'projectAgent.drawer.folder'
  | 'projectAgent.drawer.noPath'
  | 'projectAgent.drawer.reveal'
  | 'projectAgent.drawer.brief'
  | 'projectAgent.drawer.briefEmpty'
  | 'projectAgent.drawer.running'
  | 'projectAgent.drawer.runningEmpty'
  | 'projectAgent.drawer.acceptance'
  | 'projectAgent.drawer.acceptance.auto'
  | 'projectAgent.drawer.acceptance.pending'
  | 'projectAgent.drawer.model'
  | 'projectAgent.drawer.modelEmpty'
  | 'projectAgent.drawer.model.pending'
  | 'projectAgent.drawer.tasksEmpty'
  | 'projectAgent.drawer.showAll'
  | 'projectAgent.drawer.collapse'
  | 'projectAgent.drawer.group.needsYou'
  | 'projectAgent.drawer.group.running'
  | 'projectAgent.drawer.group.queued'
  | 'projectAgent.drawer.group.done'
  | 'projectAgent.drawer.group.paused'
  | 'projectAgent.drawer.supersededBy'
  | 'projectAgent.drawer.resume'
  | 'projectAgent.drawer.resumeFailed'
  | 'projectAgent.drawer.replacement'
  | 'projectAgent.drawer.group.history'
  | 'projectAgent.drawer.group.classic'
  | 'projectAgent.drawer.historyEmpty'
  | 'projectAgent.drawer.continueHistory'
  | 'projectAgent.drawer.historyPartial'
  | 'projectAgent.drawer.historyPartialConfirm'
  | 'projectAgent.drawer.historyPickBot'
  | 'projectAgent.drawer.classicOpen'
  | 'projectAgent.drawer.legacyAutomations'
  | 'projectAgent.drawer.legacyAutomationsEmpty'
  | 'projectAgent.drawer.anchor'
  | 'projectAgent.drawer.taskDetail.back'
  | 'projectAgent.drawer.taskDetail.untitled'
  | 'projectAgent.drawer.taskDetail.created'
  | 'projectAgent.drawer.taskDetail.createdAt'
  | 'projectAgent.drawer.taskDetail.open'
  | 'projectAgent.drawer.taskDetail.review'
  | 'projectAgent.drawer.taskDetail.noScene'
  | 'projectAgent.drawer.taskDetail.report'
  | 'projectAgent.drawer.taskDetail.noReport'
  | 'projectAgent.drawer.taskDetail.evidenceCount'
  | 'projectAgent.drawer.taskDetail.info'
  | 'projectAgent.drawer.taskDetail.model'
  | 'projectAgent.drawer.taskDetail.id'
  | 'projectAgent.drawer.taskDetail.sourceId'
  | 'projectAgent.drawer.taskDetail.evidenceRefs'
  | 'projectAgent.drawer.taskDetail.evidenceHint'
  | 'projectAgent.drawer.taskDetail.status.starting'
  | 'projectAgent.drawer.taskDetail.status.queued'
  | 'projectAgent.drawer.taskDetail.status.paused'
  | 'projectAgent.drawer.taskDetail.hint.starting'
  | 'projectAgent.drawer.taskDetail.hint.running'
  | 'projectAgent.drawer.taskDetail.hint.waiting_user'
  | 'projectAgent.drawer.taskDetail.hint.verifying'
  | 'projectAgent.drawer.taskDetail.hint.queued'
  | 'projectAgent.drawer.taskDetail.hint.paused'
  | 'projectAgent.drawer.taskDetail.hint.result_ready'
  | 'projectAgent.drawer.taskDetail.hint.accepted'
  | 'projectAgent.drawer.taskDetail.hint.failed'
  | 'projectAgent.drawer.taskDetail.hint.cancelled'
  | 'projectAgent.drawer.taskDetail.hint.superseded'
  | 'projectAgent.drawer.taskDetail.hint.unavailable'
  | 'projectAgent.drawer.frozenModel'
  | 'projectAgent.drawer.conclusion'
  | 'projectAgent.drawer.evidence'
  | 'projectAgent.drawer.progress'
  | 'projectAgent.drawer.openScene'
  | 'projectAgent.drawer.scene'
  | 'projectAgent.drawer.sceneMissing'
  | 'projectAgent.drawer.objective.source'
  | 'projectAgent.drawer.objective.empty'
  | 'projectAgent.drawer.objective.hint'
  | 'projectAgent.drawer.objective.active'
  | 'projectAgent.drawer.objective.paused'
  | 'projectAgent.drawer.objective.achieved'
  | 'projectAgent.drawer.objective.abandoned'
  | 'projectAgent.drawer.objective.pending'
  | 'projectAgent.drawer.objective.report_only'
  | 'projectAgent.drawer.objective.propose'
  | 'projectAgent.drawer.objective.act'
  | 'projectAgent.drawer.objective.autonomy'
  | 'projectAgent.drawer.objective.budget'
  | 'projectAgent.drawer.objective.probes'
  | 'projectAgent.drawer.objective.autoAccept'
  | 'projectAgent.drawer.objective.autoUsage'
  | 'projectAgent.drawer.objective.usage'
  | 'projectAgent.drawer.objective.watch.unavailable'
  | 'projectAgent.drawer.objective.watch.auth'
  | 'projectAgent.drawer.objective.watch.cli'
  | 'projectAgent.drawer.objective.watch.daily'
  | 'projectAgent.drawer.objective.watch.hourly'
  | 'projectAgent.drawer.objective.watch.scope'
  | 'projectAgent.drawer.objective.watch.range'
  | 'projectAgent.drawer.objective.watch.model'
  | 'projectAgent.drawer.objective.watch.cancelled'
  | 'projectAgent.drawer.objective.last'
  | 'projectAgent.drawer.objective.next'
  | 'projectAgent.drawer.objective.unchecked'
  | 'projectAgent.drawer.objective.event'
  | 'projectAgent.drawer.objective.edit'
  | 'projectAgent.drawer.objective.save'
  | 'projectAgent.drawer.objective.cancel'
  | 'projectAgent.drawer.objective.pause'
  | 'projectAgent.drawer.objective.resume'
  | 'projectAgent.drawer.objective.reopen'
  | 'projectAgent.drawer.objective.abandon'
  | 'projectAgent.drawer.objective.failed'
  | 'projectAgent.drawer.objective.loading'
  | 'projectAgent.drawer.objective.title'
  | 'projectAgent.drawer.objective.outcome'
  | 'projectAgent.drawer.objective.tasks'
  | 'projectAgent.drawer.objective.noTasks'
  | 'projectAgent.drawer.objectives.body'
  | 'projectAgent.drawer.objectives.hint'
  | 'projectAgent.drawer.memory.empty'
  | 'projectAgent.drawer.memory.emptyHint'
  | 'projectAgent.drawer.memory.filterEmpty'
  | 'projectAgent.drawer.memory.controls'
  | 'projectAgent.drawer.memory.saved'
  | 'projectAgent.drawer.memory.page'
  | 'projectAgent.drawer.memory.previous'
  | 'projectAgent.drawer.memory.next'
  | 'projectAgent.drawer.memory.scope.project'
  | 'projectAgent.drawer.memory.scope.global'
  | 'projectAgent.drawer.memory.readonly'
  | 'projectAgent.drawer.memory.filter.kind'
  | 'projectAgent.drawer.memory.filter.trust'
  | 'projectAgent.drawer.memory.filter.status'
  | 'projectAgent.drawer.memory.filter.all'
  | 'projectAgent.drawer.memory.kind.fact'
  | 'projectAgent.drawer.memory.kind.preference'
  | 'projectAgent.drawer.memory.kind.decision'
  | 'projectAgent.drawer.memory.kind.procedure'
  | 'projectAgent.drawer.memory.kind.responsibility'
  | 'projectAgent.drawer.memory.trust.stated'
  | 'projectAgent.drawer.memory.trust.verified'
  | 'projectAgent.drawer.memory.status.active'
  | 'projectAgent.drawer.memory.status.forgotten'
  | 'projectAgent.drawer.memory.status.expired'
  | 'projectAgent.drawer.memory.sources'
  | 'projectAgent.drawer.memory.status.conflicted'
  | 'projectAgent.drawer.memory.needsReverify'
  | 'projectAgent.drawer.memory.keepThis'
  | 'projectAgent.drawer.memory.pin'
  | 'projectAgent.drawer.memory.unpin'
  | 'projectAgent.drawer.memory.revoke'
  | 'projectAgent.drawer.memory.restore'
  | 'projectAgent.drawer.memory.edit'
  | 'projectAgent.drawer.memory.save'
  | 'projectAgent.drawer.memory.exportJson'
  | 'projectAgent.drawer.memory.exportMarkdown'
  | 'projectAgent.drawer.memory.projectSwitch'
  | 'projectAgent.drawer.memory.useMemory'
  | 'projectAgent.drawer.memory.learnPreferences'
  | 'projectAgent.drawer.memory.learnLater'
  | 'projectAgent.drawer.settings.name'
  | 'projectAgent.drawer.settings.appearance'
  | 'projectAgent.drawer.settings.workflow'
  | 'projectAgent.drawer.settings.runtime'
  | 'projectAgent.drawer.settings.globalScope'
  | 'projectAgent.drawer.settings.advancedModels'
  | 'projectAgent.drawer.settings.save'
  | 'projectAgent.drawer.settings.avatar'
  | 'projectAgent.drawer.settings.avatarNew'
  | 'projectAgent.drawer.settings.avatarUpload'
  | 'projectAgent.drawer.settings.avatarColor'
  | 'projectAgent.drawer.settings.avatarColorImageHint'
  | 'projectAgent.drawer.settings.avatarColor.0'
  | 'projectAgent.drawer.settings.avatarColor.1'
  | 'projectAgent.drawer.settings.avatarColor.2'
  | 'projectAgent.drawer.settings.avatarColor.3'
  | 'projectAgent.drawer.settings.avatarColor.4'
  | 'projectAgent.drawer.settings.avatarColor.5'
  | 'projectAgent.drawer.settings.avatarColor.6'
  | 'projectAgent.drawer.settings.avatarColor.7'
  | 'projectAgent.drawer.settings.delete'
  | 'projectAgent.drawer.settings.deleteManaged'
  | 'projectAgent.drawer.settings.deleteConfirm'
  | 'projectAgent.drawer.settings.concurrency'
  | 'projectAgent.drawer.settings.concurrencyHint'
  | 'projectAgent.drawer.queuedBehind'
  | 'projectAgent.drawer.dependencyFailed'
  | 'projectAgent.drawer.dependencyMissing'
  | 'projectAgent.drawer.diskSpace'
  | 'projectAgent.drawer.isolationFailed'
  | 'projectAgent.drawer.settings.autoHandoff'
  | 'projectAgent.drawer.settings.autoHandoffHint'
  | 'projectAgent.drawer.settings.proactivity'
  | 'projectAgent.drawer.settings.proactivity.inherit'
  | 'projectAgent.drawer.settings.proactivity.quiet'
  | 'projectAgent.drawer.settings.proactivity.low'
  | 'projectAgent.drawer.settings.proactivity.standard'
  | 'projectAgent.drawer.settings.proactivity.high'
  | 'projectAgent.drawer.settings.proactivity.muted'
  | 'appearance.title'
  | 'appearance.subtitle'
  | 'appearance.mode'
  | 'appearance.mode.light'
  | 'appearance.mode.dark'
  | 'appearance.mode.system'
  | 'appearance.palette'
  | 'appearance.quick'
  | 'appearance.quick.black'
  | 'appearance.quick.white'
  | 'appearance.swatches'
  | 'appearance.codePreview'
  | 'appearance.editTheme'
  | 'appearance.scheme.light'
  | 'appearance.scheme.dark'
  | 'appearance.import'
  | 'appearance.copy'
  | 'appearance.copied'
  | 'appearance.copyFallback'
  | 'appearance.importPrompt'
  | 'appearance.importFailed'
  | 'appearance.preset'
  | 'appearance.custom'
  | 'appearance.accent'
  | 'appearance.background'
  | 'appearance.foreground'
  | 'appearance.uiFont'
  | 'appearance.codeFont'
  | 'appearance.diffMarker'
  | 'appearance.diffMarker.color'
  | 'appearance.diffMarker.sign'
  | 'appearance.translucentSidebar'
  | 'appearance.contrast'
  | 'appearance.fontScale'
  | 'appearance.fontScale.small'
  | 'appearance.fontScale.medium'
  | 'appearance.fontScale.large'
  | 'appearance.preview'
  | 'appearance.diffPreview'
  | 'appearance.deriveCustom'
  | 'appearance.settingsList'
  | 'appearance.reset'
  | 'appearance.language'
  | 'settings.search'
  | 'settings.searchEmpty'
  | 'settings.general'
  | 'settings.shell.title'
  | 'settings.shell.description'
  | 'settings.shell.bots'
  | 'settings.shell.classic'
  | 'settings.archived'
  | 'settings.archived.description'
  | 'settings.archived.loading'
  | 'settings.archived.empty'
  | 'settings.archived.emptyDescription'
  | 'settings.archived.loadFailed'
  | 'settings.archived.actionFailed'
  | 'settings.archived.messageCount'
  | 'settings.archived.date'
  | 'settings.archived.restore'
  | 'settings.archived.delete'
  | 'settings.archived.deleteTitle'
  | 'settings.archived.confirmDelete'
  | 'settings.archived.working'
  | 'settings.backToChat'
  | 'settings.appearance.description'
  | 'settings.language.description'
  | 'settings.general.description'
  | 'settings.general.loadFailed'
  | 'settings.general.interfaceAndLanguage'
  | 'settings.general.interfaceAndLanguage.description'
  | 'settings.replyLanguage'
  | 'settings.bots.title'
  | 'settings.bots.description'
  | 'settings.bots.proactivity'
  | 'settings.bots.proactivity.description'
  | 'settings.bots.proactivity.quiet'
  | 'settings.bots.proactivity.low'
  | 'settings.bots.proactivity.standard'
  | 'settings.bots.proactivity.high'
  | 'settings.bots.quietHours'
  | 'settings.bots.quietHours.description'
  | 'settings.bots.quietFrom'
  | 'settings.bots.quietUntil'
  | 'settings.bots.digestTime'
  | 'settings.bots.digestTime.description'
  | 'settings.replyLanguage.description'
  | 'settings.replyLanguage.followInterface'
  | 'settings.replyLanguage.auto'
  | 'settings.replyLanguage.autoShort'
  | 'settings.git'
  | 'settings.git.branchNaming'
  | 'settings.git.branchPrefix'
  | 'settings.git.branchPrefix.description'
  | 'settings.fallbackVision'
  | 'settings.fallbackVision.description'
  | 'settings.fallbackVision.none'
  | 'settings.fallbackVision.strippedHint'
  | 'settings.config'
  | 'settings.config.description'
  | 'settings.config.export'
  | 'settings.config.import'
  | 'settings.config.exported'
  | 'settings.config.imported'
  | 'settings.config.canceled'
  | 'settings.config.failed'
  | 'settings.usage'
  | 'settings.usage.description'
  | 'settings.usage.loading'
  | 'settings.usage.refresh'
  | 'settings.usage.loadFailed'
  | 'settings.usage.totalTokens'
  | 'settings.usage.estimatedCost'
  | 'settings.usage.conversations'
  | 'settings.usage.inputTokens'
  | 'settings.usage.outputTokens'
  | 'settings.usage.cacheTokens'
  | 'settings.usage.cacheSplit'
  | 'settings.usage.note'
  | 'settings.usage.unpricedNote'
  | 'settings.usage.byProvider'
  | 'settings.usage.byModel'
  | 'settings.usage.byRole'
  | 'settings.usage.showByRole'
  | 'settings.usage.col.role'
  | 'modelRouting.nav'
  | 'modelRouting.title'
  | 'modelRouting.description'
  | 'modelRouting.singleModel'
  | 'modelRouting.noModel'
  | 'modelRouting.tiers'
  | 'modelRouting.roles'
  | 'modelRouting.primary'
  | 'modelRouting.fallbacks'
  | 'modelRouting.addFallback'
  | 'modelRouting.moveUp'
  | 'modelRouting.moveDown'
  | 'modelRouting.remove'
  | 'modelRouting.mode.tier'
  | 'modelRouting.mode.fixed'
  | 'modelRouting.mode.auto'
  | 'modelRouting.pool'
  | 'modelRouting.poolInvalid'
  | 'modelRouting.resolved'
  | 'modelRouting.unresolved'
  | 'modelRouting.preferDifferentFamily'
  | 'modelRouting.spendCap'
  | 'modelRouting.spendExceeded'
  | 'modelRouting.essentialSpend'
  | 'modelRouting.tier.strong'
  | 'modelRouting.tier.fast'
  | 'modelRouting.tier.economy'
  | 'modelRouting.tier.vision'
  | 'modelRouting.role.project_agent'
  | 'modelRouting.role.session_worker'
  | 'modelRouting.role.explorer'
  | 'modelRouting.role.verifier'
  | 'modelRouting.role.visual_verifier'
  | 'modelRouting.role.memory_curator'
  | 'modelRouting.role.objective_probe'
  | 'modelRouting.role.compactor'
  | 'modelRouting.reason.vision'
  | 'modelRouting.reason.tools'
  | 'modelRouting.reason.structured'
  | 'modelRouting.reason.context'
  | 'modelRouting.loadFailed'
  | 'modelRouting.saveFailed'
  | 'settings.usage.emptyGroup'
  | 'settings.usage.col.provider'
  | 'settings.usage.col.model'
  | 'settings.usage.col.conversations'
  | 'settings.usage.col.input'
  | 'settings.usage.col.output'
  | 'settings.usage.col.cacheRead'
  | 'settings.usage.col.cacheWrite'
  | 'settings.usage.col.total'
  | 'settings.usage.col.cost'
  | 'settings.usage.range'
  | 'settings.usage.range.7d'
  | 'settings.usage.range.1m'
  | 'settings.usage.range.3m'
  | 'settings.usage.range.6m'
  | 'settings.usage.range.1y'
  | 'settings.usage.heatmap'
  | 'settings.usage.heatmap.note'
  | 'settings.usage.heatmap.empty'
  | 'settings.usage.heatmap.less'
  | 'settings.usage.heatmap.more'
  | 'settings.usage.trend'
  | 'settings.usage.daily.totalTokens'
  | 'settings.usage.daily.requests'
  | 'settings.usage.daily.activeDays'
  | 'settings.usage.dayDetail'
  | 'settings.usage.dayDetail.close'
  | 'settings.usage.dayDetail.hint'
  | 'settings.usage.dayDetail.models'
  | 'settings.usage.dayDetail.hours'
  | 'settings.usage.dayDetail.hour'
  | 'settings.usage.dayDetail.empty'
  | 'settings.usage.col.requests'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.not_configured'
  | 'auth.signed_out'
  | 'auth.signing_in'
  | 'auth.authenticated'
  | 'auth.error'
  | 'auth.loginFailed'
  | 'auth.cancelLogin'
  | 'auth.permissionHint'
  | 'header.subtitle'
  | 'status.connecting'
  | 'session.cloud_only'
  | 'session.local_ready'
  | 'session.hybrid_ready'
  | 'session.permission_required'
  | 'session.degraded'
  | 'session.offline'
  | 'status.cloud.not_configured'
  | 'status.cloud.configured'
  | 'status.cloud.connected'
  | 'status.cloud.degraded'
  | 'status.localCapabilityRegistered'
  | 'status.accessMode'
  | 'status.git.clean'
  | 'status.git.dirty'
  | 'sidebar.noPinned'
  | 'composer.placeholder'
  | 'composer.disabledPlaceholder'
  | 'composer.model.ceoAgent'
  | 'thread.empty.title'
  | 'thread.empty.body'
  | 'thread.empty.authAction'
  | 'thread.empty.cloudAction'
  | 'thread.loading.bootstrap'
  | 'thread.running.approvedCapability'
  | 'chat.conversations.title'
  | 'chat.conversations.refresh'
  | 'chat.conversations.empty'
  | 'chat.conversations.new'
  | 'chat.conversations.delete'
  | 'chat.conversations.confirmDelete'
  | 'chat.conversations.pin'
  | 'chat.conversations.unpin'
  | 'chat.conversations.untitled'
  | 'chat.conversations.messageCount'
  | 'chat.sidebar.resize'
  | 'chat.channel.all'
  | 'chat.channel.web'
  | 'chat.channel.dingtalk'
  | 'chat.channel.dingtalk-direct'
  | 'chat.channel.dingtalk-group'
  | 'chat.channel.roundtable'
  | 'chat.channel.automation'
  | 'chat.channel.share'
  | 'chat.channelEvidence.title'
  | 'chat.channelEvidence.runtime'
  | 'chat.channelEvidence.source'
  | 'chat.channelEvidence.dingtalk'
  | 'chat.channelEvidence.roundtable'
  | 'chat.channelEvidence.callbacks'
  | 'chat.channelEvidence.rawMetadata'
  | 'chat.channelEvidence.participant'
  | 'chat.channelEvidence.boundary'
  | 'chat.channelEvidence.empty'
  | 'chat.thread.newTitle'
  | 'chat.thread.stop'
  | 'chat.thread.empty'
  | 'chat.thread.loading'
  | 'chat.empty.title'
  | 'chat.empty.placeholder'
  | 'chat.empty.suggestionsLabel'
  | 'chat.empty.suggestion.focus'
  | 'chat.empty.suggestion.todo'
  | 'chat.empty.suggestion.minutes'
  | 'chat.message.streaming'
  | 'chat.message.timeline'
  | 'chat.message.timelineThinking'
  | 'chat.message.timelineDone'
  | 'chat.message.confirmRegenerate'
  | 'chat.message.confirmShare'
  | 'chat.message.confirmBranch'
  | 'share.title'
  | 'share.description'
  | 'share.modeFull'
  | 'share.modeFullDesc'
  | 'share.modeSelect'
  | 'share.modeSelectDesc'
  | 'share.modeSelectDisabled'
  | 'share.sectionMode'
  | 'share.sectionAccess'
  | 'share.accessPublic'
  | 'share.accessPublicDesc'
  | 'share.accessAcl'
  | 'share.accessAclDesc'
  | 'share.aclWhitelist'
  | 'share.aclPlaceholder'
  | 'share.cancel'
  | 'share.confirm'
  | 'share.creating'
  | 'share.copied'
  | 'share.aclPreparing'
  | 'share.selectionHint'
  | 'share.confirmSelection'
  | 'chat.message.confirmationPending'
  | 'chat.message.images'
  | 'chat.message.references'
  | 'chat.message.data'
  | 'chat.message.action.copy'
  | 'chat.message.action.copied'
  | 'chat.message.action.regenerate'
  | 'chat.message.action.branch'
  | 'chat.message.action.share'
  | 'chat.message.action.truncate'
  | 'chat.message.action.delete'
  | 'chat.message.action.unsupported'
  | 'chat.message.confirmDelete'
  | 'chat.message.confirmTruncate'
  | 'chat.message.shareCreated'
  | 'chat.message.inspector'
  | 'chat.message.inspectorDetail'
  | 'chat.message.inspectorTrace'
  | 'chat.message.inspectorToolCalls'
  | 'chat.message.inspectorThinking'
  | 'chat.message.inspectorContext'
  | 'chat.message.inspectorEmpty'
  | 'chat.timeline.iteration'
  | 'chat.timeline.toolCount'
  | 'chat.timeline.noContent'
  | 'chat.timeline.toolStdout'
  | 'chat.timeline.toolStderr'
  | 'chat.timeline.toolInput'
  | 'chat.timeline.hydrating'
  | 'chat.tool.localShellExec'
  | 'chat.tool.localShellStop'
  | 'chat.skill.using'
  | 'chat.skill.used'
  | 'chat.context.title'
  | 'chat.context.refresh'
  | 'chat.context.memory'
  | 'chat.context.memoryEmpty'
  | 'chat.context.wiki'
  | 'chat.context.wikiEmpty'
  | 'chat.context.wikiPageCount'
  | 'chat.context.wikiInitialize'
  | 'chat.context.wikiPagesEmpty'
  | 'chat.context.billing'
  | 'chat.context.billingEmpty'
  | 'chat.context.shareTitle'
  | 'chat.context.share'
  | 'chat.context.shareCreated'
  | 'chat.context.shareCreateFailed'
  | 'chat.context.shareEmpty'
  | 'chat.context.shareContinue'
  | 'chat.context.shareRevoke'
  | 'chat.localProxy.title'
  | 'chat.localProxy.start'
  | 'chat.localProxy.stop'
  | 'chat.localProxy.poll'
  | 'chat.localProxy.idle'
  | 'chat.localProxy.projection'
  | 'chat.localProxy.probeContracts'
  | 'chat.localProxy.contractsPassed'
  | 'chat.localProxy.contractsBlocked'
  | 'chat.localProxy.contractsUnavailable'
  | 'chat.execution.title'
  | 'chat.execution.refresh'
  | 'chat.execution.empty'
  | 'chat.execution.loadingEvidence'
  | 'chat.execution.detail'
  | 'chat.execution.result'
  | 'chat.execution.sourceTrace'
  | 'chat.execution.relatedShadow'
  | 'chat.execution.recent'
  | 'chat.execution.control'
  | 'chat.execution.cancel'
  | 'chat.execution.confirmCancel'
  | 'chat.execution.cancelResult'
  | 'chat.governance.title'
  | 'chat.governance.refresh'
  | 'chat.governance.access'
  | 'chat.governance.spectatorEnable'
  | 'chat.governance.spectatorDisable'
  | 'chat.governance.createAuth'
  | 'chat.governance.authDetail'
  | 'chat.governance.automations'
  | 'chat.governance.automationEmpty'
  | 'chat.governance.pause'
  | 'chat.governance.resume'
  | 'chat.governance.complete'
  | 'chat.governance.recover'
  | 'chat.governance.roundtable'
  | 'chat.governance.roundtablePlaceholder'
  | 'chat.governance.inject'
  | 'chat.governance.evolution'
  | 'chat.governance.evolutionEmpty'
  | 'chat.governance.activatePatch'
  | 'chat.governance.rejectPatch'
  | 'chat.governance.reviewPatch'
  | 'chat.dispatch.title'
  | 'chat.dispatch.refresh'
  | 'chat.dispatch.pending'
  | 'chat.dispatch.subtasks'
  | 'chat.dispatch.decision'
  | 'chat.dispatch.empty'
  | 'chat.dispatch.reason'
  | 'chat.dispatch.sender'
  | 'chat.dispatch.feedbackPlaceholder'
  | 'chat.dispatch.approve'
  | 'chat.dispatch.reject'
  | 'chat.dispatch.approved'
  | 'chat.dispatch.rejected'
  | 'chat.statistics.title'
  | 'chat.statistics.refresh'
  | 'chat.statistics.startDate'
  | 'chat.statistics.endDate'
  | 'chat.statistics.overview'
  | 'chat.statistics.trends'
  | 'chat.statistics.toolRanking'
  | 'chat.statistics.userRanking'
  | 'chat.statistics.realtime'
  | 'chat.statistics.export'
  | 'chat.statistics.exportFormat'
  | 'chat.statistics.exportJson'
  | 'chat.statistics.exportCsv'
  | 'chat.statistics.exportSaved'
  | 'chat.statistics.exportCloudReady'
  | 'chat.statistics.exportCloudFallback'
  | 'chat.statistics.exportCloudEmpty'
  | 'chat.statistics.exportCloudFailed'
  | 'chat.statistics.exportCancelled'
  | 'chat.statistics.empty'
  | 'chat.studio.title'
  | 'chat.studio.refresh'
  | 'chat.studio.enterChat'
  | 'chat.studio.channelPlaceholder'
  | 'chat.studio.scene'
  | 'chat.studio.events'
  | 'chat.studio.channels'
  | 'chat.studio.sessions'
  | 'chat.studio.enterSession'
  | 'chat.studio.enterResult'
  | 'chat.studio.empty'
  | 'chat.openclawGovernance.title'
  | 'chat.openclawGovernance.refresh'
  | 'chat.openclawGovernance.identityPlaceholder'
  | 'chat.openclawGovernance.catalog'
  | 'chat.openclawGovernance.identityProfiles'
  | 'chat.openclawGovernance.rolePostures'
  | 'chat.openclawGovernance.unifiedServiceRefs'
  | 'chat.openclawGovernance.capabilityProfiles'
  | 'chat.openclawGovernance.memoryPacks'
  | 'chat.openclawGovernance.seedMemoryPacks'
  | 'chat.openclawGovernance.memoryBindingPolicies'
  | 'chat.openclawGovernance.memoryWorkspaces'
  | 'chat.openclawGovernance.memorySnapshots'
  | 'chat.openclawGovernance.memoryTrainingRuns'
  | 'chat.openclawGovernance.trainingScorecards'
  | 'chat.openclawGovernance.learningSamples'
  | 'chat.openclawGovernance.memoryCandidates'
  | 'chat.openclawGovernance.peer-agentBackflowExports'
  | 'chat.openclawGovernance.modelPolicies'
  | 'chat.openclawGovernance.credentialProfiles'
  | 'chat.openclawGovernance.evalSuites'
  | 'chat.openclawGovernance.simulationEvals'
  | 'chat.openclawGovernance.certifications'
  | 'chat.openclawGovernance.agentReleases'
  | 'chat.openclawGovernance.releaseChannels'
  | 'chat.openclawGovernance.onDutyPolicies'
  | 'chat.openclawGovernance.schedulePolicies'
  | 'chat.openclawGovernance.alertPolicies'
  | 'chat.openclawGovernance.alertIncidents'
  | 'chat.openclawGovernance.remediationPolicies'
  | 'chat.openclawGovernance.remediationActions'
  | 'chat.openclawGovernance.humanTakeovers'
  | 'chat.openclawGovernance.upgradeJobs'
  | 'chat.openclawGovernance.effectiveConfig'
  | 'chat.openclawGovernance.conversationConfig'
  | 'chat.openclawGovernance.empty'
  | 'chat.openclawWriteGate.title'
  | 'chat.openclawWriteGate.boundary'
  | 'chat.openclawWriteGate.governance'
  | 'chat.openclawWriteGate.studio'
  | 'chat.openclawWriteGate.risk'
  | 'chat.openclawWriteGate.gates'
  | 'chat.openclawWriteGate.evidence'
  | 'chat.openclawWriteGate.blocked'
  | 'chat.memoryReview.title'
  | 'chat.memoryReview.refresh'
  | 'chat.memoryReview.boundaryTitle'
  | 'chat.memoryReview.boundary'
  | 'chat.memoryReview.patches'
  | 'chat.memoryReview.patchReviewOnly'
  | 'chat.memoryReview.candidates'
  | 'chat.memoryReview.simulationEvals'
  | 'chat.memoryReview.trainingRuns'
  | 'chat.memoryReview.peer-agentBackflow'
  | 'chat.memoryReview.relatedShadow'
  | 'chat.memoryReview.empty'
  | 'chat.memoryWriteGate.title'
  | 'chat.memoryWriteGate.boundary'
  | 'chat.memoryWriteGate.risk'
  | 'chat.memoryWriteGate.gates'
  | 'chat.memoryWriteGate.evidence'
  | 'chat.memoryWriteGate.blocked'
  | 'chat.observability.title'
  | 'chat.observability.refresh'
  | 'chat.observability.trace'
  | 'chat.observability.latestMessageTrace'
  | 'chat.observability.toolCalls'
  | 'chat.observability.memoryCompile'
  | 'chat.observability.retryCompile'
  | 'chat.observability.billingTrend'
  | 'chat.observability.thinking'
  | 'chat.observability.empty'
  | 'chat.confirm.approve'
  | 'chat.confirm.reject'
  | 'chat.agent.default'
  | 'chat.agent.refresh'
  | 'chat.composer.placeholder'
  | 'chat.composer.suggest'
  | 'chat.composer.complete'
  | 'chat.composer.applyCompletion'
  | 'chat.composer.send'
  | 'chat.role.user'
  | 'chat.role.assistant'
  | 'chat.role.system'
  | 'chat.role.tool'
  | 'runtime.auth'
  | 'runtime.cloud'
  | 'runtime.session'
  | 'runtime.workspace'
  | 'runtime.capabilities'
  | 'runtime.projects'
  | 'runtime.clientId'
  | 'runtime.endpoint'
  | 'runtime.mode'
  | 'runtime.mode.prod'
  | 'runtime.mode.pre'
  | 'runtime.mode.custom'
  | 'runtime.noEndpoint'
  | 'runtime.noRuntimeGateway'
  | 'runtime.sessionId'
  | 'runtime.gitBranch'
  | 'runtime.gitChanges'
  | 'runtime.noCapabilities'
  | 'runtime.noProjects'
  | 'runtime.projection.publish'
  | 'runtime.projection.publishing'
  | 'runtime.projection.published'
  | 'runtime.projection.failed'
  | 'message.assistantWorkSummary'
  | 'message.evidenceSummary'
  | 'message.returnedToCloud'
  | 'message.localOnly'
  | 'review.single'
  | 'review.multiple'
  | 'review.badge'
  | 'review.allow'
  | 'review.allowAlways'
  | 'review.deny'
  | 'review.morePending'
  | 'review.returnEvidence'
  | 'tool.waitingReview'
  | 'access.cloud_only'
  | 'access.ask_before_local'
  | 'access.session_local'
  | 'access.restricted_local'
  | 'access.full_local'
  | 'artifact.evidence.local'
  | 'artifact.evidence.returned'
  | 'task.pinned.minimalLoop'
  | 'task.pinned.reviewDesign'
  | 'updater.badge.upToDate'
  | 'updater.badge.checking'
  | 'updater.badge.updateAvailable'
  | 'updater.badge.ariaHasUpdate'
  | 'updater.badge.downloading'
  | 'updater.badge.newVersion'
  | 'updater.badge.install'
  | 'updater.badge.ready'
  | 'updater.modal.title'
  | 'updater.modal.checking'
  | 'updater.modal.newUpdatePill'
  | 'updater.modal.fromVersion'
  | 'updater.modal.backgroundDownloadHint'
  | 'updater.modal.currentVersion'
  | 'updater.modal.newVersion'
  | 'updater.modal.releaseNotes'
  | 'updater.modal.noReleaseNotes'
  | 'updater.modal.update'
  | 'updater.modal.later'
  | 'updater.modal.close'
  | 'updater.modal.installing'
  | 'updater.modal.installHint'
  | 'updater.modal.downloading'
  | 'updater.modal.restartNow'
  | 'updater.modal.openReleasePage'
  | 'updater.modal.upToDate'
  | 'updater.modal.checkAgain'
  | 'updater.modal.error'
  | 'updater.settings.title'
  | 'updater.settings.description'
  | 'updater.settings.channel'
  | 'updater.settings.channel.description'
  | 'updater.settings.channel.auto'
  | 'updater.settings.channel.beta'
  | 'updater.settings.channel.stable'
  | 'updater.badge.channel.auto'
  | 'updater.badge.channel.beta'
  | 'updater.badge.channel.stable'
  | 'updater.settings.currentVersion'
  | 'updater.settings.checkNow'
  | 'updater.settings.checking'
  | 'updater.settings.disabledHint'
  | 'updater.settings.help.title'
  | 'updater.settings.help.description'
  | 'updater.settings.help.github'
  | 'updater.settings.help.feedback'
  | 'updater.settings.help.releaseNotes'
  | 'header.capabilities.label'
  | 'header.capabilities.title'
  | 'header.capabilities.group.skill'
  | 'header.capabilities.group.mcp'
  | 'header.capabilities.group.plugin'
  | 'header.capabilities.group.builtin'
  | 'header.capabilities.builtin.localExecution'
  | 'header.capabilities.builtin.browserControl'
  | 'header.capabilities.builtin.webAccess'
  | 'header.capabilities.empty'
  | 'header.capabilities.manage'
  | 'header.capabilities.toolCount'
  | 'header.capabilities.aria'
  | 'header.capabilities.status.available'
  | 'header.capabilities.status.needsAuth'
  | 'header.capabilities.status.disabled'
  | 'header.capabilities.status.unavailable';

type TranslationValues = Record<string, string | number>;

const resources: Record<LocaleCode, Record<TranslationKey, string>> = {
  'zh-CN': {
    "projectAgent.chat.taskFallback": "这个任务",
    "projectAgent.chat.inputTooLong": "消息最多支持 100000 个 UTF-16 单元，请缩短后发送。",
    "projectAgent.quick.title": "快速会话",
    "projectAgent.quick.content": "快速会话内容",
    "projectAgent.quick.placeholder": "向 Peer Agent 发起任务…",
    "projectAgent.quick.chooseBot": "选择机器人",
    "projectAgent.quick.noBots": "还没有机器人",
    "projectAgent.quick.textOnly": "机器人快捷对话先只发送文字",
    "projectAgent.quick.empty": "先写一句话",
    "projectAgent.quick.workspace": "选择工作区",
    "projectAgent.quick.attach": "添加附件",
    "projectAgent.quick.attachmentLimit": "最多只能添加 {count} 个附件",
    "projectAgent.quick.imageLimit": "图片 {name} 超过 8 MB",
    "projectAgent.quick.fileLimit": "文件 {name} 超过 512 KB",
    "projectAgent.quick.sending": "正在发送",
    "projectAgent.quick.failed": "发送失败",
    "projectAgent.background.title": "后台运行",
    "projectAgent.background.device": "本机",
    "projectAgent.background.close": "关闭",
    "projectAgent.background.readFailed": "暂时无法读取后台运行",
    "projectAgent.background.previous": " · 显示上次结果",
    "projectAgent.background.retry": "重试",
    "projectAgent.background.loading": "正在读取…",
    "projectAgent.background.unavailable": "此运行记录已不可用",
    "projectAgent.background.empty": "暂无后台运行",
    "projectAgent.background.history": "最近结束",
    "projectAgent.background.more": "显示更多",
    "projectAgent.background.refresh": "刷新状态",
    "projectAgent.settings.quietStart": "免打扰开始时间",
    "projectAgent.settings.quietEnd": "免打扰结束时间",
    "projectAgent.settings.hour": "{label}：小时",
    "projectAgent.settings.minute": "{label}：分钟",

    ...remoteAccessZh,
    'app.newTask': '新任务',
    'searchChats.open': '搜索任务',
    'searchChats.placeholder': '搜索任务',
    'searchChats.section.chats': '任务',
    'searchChats.section.suggested': '建议',
    'searchChats.workspace.current': '当前工作区',
    'searchChats.workspace.unassigned': '未关联工作区',
    'searchChats.empty': '未找到相关任务',
    'searchChats.untitled': '未命名任务',
    'searchChats.newTask': '新建任务',
    'searchChats.shortcut': '⌘K',
    'app.search': '搜索',
    'app.plugins': '插件',
    'app.agents': 'Agent',
    'app.automations': '自动化',
    'app.pinned': '置顶',
    'app.projects': '项目',
    'app.settings': '设置',
    'app.run': '运行',
    'app.open': '打开',
    'app.workspaceFallback': '当前工作区',
    'account.personal': '个人账户',
    'account.usageRemaining': '剩余额度',
    'appearance.title': '外观',
    'appearance.subtitle': '调整工作台主题、字体和对比度。',
    'appearance.mode': '主题模式',
    'appearance.mode.light': '浅色',
    'appearance.mode.dark': '深色',
    'appearance.mode.system': '跟随系统',
    'appearance.palette': '配色',
    'appearance.quick': '快速切换外观',
    'appearance.quick.black': '黑',
    'appearance.quick.white': '白',
    'appearance.swatches': '色板',
    'appearance.codePreview': '代码预览',
    'appearance.editTheme': '编辑主题',
    'appearance.scheme.light': '浅色主题',
    'appearance.scheme.dark': '深色主题',
    'appearance.import': '导入',
    'appearance.copy': '复制',
    'appearance.copied': '已复制',
    'appearance.copyFallback': '复制这份主题配置：',
    'appearance.importPrompt': '粘贴主题配置 JSON',
    'appearance.importFailed': '主题配置无效。',
    'appearance.preset': '预设',
    'appearance.custom': '自定义',
    'appearance.accent': '重点色',
    'appearance.background': '背景',
    'appearance.foreground': '文字',
    'appearance.uiFont': '界面字体',
    'appearance.codeFont': '代码字体',
    'appearance.diffMarker': '差异标记',
    'appearance.diffMarker.color': '颜色',
    'appearance.diffMarker.sign': '+/- 符号',
    'appearance.translucentSidebar': '半透明侧栏',
    'appearance.contrast': '对比度',
    'appearance.fontScale': '界面字体大小',
    'appearance.fontScale.small': '小',
    'appearance.fontScale.medium': '中',
    'appearance.fontScale.large': '大',
    'appearance.preview': '实时预览',
    'appearance.diffPreview': '差异预览',
    'appearance.deriveCustom': '基于此自定义',
    'appearance.settingsList': '界面与代码',
    'appearance.reset': '重置外观',
    'appearance.language': '语言',
    'settings.search': '搜索设置…',
    'settings.searchEmpty': '无匹配的设置项',
    'settings.general': '通用',
    'settings.shell.title': '界面',
    'settings.shell.description': '切换后立刻生效，不改动已有会话。',
    'settings.shell.bots': '机器人列表',
    'settings.shell.classic': '经典界面',
    'settings.archived': '已归档会话',
    'settings.archived.description': '查看和管理当前工作区中已归档的会话。',
    'settings.archived.loading': '正在加载已归档会话…',
    'settings.archived.empty': '暂无已归档会话',
    'settings.archived.emptyDescription': '归档后的会话会显示在这里。',
    'settings.archived.loadFailed': '已归档会话加载失败，请重试。',
    'settings.archived.actionFailed': '操作失败，请重试。',
    'settings.archived.messageCount': '{count} 条消息',
    'settings.archived.date': '归档于 {date}',
    'settings.archived.restore': '恢复',
    'settings.archived.delete': '删除',
    'settings.archived.deleteTitle': '删除已归档会话',
    'settings.archived.confirmDelete': '确定要永久删除“{title}”吗？此操作无法撤销。',
    'settings.archived.working': '处理中…',
    'settings.backToChat': '返回对话',
    'settings.appearance.description': '选择界面的浅色、深色模式或跟随系统偏好。',
    'settings.language.description': '菜单、按钮和设置使用的语言。',
    'settings.general.description': '让 Peer 按照你的习惯工作。',
    'settings.general.loadFailed': '无法读取当前设置，请重新打开设置页面。',
    'settings.general.interfaceAndLanguage': '界面与语言',
    'settings.general.interfaceAndLanguage.description': '选择熟悉的入口和表达方式。',
    'settings.replyLanguage': '回复语言',
    'settings.bots.title': '通知与节奏',
    'settings.bots.description': '需要你时提醒，其他时候安静推进。',
    'settings.bots.proactivity': '主动性',
    'settings.bots.proactivity.description': '设置机器人主动汇报与跟进的频率。',
    'settings.bots.proactivity.quiet': '安静',
    'settings.bots.proactivity.low': '少',
    'settings.bots.proactivity.standard': '标准',
    'settings.bots.proactivity.high': '多',
    'settings.bots.quietHours': '安静时段',
    'settings.bots.quietHours.description': '普通通知收为未读，需要你处理的事项仍会提醒。',
    'settings.bots.quietFrom': '开始',
    'settings.bots.quietUntil': '结束',
    'settings.bots.digestTime': '今日小结',
    'settings.bots.digestTime.description': '到这个时间，把暂存的消息收成一条。',
    'settings.replyLanguage.description': '机器人与你交流时使用的语言。',
    'settings.replyLanguage.followInterface': '跟随界面语言',
    'settings.replyLanguage.auto': '自动（跟随提问语言）',
    'settings.replyLanguage.autoShort': '跟随提问语言',
    'settings.git': 'Git',
    'settings.git.branchNaming': '分支命名',
    'settings.git.branchPrefix': '分支前缀',
    'settings.git.branchPrefix.description': 'Agent 创建 Git 分支时使用的名称前缀，例如 PeerAgent/。',
    'settings.fallbackVision': '兜底多模态模型',
    'settings.fallbackVision.description': '当主模型不支持图像时，先用此模型识别本轮新图，再把文字结果静默交给主模型。未配置则剥离图片并给出弱提示。',
    'settings.fallbackVision.none': '不使用（仅剥离图片）',
    'settings.fallbackVision.strippedHint': '当前模型不支持图像，已剥离本轮图片。可在设置 → 模型中配置兜底多模态模型。',
    'settings.config': '配置管理',
    'settings.config.description': '导出技能、授权规则与界面设置，便于在其它设备恢复；登录态与设备身份不会被导出。',
    'settings.config.export': '导出配置',
    'settings.config.import': '导入配置',
    'settings.config.exported': '已导出 {count} 项到 {dir}',
    'settings.config.imported': '已导入 {count} 项，重启后生效',
    'settings.config.canceled': '已取消',
    'settings.config.failed': '操作失败',
    'settings.usage': '使用统计',
    'settings.usage.description': '汇总全部会话的 token 用量，并按当前模型单价估算成本。热力图与趋势基于请求日志（接入后开始记录）。',
    'settings.usage.loading': '加载中…',
    'settings.usage.refresh': '刷新',
    'settings.usage.loadFailed': '加载使用统计失败',
    'settings.usage.totalTokens': '总 Token',
    'settings.usage.estimatedCost': '估算成本',
    'settings.usage.conversations': '会话数',
    'settings.usage.inputTokens': '输入 Token',
    'settings.usage.outputTokens': '输出 Token',
    'settings.usage.cacheTokens': '缓存 Token',
    'settings.usage.cacheSplit': '读 {read} · 写 {write}',
    'settings.usage.note': '成本按会话当前绑定模型的单价估算（USD / 1M tokens）。会话切换模型后，历史用量也会按当前单价重算。',
    'settings.usage.unpricedNote': '有 {count} 个会话缺少有效单价，其成本未计入总计。',
    'settings.usage.byProvider': '按 Provider',
    'settings.usage.byModel': '按模型',
    'settings.usage.byRole': '按角色',
    'settings.usage.showByRole': '按角色查看',
    'settings.usage.col.role': '角色',
    'modelRouting.nav': '模型分工',
    'modelRouting.title': '模型分工',
    'modelRouting.description': '为不同工作选择档位或具体模型。普通对话仍使用会话里选中的模型。',
    'modelRouting.singleModel': '只有一个模型时，所有工作都用它',
    'modelRouting.noModel': '没有可用的模型',
    'modelRouting.tiers': '档位',
    'modelRouting.roles': '角色',
    'modelRouting.primary': '主模型',
    'modelRouting.fallbacks': '备选',
    'modelRouting.addFallback': '添加备选',
    'modelRouting.moveUp': '上移',
    'modelRouting.moveDown': '下移',
    'modelRouting.remove': '移除',
    'modelRouting.mode.tier': '跟随档位',
    'modelRouting.mode.fixed': '固定模型',
    'modelRouting.mode.auto': '自动',
    'modelRouting.pool': '模型池',
    'modelRouting.poolInvalid': '自动池里需要至少一个满足该角色能力的模型',
    'modelRouting.resolved': '当前解析',
    'modelRouting.unresolved': '没有可用的模型',
    'modelRouting.preferDifferentFamily': '复核优先不同源',
    'modelRouting.spendCap': '日花费上限（美元）',
    'modelRouting.spendExceeded': '该角色已达到今日花费上限',
    'modelRouting.essentialSpend': '已超过今日上限。这是必达工作，仍会继续，并在需要你时提示',
    'modelRouting.tier.strong': '强',
    'modelRouting.tier.fast': '快',
    'modelRouting.tier.economy': '省',
    'modelRouting.tier.vision': '视觉',
    'modelRouting.role.project_agent': '项目代理',
    'modelRouting.role.session_worker': '任务执行',
    'modelRouting.role.explorer': '探索',
    'modelRouting.role.verifier': '复核',
    'modelRouting.role.visual_verifier': '视觉复核',
    'modelRouting.role.memory_curator': '记忆整理',
    'modelRouting.role.objective_probe': '目标探查',
    'modelRouting.role.compactor': '压缩',
    'modelRouting.reason.vision': '不能看图',
    'modelRouting.reason.tools': '不能使用工具',
    'modelRouting.reason.structured': '不能输出结构化结果',
    'modelRouting.reason.context': '上下文太短',
    'modelRouting.loadFailed': '模型分工加载失败',
    'modelRouting.saveFailed': '模型分工保存失败',
    'settings.usage.emptyGroup': '暂无分组数据',
    'settings.usage.col.provider': 'Provider',
    'settings.usage.col.model': '模型',
    'settings.usage.col.conversations': '会话',
    'settings.usage.col.input': '输入',
    'settings.usage.col.output': '输出',
    'settings.usage.col.cacheRead': '缓存读',
    'settings.usage.col.cacheWrite': '缓存写',
    'settings.usage.col.total': '合计',
    'settings.usage.col.cost': '估算成本',
    'settings.usage.range': '时间段',
    'settings.usage.range.7d': '7 天',
    'settings.usage.range.1m': '1 个月',
    'settings.usage.range.3m': '3 个月',
    'settings.usage.range.6m': '6 个月',
    'settings.usage.range.1y': '1 年',
    'settings.usage.heatmap': 'Token 热力图',
    'settings.usage.heatmap.note': '按天聚合请求日志中的 token（仅统计日志接入后的用量）',
    'settings.usage.heatmap.empty': '当前还没有请求日志。发送消息后会开始按天累积。',
    'settings.usage.heatmap.less': '少',
    'settings.usage.heatmap.more': '多',
    'settings.usage.trend': '使用趋势',
    'settings.usage.daily.totalTokens': '区间 Token',
    'settings.usage.daily.requests': '请求数',
    'settings.usage.daily.activeDays': '有用量天数',
    'settings.usage.dayDetail': '当天详情',
    'settings.usage.dayDetail.close': '关闭详情',
    'settings.usage.dayDetail.hint': '点击热力图或趋势图中的某一天，查看当天按模型的用量明细与小时分布。',
    'settings.usage.dayDetail.models': '按模型',
    'settings.usage.dayDetail.hours': '24 小时分布',
    'settings.usage.dayDetail.hour': '点',
    'settings.usage.dayDetail.empty': '这一天没有记录到用量（请求日志自接入后开始记录）。',
    'settings.usage.col.requests': '请求数',
    'auth.login': '登录',
    'auth.logout': '退出',
    'auth.not_configured': '登录未配置',
    'auth.signed_out': '未登录',
    'auth.signing_in': '登录中',
    'auth.authenticated': '已登录',
    'auth.error': '登录异常',
    'auth.loginFailed': '登录失败：{message}',
    'auth.cancelLogin': '取消登录',
    'auth.permissionHint': '已在浏览器打开登录页。若提示无权限，请按页面指引申请权限，完成后回到这里重试。',
    'developer.title': '开发者模式',
    'developer.subtitle': '切换请求环境并查看登录态诊断',
    'developer.currentMode': '当前环境',
    'developer.enable': '开启开发者模式',
    'developer.cloudMode': '服务环境',
    'developer.gatewayUrl': 'HTTP API 地址',
    'developer.streamUrl': 'SSE Stream 地址',
    'developer.runtimeGatewayUrl': 'Runtime Gateway WS 地址',
    'developer.auth': '登录态',
    'developer.bucEnv': 'BUC 环境',
    'developer.lastRequest': '最近请求',
    'developer.probe': '探测',
    'developer.apply': '应用',
    'developer.reset': '重置',
    'developer.saving': '保存中',
    'developer.probing': '探测中',
    'developer.loadFailed': '开发者配置加载失败',
    'developer.saveFailed': '开发者配置保存失败',
    'developer.probeFailed': '云端合约探测失败',
    'developer.ipcUnavailable': '开发者模式主进程通道未注册。请完全退出并重启客户端，确保 Electron main 已更新后再重试。',
    'projectAgent.host.title': "执行宿主",
    'projectAgent.host.hint': "桌面和终端共享同一机器人。接管会先停止旧宿主，再由桌面继续任务。",
    'projectAgent.host.action': "在桌面接管",
    'projectAgent.host.requested': "已请求接管，旧宿主停止后会继续任务。",
    'projectAgent.host.ready': "桌面已可承载这个机器人。",
    'projectAgent.host.failed': "接管失败，请检查机器人和宿主状态。",
    'developer.projectAgent.nav': '开发者',
    'developer.projectAgent.title': '开发者',
    'developer.projectAgent.description': '界面在设置 → 通用里切换。这里不再读取旧的项目代理开关，原来的值会留着。',
    'developer.projectAgent.switch': '界面在设置 → 通用里切换。项目代理会继续推进已有任务。',
    'developer.projectAgent.diagnostics': '项目代理诊断',
    'developer.projectAgent.inactive': '未启用',
    'developer.diagnostics.description': '只读运行快照。标识与正文只保留长度和哈希，项目路径匿名化；每个机器人保留最近 200 条事件和 20 次回合，旧回合时长显示未知。',
    'developer.diagnostics.refresh': '刷新诊断',
    'developer.diagnostics.export': '导出 JSON',
    'developer.diagnostics.busy': '正在读取诊断…',
    'developer.diagnostics.saved': '诊断已导出',
    'developer.diagnostics.cancelled': '已取消导出',
    'developer.diagnostics.failed': '诊断读取或导出失败，请重试。',
    'developer.diagnostics.unknown': '未知',
    'developer.diagnostics.generated': '快照时间',
    'developer.diagnostics.bots': '机器人',
    'developer.diagnostics.slots': '使用中的回合槽位',
    'developer.diagnostics.waiting': '等待回合',
    'developer.diagnostics.errors': '不可用的来源',
    'developer.diagnostics.preview': '查看脱敏 JSON',
    'projectAgent.list.brand': 'Peer',
    'projectAgent.list.newBot': '新建机器人',
    'projectAgent.list.searchPlaceholder': '搜索机器人、消息、任务',
    'projectAgent.list.needsYou': '需要你 {count}',
    'projectAgent.list.empty': '还没有机器人',
    'projectAgent.list.emptyHint': '用左上角 + 绑定文件夹，或建一个空白机器人。',
    'projectAgent.list.emptyNeedsYou': '现在没有需要你处理的事。',
    'projectAgent.list.emptySearch': '没有匹配的机器人。',
    'projectAgent.list.me': '我',
    'projectAgent.list.settings': '设置',
    'projectAgent.list.automations': '自动化',
    'projectAgent.list.capabilities': '能力',
    'projectAgent.list.capabilitiesHint': '插件、技能与 MCP',
    'projectAgent.list.history': '历史对话',
    'projectAgent.shell.classicNotice': '切换到机器人界面查看',
    'projectAgent.shell.banner': '这是新的机器人列表；原来的会话在各机器人的档案 → 任务 → 历史对话；可以在 设置 → 通用 切回经典界面',
    'projectAgent.shell.bannerTitle': '新的机器人列表',
    'projectAgent.shell.bannerWhere': '旧会话在各机器人的档案里',
    'projectAgent.shell.bannerPath': '任务 → 历史对话',
    'projectAgent.shell.bannerSwitch': '设置 → 通用 可切回经典界面',
    'projectAgent.shell.bannerDismiss': '知道了',
    'projectAgent.onboarding.connectTitle': '先接入模型',
    'projectAgent.onboarding.connectBody': '接入之后才能新建机器人。',
    'projectAgent.onboarding.connectAction': '接入模型',
    'projectAgent.onboarding.createTitle': '新建机器人',
    'projectAgent.onboarding.createBody': '绑定一个文件夹，或建一个空白机器人。',
    'projectAgent.onboarding.createAction': '新建机器人',
    'projectAgent.search.placeholder': '搜索机器人、消息、任务、记忆',
    'projectAgent.search.empty': '没有匹配',
    'projectAgent.search.section.bots': '机器人',
    'projectAgent.search.section.messages': '消息',
    'projectAgent.search.section.tasks': '任务',
    'projectAgent.search.section.memory': '记忆',
    'projectAgent.list.loading': '正在读取机器人',
    'projectAgent.list.unavailable': '项目代理没有打开',
    'projectAgent.list.loadFailed': '机器人列表没有读出来',
    'projectAgent.list.noPreview': '还没有消息',
    'projectAgent.list.mainEmptyTitle': '从一个项目开始',
    'projectAgent.list.mainEmptyBody': '选择机器人，继续对话或交代新的任务。',
    'projectAgent.list.recentBots': '最近的机器人',
    'projectAgent.list.openBot': '打开对话',
    'projectAgent.list.mainPlaceholder': '和这个机器人的对话会显示在这里。',
    'projectAgent.list.profile': '档案',
    'projectAgent.list.unread': '未读',
    'projectAgent.list.running': '进行中',
    'projectAgent.list.needsYouBadge': '需要你 {count}',
    'projectAgent.list.newSheetTitle': '新建机器人',
    'projectAgent.list.bindFolder': '选择文件夹',
    'projectAgent.list.bindFolderHint': '绑定已有项目。机器人会先只读熟悉这个文件夹。',
    'projectAgent.list.blankBot': '空白机器人',
    'projectAgent.list.blankBotHint': '输入名字，在本机受管目录里建一个空项目。',
    'projectAgent.list.namePlaceholder': '机器人名字',
    'projectAgent.list.nameInvalid': '这个名字不能用',
    'projectAgent.list.nameWillUse': '将使用「{name}」',
    'projectAgent.list.create': '建立',
    'projectAgent.list.creating': '正在建立',
    'projectAgent.list.createFailed': '没有建成',
    'projectAgent.list.nameExhausted': '这个名字已经用得太多了',
    'projectAgent.list.columnResize': '调整列表宽度',
    'projectAgent.list.backToBots': '返回机器人',
    'projectAgent.list.close': '关闭',
    'projectAgent.chat.empty': '还没有对话。说一句，机器人会接着做。',
    'projectAgent.chat.loadFailed': '对话没有加载出来',
    'projectAgent.chat.thinking': '思考中…',
    'projectAgent.chat.waiting': '等待回复…',
    'projectAgent.chat.generating': '正在生成回复',
    'projectAgent.chat.toolLabel.read': '读取文件',
    'projectAgent.chat.toolLabel.search': '项目搜索',
    'projectAgent.chat.toolLabel.edit': '编辑文件',
    'projectAgent.chat.toolLabel.command': '执行命令',
    'projectAgent.chat.toolRunning': '正在进行{tool}',
    'projectAgent.chat.toolDone': '{tool}已结束',
    'projectAgent.chat.toolFailed': '{tool} 未完成',
    'projectAgent.chat.stop': '停止生成',
    'projectAgent.chat.stopHint': '停止当前回复生成，已派发的任务继续运行',
    'projectAgent.chat.stopping': '正在停止',
    'projectAgent.chat.stopped': '生成已停止，以上内容未完成',
    'projectAgent.chat.stopFailed': '停止失败，请再试一次。',
    'projectAgent.chat.latest': '回到最新消息',
    'projectAgent.chat.received': '已收到',
    'projectAgent.chat.loadOlder': '查看更早消息',
    'projectAgent.chat.loadingOlder': '正在加载更早消息',
    'projectAgent.chat.olderFailed': '加载失败，重试',
    'projectAgent.chat.sending': '发送中',
    'projectAgent.chat.failed': '没有发出去',
    'projectAgent.chat.retry': '重发',
    'projectAgent.chat.replied': '已回复',
    'projectAgent.chat.disposition.answered': '已回答',
    'projectAgent.chat.disposition.merged': '已并入',
    'projectAgent.chat.disposition.stopped': '已停止',
    'projectAgent.chat.disposition.superseded': '已取代',
    'projectAgent.chat.disposition.parallel': '已并行',
    'projectAgent.chat.disposition.queued': '已排队',
    'projectAgent.chat.disposition.outOfScope': '这句话针对的是『{title}』，没有影响其他任务',
    'projectAgent.chat.quote': '引用',
    'projectAgent.chat.quoteRemove': '取消引用',
    'projectAgent.chat.placeholder': '跟这个机器人说',
    'projectAgent.chat.attach': '添加文件或图片',
    'projectAgent.chat.previewAttachment': '预览图片',
    'projectAgent.chat.removeAttachment': '移除附件',
    'projectAgent.chat.attachmentMetadataOnly': '仅文件信息 · 正文未读取',
    'projectAgent.chat.readingAttachments': '正在读取附件…',
    'projectAgent.chat.dropAttachments': '松开以添加文件或图片',
    'projectAgent.chat.send': '发送',
    'projectAgent.chat.hint': '回车发送，Shift+回车换行',
    'projectAgent.chat.source': '来源',
    'projectAgent.chat.evidence': '证据',
    'projectAgent.chat.evidenceMore': '还有 {count} 条证据',
    'projectAgent.chat.evidenceCollapse': '收起证据',
    'projectAgent.chat.process': '过程',
    'projectAgent.chat.chooseAnswer': '选择一个回答，也可以直接输入',
    'projectAgent.chat.you': '你',
    'projectAgent.process.reply': '发送回复',
    'projectAgent.process.sessions': '查询工作会话',
    'projectAgent.process.session': '查看工作会话',
    'projectAgent.process.start': '创建工作任务',
    'projectAgent.process.resume': '恢复工作任务',
    'projectAgent.process.cancel': '取消工作任务',
    'projectAgent.process.update': '调整工作安排',
    'projectAgent.process.verification': '检查验证结果',
    'projectAgent.process.memory': '处理项目记忆',
    'projectAgent.process.objective': '处理项目目标',
    'projectAgent.process.tool': '调用工具',
    'projectAgent.process.runningTitle': '正在{tool}',
    'projectAgent.process.preparingTitle': '正在准备{tool}',
    'projectAgent.process.organizing': '正在整理回复',
    'projectAgent.process.preparingReply': '正在准备回复',
    'projectAgent.process.preparing': '准备中',
    'projectAgent.process.running': '进行中',
    'projectAgent.process.stopped': '已停止',
    'projectAgent.process.awaitingContent': '模型尚未返回可展示的内容；执行步骤会出现在这里。',
    'projectAgent.process.receiving': '正在接收调用参数 · {count} 字符',
    'projectAgent.process.preparingNote': '正在生成调用参数，尚未执行。',
    'projectAgent.process.runningNote': '调用正在进行，返回内容到达后会显示在这里。',
    'projectAgent.process.parameters': '调用参数',
    'projectAgent.process.output': '返回内容',
    'projectAgent.process.truncated': '已截断',
    'projectAgent.process.redacted': '已脱敏',
    'projectAgent.process.previewLimit': '内容超出预览上限。',
    'projectAgent.process.seconds': '{seconds} 秒',
    'projectAgent.process.minutes': '{minutes} 分 {seconds} 秒',
    'projectAgent.process.done': '已结束',
    'projectAgent.process.failed': '未完成',
    'projectAgent.process.suppressed': '未发送',
    'projectAgent.process.unknown': '状态未记录',
    'projectAgent.process.sent': '已发送',
    'projectAgent.process.count': '返回 {count} 条记录',
    'projectAgent.process.technical': '技术详情',
    'projectAgent.process.input': '调用参数（最多显示 12,000 字符）',
    'projectAgent.process.result': '返回记录（最多显示 12,000 字符）',
    'projectAgent.process.empty': '本轮没有可用的过程记录',
    'projectAgent.chat.openProcess': '查看过程',
    'projectAgent.chat.memoryUsed': '参考了 {count} 条记忆',
    'projectAgent.chat.memoryLearned': '新记住 {count} 条',
    'projectAgent.chat.digest': '今日小结',
    'projectAgent.chat.today': '今天 {time}',
    'projectAgent.chat.earlierDay': '{date} {time}',
    'projectAgent.chat.replyTo': '回复',
    'projectAgent.chat.sessionState.paused': '已暂停',
    'projectAgent.chat.sessionState.queued': '排队中',
    'projectAgent.chat.sessionState.starting': '正在启动',
    'projectAgent.chat.work.heading': '关联任务',
    'projectAgent.chat.work.more': '另有 {count} 项任务',
    'projectAgent.chat.work.related': '关联任务',
    'projectAgent.chat.work.unavailable': '状态暂不可用',
    'projectAgent.chat.work.unavailableHint': '暂时无法获取最新任务状态，请打开任务查看。',
    'projectAgent.chat.work.handle': '查看并处理',
    'projectAgent.chat.work.open': '打开任务',
    'projectAgent.chat.work.background': '当前有 {count} 项任务待跟进',
    'projectAgent.chat.context.basis': '结果依据 · {count} 条记录',
    'projectAgent.chat.originalMessage': '查看原消息',
    'projectAgent.chat.context.details': '回复详情',
    'projectAgent.chat.context.memoryUnavailable': '相关记忆暂不可用。',
    'projectAgent.drawer.inspectBack': '返回 Bot 档案',
    'projectAgent.drawer.evidenceUnavailable': '这条证据暂时无法读取。',
    'projectAgent.drawer.botDescription': '负责这个项目的工作协调，持续跟进任务并交还结果。',
    'projectAgent.drawer.acceptance.confirm': '由你确认',
    'projectAgent.drawer.memory.details': '记忆详情',
    'projectAgent.chat.sessionState.running': '正在运行中',
    'projectAgent.chat.sessionState.waiting_user': '需要你处理',
    'projectAgent.chat.sessionState.verifying': '核验中',
    'projectAgent.chat.sessionState.result_ready': '待你确认',
    'projectAgent.chat.sessionState.accepted': '已签收',
    'projectAgent.chat.sessionState.failed': '任务失败',
    'projectAgent.chat.sessionState.cancelled': '已取消',
    'projectAgent.chat.sessionState.superseded': '已取代',
    'projectAgent.chat.verdict.passed': '结论：已验证',
    'projectAgent.chat.verdict.failed': '结论：没通过',
    'projectAgent.chat.verdict.partial': '结论：部分验证',
    'projectAgent.chat.verdict.unverifiable': '结论：无法验证',
    'projectAgent.chat.surfacingLabel': '通知方式：',
    'projectAgent.chat.surfacing.interrupt': '即时提醒',
    'projectAgent.chat.surfacing.message': '出现在对话里',
    'projectAgent.chat.surfacing.digest': '收进小结',
    'projectAgent.chat.surfacing.silent': '不打扰',
    'projectAgent.chat.approve': '批准',
    'projectAgent.chat.allowOnce': '允许',
    'projectAgent.chat.allowTask': '本任务内都允许',
    'projectAgent.chat.approveContinue': '批准并继续',
    'projectAgent.chat.reject': '拒绝',
    'projectAgent.chat.answer': '回答',
    'projectAgent.policy.planApproval': '开工前批准计划',
    'projectAgent.policy.planApproval.never': '直接开工',
    'projectAgent.policy.planApproval.writes': '写入任务先批准',
    'projectAgent.policy.planApproval.always': '所有任务先批准',
    'projectAgent.policy.acceptance.auto': '符合条件时自动签收',
    'projectAgent.policy.acceptance.confirm': '由我确认结果',
    'projectAgent.policy.models': '机器人模型',
    'projectAgent.model.defaults': '默认与档位',
    'projectAgent.model.botOnly': '本机器人',
    'projectAgent.model.nextReply': '修改用于后续回复或新任务',
    'projectAgent.model.runningReply': '本轮正在使用的模型',
    'projectAgent.model.unavailable': '选择模型',
    'projectAgent.model.select': '选择机器人模型',
    'projectAgent.model.noEffort': '无可调推理强度',
    'projectAgent.model.saveFailed': '模型设置未保存，请重试。',
    'projectAgent.policy.modelsHint': '直接选择这个机器人的模型和推理强度。对话配置用于后续回复，任务配置用于新任务。',
    'projectAgent.policy.inherit': '跟随全局',
    'projectAgent.policy.autoPool': '已配置自动池',
    'projectAgent.policy.moreRoles': '更多角色',
    'projectAgent.policy.fewerRoles': '收起角色',
    'projectAgent.policy.scope': '可用模型范围',
    'projectAgent.policy.scope.all': '全部已配置模型',
    'projectAgent.policy.scope.restricted': '仅所选模型',
    'projectAgent.policy.localOnly': '只使用本地模型',
    'projectAgent.chat.confirmResult': '确认结果',
    'projectAgent.chat.acceptReadme': '写 README',
    'projectAgent.chat.actionFailed': '操作失败，请重试',
    'projectAgent.drawer.title': '档案',
    'projectAgent.drawer.close': '关闭',
    'projectAgent.drawer.back': '返回任务',
    'projectAgent.drawer.missing': '还没有',
    'projectAgent.drawer.tab.overview': '概况',
    'projectAgent.drawer.tab.tasks': '任务',
    'projectAgent.drawer.tab.objectives': '目标',
    'projectAgent.drawer.tab.memory': '记忆',
    'projectAgent.drawer.tab.settings': '设置',
    'projectAgent.drawer.folder': '绑定文件夹',
    'projectAgent.drawer.noPath': '还没有文件夹',
    'projectAgent.drawer.reveal': '在访达中显示',
    'projectAgent.drawer.brief': '项目简报',
    'projectAgent.drawer.briefEmpty': '还没有项目简报',
    'projectAgent.drawer.running': '在推进的任务',
    'projectAgent.drawer.runningEmpty': '现在没有在推进的任务',
    'projectAgent.drawer.acceptance': '签收策略',
    'projectAgent.drawer.acceptance.auto': '自动',
    'projectAgent.drawer.acceptance.pending': '签收策略还没有单独的保存接口，当前按自动处理。',
    'projectAgent.drawer.model': '对话模型',
    'projectAgent.drawer.modelEmpty': '跟随全局分工',
    'projectAgent.drawer.model.pending': '项目级模型范围还没有单独的保存接口，这里显示全局对话模型。',
    'projectAgent.drawer.tasksEmpty': '还没有任务',
    'projectAgent.drawer.showAll': '查看全部',
    'projectAgent.drawer.collapse': '收起',
    'projectAgent.drawer.group.needsYou': '需要你',
    'projectAgent.drawer.group.running': '进行中',
    'projectAgent.drawer.group.queued': '排队',
    'projectAgent.drawer.group.done': '已完成',
    'projectAgent.drawer.group.paused': '已暂停',
    'projectAgent.drawer.supersededBy': '被「{task}」取代',
    'projectAgent.drawer.resume': '恢复',
    'projectAgent.drawer.resumeFailed': '恢复失败，请稍后重试。',
    'projectAgent.drawer.replacement': '后续任务',
    'projectAgent.drawer.group.history': '历史对话',
    'projectAgent.drawer.group.classic': '经典任务',
    'projectAgent.drawer.historyEmpty': '没有可继续的历史对话',
    'projectAgent.drawer.continueHistory': '交给这个机器人继续',
    'projectAgent.drawer.historyPartial': '这段对话里有工具或附件材料，继续时不会带上。仍然交给机器人吗？',
    'projectAgent.drawer.historyPartialConfirm': '仍然继续',
    'projectAgent.drawer.historyPickBot': '选择机器人',
    'projectAgent.drawer.classicOpen': '打开原来的会话',
    'projectAgent.drawer.legacyAutomations': '自动化（旧）',
    'projectAgent.drawer.legacyAutomationsEmpty': '这个项目没有旧的自动化',
    'projectAgent.drawer.anchor': '锚点',
    'projectAgent.drawer.taskDetail.back': "任务列表",
    'projectAgent.drawer.taskDetail.untitled': "未命名任务",
    'projectAgent.drawer.taskDetail.created': "创建于 {time}",
    'projectAgent.drawer.taskDetail.createdAt': "创建时间",
    'projectAgent.drawer.taskDetail.open': "打开工作会话",
    'projectAgent.drawer.taskDetail.review': "查看结果",
    'projectAgent.drawer.taskDetail.noScene': "尚未建立可打开的工作会话。",
    'projectAgent.drawer.taskDetail.report': "任务报告",
    'projectAgent.drawer.taskDetail.noReport': "暂时没有任务报告。",
    'projectAgent.drawer.taskDetail.evidenceCount': "{count} 条依据记录",
    'projectAgent.drawer.taskDetail.info': "任务信息",
    'projectAgent.drawer.taskDetail.model': "执行模型",
    'projectAgent.drawer.taskDetail.id': "任务标识",
    'projectAgent.drawer.taskDetail.sourceId': "来源消息",
    'projectAgent.drawer.taskDetail.evidenceRefs': "依据引用",
    'projectAgent.drawer.taskDetail.evidenceHint': "这里保留任务记录中的引用标识；内容可在工作会话中查看。",
    'projectAgent.drawer.taskDetail.status.starting': "准备启动",
    'projectAgent.drawer.taskDetail.status.queued': "等待执行",
    'projectAgent.drawer.taskDetail.status.paused': "已暂停",
    'projectAgent.drawer.taskDetail.hint.starting': "任务正在准备启动，可打开工作会话查看。",
    'projectAgent.drawer.taskDetail.hint.running': "机器人正在推进任务，可打开工作会话查看过程。",
    'projectAgent.drawer.taskDetail.hint.waiting_user': "打开工作会话，查看并处理需要你决定的事项。",
    'projectAgent.drawer.taskDetail.hint.verifying': "正在核对任务结果与依据，可打开工作会话查看复核记录。",
    'projectAgent.drawer.taskDetail.hint.queued': "任务正在等待执行，排队情况如上。",
    'projectAgent.drawer.taskDetail.hint.paused': "任务已暂停。可返回任务列表恢复，或打开工作会话查看记录。",
    'projectAgent.drawer.taskDetail.hint.result_ready': "打开工作会话查看结果，并完成确认。",
    'projectAgent.drawer.taskDetail.hint.accepted': "本轮结果已签收，可以回到工作会话查看记录。",
    'projectAgent.drawer.taskDetail.hint.failed': "任务未完成。打开工作会话查看失败记录。",
    'projectAgent.drawer.taskDetail.hint.cancelled': "任务已取消，原工作会话仍可查看。",
    'projectAgent.drawer.taskDetail.hint.superseded': "这条任务已被后续任务替代，历史记录仍可查看。",
    'projectAgent.drawer.taskDetail.hint.unavailable': "暂时无法确认最新状态，已有记录仅供参考。",
    'projectAgent.drawer.frozenModel': '冻结的模型',
    'projectAgent.drawer.conclusion': '结论',
    'projectAgent.drawer.evidence': '证据',
    'projectAgent.drawer.progress': '最近进展',
    'projectAgent.drawer.openScene': '打开现场',
    'projectAgent.drawer.scene': '任务现场',
    'projectAgent.drawer.sceneMissing': '现场还没有会话',
    'projectAgent.drawer.objective.source': '所属目标',
    'projectAgent.drawer.objective.empty': '还没有持续目标',
    'projectAgent.drawer.objective.hint': '告诉机器人你想持续推进或关注什么。',
    'projectAgent.drawer.objective.active': '进行中',
    'projectAgent.drawer.objective.paused': '已暂停',
    'projectAgent.drawer.objective.achieved': '已达成',
    'projectAgent.drawer.objective.abandoned': '已放弃',
    'projectAgent.drawer.objective.pending': '等待你确认',
    'projectAgent.drawer.objective.report_only': '只报告',
    'projectAgent.drawer.objective.propose': '先提议',
    'projectAgent.drawer.objective.act': '直接处理',
    'projectAgent.drawer.objective.autonomy': '自主档位',
    'projectAgent.drawer.objective.budget': '每日自动任务',
    'projectAgent.drawer.objective.probes': '每日检查预算',
    'projectAgent.drawer.objective.autoAccept': '允许自动签收',
    'projectAgent.drawer.objective.autoUsage': '今日自动任务 {used}/{limit}',
    'projectAgent.drawer.objective.usage': '今日检查 {used}/{limit}',
    'projectAgent.drawer.objective.watch.unavailable': '暂时无法检查',
    'projectAgent.drawer.objective.watch.auth': '登录 GitHub 后可检查 CI',
    'projectAgent.drawer.objective.watch.cli': '需要 GitHub CLI 才能检查 CI',
    'projectAgent.drawer.objective.watch.daily': '今日检查次数已达上限',
    'projectAgent.drawer.objective.watch.hourly': '本小时检查次数已达上限',
    'projectAgent.drawer.objective.watch.scope': '路径超出项目范围',
    'projectAgent.drawer.objective.watch.range': '观察范围过大，请缩小路径范围',
    'projectAgent.drawer.objective.watch.model': '未配置可用的观察模型',
    'projectAgent.drawer.objective.watch.cancelled': '检查已停止',
    'projectAgent.drawer.objective.last': '最近检查',
    'projectAgent.drawer.objective.next': '下次检查',
    'projectAgent.drawer.objective.unchecked': '尚未检查',
    'projectAgent.drawer.objective.event': '事件变化时检查',
    'projectAgent.drawer.objective.edit': '调整计划',
    'projectAgent.drawer.objective.save': '保存',
    'projectAgent.drawer.objective.cancel': '取消',
    'projectAgent.drawer.objective.pause': '暂停',
    'projectAgent.drawer.objective.resume': '恢复',
    'projectAgent.drawer.objective.reopen': '重新打开',
    'projectAgent.drawer.objective.abandon': '放弃',
    'projectAgent.drawer.objective.failed': '操作失败，请刷新后重试。',
    'projectAgent.drawer.objective.loading': '正在读取目标',
    'projectAgent.drawer.objective.title': '目标名称',
    'projectAgent.drawer.objective.outcome': '达成的样子',
    'projectAgent.drawer.objective.tasks': '关联任务',
    'projectAgent.drawer.objective.noTasks': '还没有关联任务',
    'projectAgent.drawer.objectives.body': '目标将在后续版本开放',
    'projectAgent.drawer.objectives.hint': '现在可以先通过对话交代具体任务。',
    'projectAgent.drawer.memory.empty': '还没有记忆',
    'projectAgent.drawer.memory.emptyHint': '机器人记下的项目事实、偏好和决定会显示在这里。',
    'projectAgent.drawer.memory.filterEmpty': '没有符合筛选条件的记忆',
    'projectAgent.drawer.memory.controls': '记忆设置',
    'projectAgent.drawer.memory.saved': '已保存的记忆',
    'projectAgent.drawer.memory.page': '{start}–{end} / {total}',
    'projectAgent.drawer.memory.previous': '上一页',
    'projectAgent.drawer.memory.next': '下一页',
    'projectAgent.drawer.memory.scope.project': '当前项目',
    'projectAgent.drawer.memory.scope.global': '所有项目',
    'projectAgent.drawer.memory.readonly': '可以固定、撤销、恢复和导出这些记忆',
    'projectAgent.drawer.memory.filter.kind': '种类',
    'projectAgent.drawer.memory.filter.trust': '信任',
    'projectAgent.drawer.memory.filter.status': '状态',
    'projectAgent.drawer.memory.filter.all': '全部',
    'projectAgent.drawer.memory.kind.fact': '事实',
    'projectAgent.drawer.memory.kind.preference': '偏好',
    'projectAgent.drawer.memory.kind.decision': '决定',
    'projectAgent.drawer.memory.kind.procedure': '流程',
    'projectAgent.drawer.memory.kind.responsibility': '职责',
    'projectAgent.drawer.memory.trust.stated': '用户说明',
    'projectAgent.drawer.memory.trust.verified': '已验证',
    'projectAgent.drawer.memory.status.active': '生效中',
    'projectAgent.drawer.memory.status.forgotten': '已撤销',
    'projectAgent.drawer.memory.sources': '来源',
    'projectAgent.drawer.memory.status.expired': '已过期',
    'projectAgent.drawer.memory.status.conflicted': '有冲突',
    'projectAgent.drawer.memory.needsReverify': '可能已过时 · 待核实',
    'projectAgent.drawer.memory.keepThis': '保留这条',
    'projectAgent.drawer.memory.pin': '固定',
    'projectAgent.drawer.memory.unpin': '取消固定',
    'projectAgent.drawer.memory.revoke': '撤销',
    'projectAgent.drawer.memory.restore': '恢复',
    'projectAgent.drawer.memory.edit': '编辑',
    'projectAgent.drawer.memory.save': '保存',
    'projectAgent.drawer.memory.exportJson': '导出 JSON',
    'projectAgent.drawer.memory.exportMarkdown': '导出 Markdown',
    'projectAgent.drawer.memory.projectSwitch': '启用记忆',
    'projectAgent.drawer.memory.useMemory': '对话时使用记忆',
    'projectAgent.drawer.memory.learnPreferences': '从我的习惯里学偏好',
    'projectAgent.drawer.memory.learnLater': '学偏好会在后续阶段生效，这个开关现在就会记住。',
    'projectAgent.drawer.settings.name': '名字',
    'projectAgent.drawer.settings.appearance': '外观',
    'projectAgent.drawer.settings.workflow': '工作方式',
    'projectAgent.drawer.settings.runtime': '运行与全局设置',
    'projectAgent.drawer.settings.globalScope': '影响所有机器人',
    'projectAgent.drawer.settings.advancedModels': '更多角色与模型限制',
    'projectAgent.drawer.settings.save': '保存',
    'projectAgent.drawer.settings.avatar': '头像',
    'projectAgent.drawer.settings.avatarNew': '重新生成',
    'projectAgent.drawer.settings.avatarUpload': '上传自己的图片',
    'projectAgent.drawer.settings.avatarColor': '颜色',
    'projectAgent.drawer.settings.avatarColorImageHint': '选择颜色会切换回生成头像。',
    'projectAgent.drawer.settings.avatarColor.0': '蓝紫色',
    'projectAgent.drawer.settings.avatarColor.1': '珊瑚红',
    'projectAgent.drawer.settings.avatarColor.2': '琥珀橙',
    'projectAgent.drawer.settings.avatarColor.3': '薄荷绿',
    'projectAgent.drawer.settings.avatarColor.4': '丁香紫',
    'projectAgent.drawer.settings.avatarColor.5': '玫瑰粉',
    'projectAgent.drawer.settings.avatarColor.6': '湖水蓝',
    'projectAgent.drawer.settings.avatarColor.7': '暖灰色',
    'projectAgent.drawer.settings.delete': '删除机器人',
    'projectAgent.drawer.settings.deleteManaged': '删除受管文件夹',
    'projectAgent.drawer.settings.deleteConfirm': '再点一次，确认删除',
    'projectAgent.drawer.settings.concurrency': '全局并发回合',
    'projectAgent.drawer.settings.concurrencyHint': '所有机器人共享，范围 1–8；每个项目最多 1 个原地写任务、2 个只读任务。',
    'projectAgent.drawer.queuedBehind': '等待 {tasks}',
    'projectAgent.drawer.dependencyFailed': '前置任务需要处理：{tasks}',
    'projectAgent.drawer.dependencyMissing': '前置任务已缺失，请重新安排',
    'projectAgent.drawer.diskSpace': '排队中：可用磁盘不足 2 GB',
    'projectAgent.drawer.isolationFailed': '排队中：隔离工作区暂不可用',
    'projectAgent.drawer.settings.autoHandoff': '策略签收后自动合回',
    'projectAgent.drawer.settings.autoHandoffHint': '默认关闭。开启后，已验证并签收的改动可自动合回本项目。',
    'projectAgent.drawer.settings.proactivity': '主动性',
    'projectAgent.drawer.settings.proactivity.inherit': '跟随全局',
    'projectAgent.drawer.settings.proactivity.quiet': '安静',
    'projectAgent.drawer.settings.proactivity.low': '少',
    'projectAgent.drawer.settings.proactivity.standard': '标准',
    'projectAgent.drawer.settings.proactivity.high': '多',
    'projectAgent.drawer.settings.proactivity.muted': '静音',
    'header.subtitle': 'Electron Shell + Local Capability Runtime',
    'status.connecting': '连接中',
    'session.cloud_only': '仅云端',
    'session.local_ready': '本地就绪',
    'session.hybrid_ready': '端云就绪',
    'session.permission_required': '需要授权',
    'session.degraded': '降级',
    'session.offline': '离线',
    'status.cloud.not_configured': 'Cloud Runtime 未配置',
    'status.cloud.configured': 'Cloud Runtime 已配置',
    'status.cloud.connected': '模型通道已连接',
    'status.cloud.degraded': 'Cloud Runtime 降级',
    'status.localCapabilityRegistered': '{count} 个本地能力已注册',
    'status.accessMode': '访问模式：{mode}',
    'status.git.clean': 'git 干净',
    'status.git.dirty': '{count} 项本地变更',
    'sidebar.noPinned': '暂无置顶任务',
    'composer.placeholder': '描述要托付的任务...',
    'composer.disabledPlaceholder': '请先配置模型，再发出第一条任务...',
    'composer.model.ceoAgent': 'Peer Agent',
    'thread.empty.title': '还没有任务',
    'thread.empty.body':
      '发出第一条委托。Peer 会在本机授权后推进，并用证据关闭完成。',
    'thread.empty.authAction': '需要先完成登录',
    'thread.empty.cloudAction': '需要先配置可用的模型通道',
    'thread.loading.bootstrap': '正在准备客户端会话和本地能力注册表...',
    'thread.running.approvedCapability': '正在通过 Electron main 和 Rust core 执行已授权的本地能力...',
    'chat.conversations.title': '任务',
    'chat.conversations.refresh': '刷新',
    'chat.conversations.empty': '还没有任务。',
    'chat.conversations.new': '新任务',
    'chat.conversations.delete': '删除任务',
    'chat.conversations.confirmDelete': '确认删除这个任务？',
    'chat.conversations.pin': '固定任务',
    'chat.conversations.unpin': '取消固定',
    'chat.conversations.untitled': '未命名任务',
    'chat.conversations.messageCount': '{count}条',
    'chat.sidebar.resize': '调整侧栏宽度',
    'chat.channel.all': '全部',
    'chat.channel.web': '单人',
    'chat.channel.dingtalk': '钉钉',
    'chat.channel.dingtalk-direct': '单聊',
    'chat.channel.dingtalk-group': '群聊',
    'chat.channel.roundtable': '圆桌',
    'chat.channel.automation': '自动化',
    'chat.channel.share': '分享',
    'chat.channelEvidence.title': '通道 Evidence',
    'chat.channelEvidence.runtime': '运行态判定',
    'chat.channelEvidence.source': '来源',
    'chat.channelEvidence.dingtalk': '钉钉元数据',
    'chat.channelEvidence.roundtable': '圆桌元数据',
    'chat.channelEvidence.callbacks': 'Callback 线索',
    'chat.channelEvidence.rawMetadata': '原始元数据',
    'chat.channelEvidence.participant': '参与者',
    'chat.channelEvidence.boundary': '只读展示通道证据；外部回调和写动作仍走既有治理接口。',
    'chat.channelEvidence.empty': '暂无通道证据。',
    'chat.thread.newTitle': '新任务',
    'chat.thread.stop': '停止',
    'chat.thread.empty': '选择一个任务，或直接发送消息创建新任务。',
    'chat.thread.loading': '正在载入这段会话',
    'chat.empty.title': '今天要我先处理什么？',
    'chat.empty.placeholder': '把工作交给 Peer，只在真正需要你的时候回来。',
    'chat.empty.suggestionsLabel': '常用任务',
    'chat.empty.suggestion.focus': '帮我定位这个报错并给出可验证的修复',
    'chat.empty.suggestion.todo': '规划一次跨文件改造，并标出回归风险',
    'chat.empty.suggestion.minutes': '把这次调研收成带引用的文档',
    'chat.message.streaming': '生成中...',
    'chat.message.timeline': '思考过程',
    'chat.message.timelineThinking': '正在思考',
    'chat.message.timelineDone': '思考完成',
    'chat.message.confirmRegenerate': '确定重新生成回复吗？当前回复将被替换。',
    'chat.message.confirmShare': '将创建完整会话分享，链接可被他人访问。确定分享吗？',
    'share.title': '分享设置',
    'share.description': '选择分享模式，配置后确认分享。分享链接将自动复制到剪贴板。',
    'share.modeFull': '分享整段对话',
    'share.modeFullDesc': '包含当前会话的所有消息',
    'share.modeSelect': '选择消息分享',
    'share.modeSelectDesc': '勾选要分享的消息',
    'share.modeSelectDisabled': '选择消息分享将在后续版本支持',
    'share.sectionMode': '分享范围',
    'share.sectionAccess': '访问权限',
    'share.accessPublic': '公开访问',
    'share.accessPublicDesc': '任何人通过链接即可查看',
    'share.accessAcl': '人员鉴权',
    'share.accessAclDesc': '仅白名单中的工号可访问',
    'share.aclWhitelist': '允许访问的工号（逗号分隔）',
    'share.aclPlaceholder': '输入工号，多个用逗号分隔，如 246944,351282',
    'share.cancel': '取消',
    'share.confirm': '确认分享',
    'share.creating': '分享中...',
    'share.copied': '分享链接已复制到剪贴板',
    'share.aclPreparing': '正在生成权限...',
    'share.selectionHint': '勾选要分享的消息（已选 {count} 条）',
    'share.confirmSelection': '完成选择',
    'chat.message.confirmBranch': '从此处创建新对话分支？',
    'chat.message.confirmationPending': '等待确认：{title}',
    'chat.message.images': '图片',
    'chat.message.references': '引用',
    'chat.message.data': '结构化数据',
    'chat.message.action.copy': '复制',
    'chat.message.action.copied': '已复制',
    'chat.message.action.regenerate': '重新生成',
    'chat.message.action.branch': '分支',
    'chat.message.action.share': '分享',
    'chat.message.action.truncate': '截断',
    'chat.message.action.delete': '删除',
    'chat.message.action.unsupported': '当前客户端只支持把 prompt 类 action 填入输入框。',
    'chat.message.confirmDelete': '确认删除这条消息？',
    'chat.message.confirmTruncate': '确认删除这条消息之后的所有消息？',
    'chat.message.shareCreated': '已分享：{shareUuid}',
    'chat.message.inspector': '云端消息检查',
    'chat.message.inspectorDetail': '消息详情',
    'chat.message.inspectorTrace': 'Trace',
    'chat.message.inspectorToolCalls': 'Tool Calls',
    'chat.message.inspectorThinking': 'Thinking',
    'chat.message.inspectorContext': '上下文',
    'chat.message.inspectorEmpty': '暂无数据。',
    'chat.timeline.iteration': '第 {iteration} 轮',
    'chat.timeline.toolCount': '{count} 个工具调用',
    'chat.timeline.noContent': '暂无可展开的思考或工具事件。',
    'chat.timeline.toolStdout': 'stdout',
    'chat.timeline.toolStderr': 'stderr',
    'chat.timeline.toolInput': '调用参数',
    'chat.timeline.hydrating': '加载思维链…',
    'chat.tool.localShellExec': '本地 Bash 执行',
    'chat.tool.localShellStop': '停止本地 Bash 任务',
    'chat.skill.using': '正在使用 Skill',
    'chat.skill.used': '已使用 Skill',
    'chat.context.title': '当前会话上下文',
    'chat.context.refresh': '刷新上下文',
    'chat.context.memory': 'Working Memory',
    'chat.context.memoryEmpty': '暂无 Working Memory。',
    'chat.context.wiki': 'Memory Wiki',
    'chat.context.wikiEmpty': '暂无 Memory Wiki 状态。',
    'chat.context.wikiPageCount': '{count} 页',
    'chat.context.wikiInitialize': '初始化',
    'chat.context.wikiPagesEmpty': '暂无 Wiki 页面。',
    'chat.context.billing': 'Billing',
    'chat.context.billingEmpty': '暂无 Billing 摘要。',
    'chat.context.shareTitle': 'Share',
    'chat.context.share': '创建分享',
    'chat.context.shareCreated': '分享已创建：{shareUuid}',
    'chat.context.shareCreateFailed': '创建分享失败：{message}',
    'chat.context.shareEmpty': '暂无分享。',
    'chat.context.shareContinue': '继续',
    'chat.context.shareRevoke': '撤销',
    'chat.localProxy.title': '本地工具执行',
    'chat.localProxy.start': '启动执行通道',
    'chat.localProxy.stop': '停止执行通道',
    'chat.localProxy.poll': '拉取待执行任务',
    'chat.localProxy.idle': '未启动',
    'chat.localProxy.projection': '本地工具面已接入',
    'chat.localProxy.probeContracts': '探测云端合约',
    'chat.localProxy.contractsPassed': '云端合约可用',
    'chat.localProxy.contractsBlocked': '云端合约阻塞：{count} 项',
    'chat.localProxy.contractsUnavailable': '云端合约探测失败',
    'chat.execution.title': '执行检查器',
    'chat.execution.refresh': '刷新执行',
    'chat.execution.empty': '暂无执行事件。',
    'chat.execution.loadingEvidence': '正在加载执行证据...',
    'chat.execution.detail': '执行详情',
    'chat.execution.result': '最终结果',
    'chat.execution.sourceTrace': '来源追踪',
    'chat.execution.relatedShadow': '相关 Shadow',
    'chat.execution.recent': '最近执行',
    'chat.execution.control': '执行控制',
    'chat.execution.cancel': '取消执行',
    'chat.execution.confirmCancel': '确认取消当前云端执行？',
    'chat.execution.cancelResult': '取消请求已发送，signalSent={signalSent}',
    'chat.governance.title': '云端治理',
    'chat.governance.refresh': '刷新治理',
    'chat.governance.access': '访问',
    'chat.governance.spectatorEnable': '开启旁观',
    'chat.governance.spectatorDisable': '关闭旁观',
    'chat.governance.createAuth': '创建权限',
    'chat.governance.authDetail': '权限详情',
    'chat.governance.automations': 'Automation',
    'chat.governance.automationEmpty': '暂无 Automation 会话。',
    'chat.governance.pause': '暂停',
    'chat.governance.resume': '恢复',
    'chat.governance.complete': '完成',
    'chat.governance.recover': '恢复运行',
    'chat.governance.roundtable': '圆桌',
    'chat.governance.roundtablePlaceholder': '向当前圆桌插话...',
    'chat.governance.inject': '插话',
    'chat.governance.evolution': '进化 Patch',
    'chat.governance.evolutionEmpty': '当前消息未发现 Patch。',
    'chat.governance.activatePatch': '激活',
    'chat.governance.rejectPatch': '拒绝',
    'chat.governance.reviewPatch': '转审核',
    'chat.dispatch.title': '派发确认',
    'chat.dispatch.refresh': '刷新派发',
    'chat.dispatch.pending': '待确认',
    'chat.dispatch.subtasks': '子任务',
    'chat.dispatch.decision': '确认',
    'chat.dispatch.empty': '暂无待确认调度。',
    'chat.dispatch.reason': '原因',
    'chat.dispatch.sender': '发起方',
    'chat.dispatch.feedbackPlaceholder': '给云端调度的确认反馈...',
    'chat.dispatch.approve': '同意派发',
    'chat.dispatch.reject': '拒绝派发',
    'chat.dispatch.approved': '已同意派发。',
    'chat.dispatch.rejected': '已拒绝派发。',
    'chat.statistics.title': '聊天统计',
    'chat.statistics.refresh': '刷新统计',
    'chat.statistics.startDate': '开始',
    'chat.statistics.endDate': '结束',
    'chat.statistics.overview': '概览',
    'chat.statistics.trends': '趋势',
    'chat.statistics.toolRanking': '工具排行',
    'chat.statistics.userRanking': '用户排行',
    'chat.statistics.realtime': '实时',
    'chat.statistics.export': '导出快照',
    'chat.statistics.exportFormat': '格式',
    'chat.statistics.exportJson': 'JSON',
    'chat.statistics.exportCsv': 'CSV',
    'chat.statistics.exportSaved': '已保存：{filePath}',
    'chat.statistics.exportCloudReady': '云端导出已生成：{artifact}',
    'chat.statistics.exportCloudFallback': '云端导出不可用，已改用本地快照：{reason}',
    'chat.statistics.exportCloudEmpty': '云端返回为空。',
    'chat.statistics.exportCloudFailed': '云端导出失败。',
    'chat.statistics.exportCancelled': '已取消导出。',
    'chat.statistics.empty': '暂无统计数据。',
    'chat.studio.title': 'Agent Studio',
    'chat.studio.refresh': '刷新 Studio',
    'chat.studio.enterChat': '进入 Chat',
    'chat.studio.channelPlaceholder': '选择 Channel',
    'chat.studio.scene': '场景',
    'chat.studio.events': '事件',
    'chat.studio.channels': 'Channels',
    'chat.studio.sessions': 'Sessions',
    'chat.studio.enterSession': '进入 Session',
    'chat.studio.enterResult': '进入结果',
    'chat.studio.empty': '暂无 Studio 数据。',
    'chat.openclawGovernance.title': 'OpenClaw 治理目录',
    'chat.openclawGovernance.refresh': '刷新目录',
    'chat.openclawGovernance.identityPlaceholder': '选择 Identity Profile',
    'chat.openclawGovernance.catalog': '目录摘要',
    'chat.openclawGovernance.identityProfiles': 'Identity Profiles',
    'chat.openclawGovernance.rolePostures': 'Role Postures',
    'chat.openclawGovernance.unifiedServiceRefs': 'Unified Service Refs',
    'chat.openclawGovernance.capabilityProfiles': 'Capability Profiles',
    'chat.openclawGovernance.memoryPacks': 'Memory Packs',
    'chat.openclawGovernance.seedMemoryPacks': 'Seed Memory Packs',
    'chat.openclawGovernance.memoryBindingPolicies': 'Memory Binding Policies',
    'chat.openclawGovernance.memoryWorkspaces': 'Memory Workspaces',
    'chat.openclawGovernance.memorySnapshots': 'Memory Snapshots',
    'chat.openclawGovernance.memoryTrainingRuns': 'Training Runs',
    'chat.openclawGovernance.trainingScorecards': 'Training Scorecards',
    'chat.openclawGovernance.learningSamples': 'Learning Samples',
    'chat.openclawGovernance.memoryCandidates': 'Memory Candidates',
    'chat.openclawGovernance.peer-agentBackflowExports': 'Peer Agent Backflow',
    'chat.openclawGovernance.modelPolicies': 'Model Policies',
    'chat.openclawGovernance.credentialProfiles': 'Credential Profiles',
    'chat.openclawGovernance.evalSuites': 'Eval Suites',
    'chat.openclawGovernance.simulationEvals': 'Simulation Evals',
    'chat.openclawGovernance.certifications': 'Certifications',
    'chat.openclawGovernance.agentReleases': 'Agent Releases',
    'chat.openclawGovernance.releaseChannels': 'Release Channels',
    'chat.openclawGovernance.onDutyPolicies': 'On Duty Policies',
    'chat.openclawGovernance.schedulePolicies': 'Schedule Policies',
    'chat.openclawGovernance.alertPolicies': 'Alert Policies',
    'chat.openclawGovernance.alertIncidents': 'Alert Incidents',
    'chat.openclawGovernance.remediationPolicies': 'Remediation Policies',
    'chat.openclawGovernance.remediationActions': 'Remediation Actions',
    'chat.openclawGovernance.humanTakeovers': 'Human Takeovers',
    'chat.openclawGovernance.upgradeJobs': 'Upgrade Jobs',
    'chat.openclawGovernance.effectiveConfig': 'Effective Config',
    'chat.openclawGovernance.conversationConfig': '会话治理配置',
    'chat.openclawGovernance.empty': '暂无治理数据。',
    'chat.openclawWriteGate.title': 'OpenClaw 写动作 Gate',
    'chat.openclawWriteGate.boundary': '这些是真实云端 POST 能力，但当前客户端只展示权限矩阵；未完成云端组织策略、Effective Config、操作者确认、审计原因和 Evidence 回传前，不暴露为可执行按钮。',
    'chat.openclawWriteGate.governance': 'Governance 写动作',
    'chat.openclawWriteGate.studio': 'Studio 写动作',
    'chat.openclawWriteGate.risk': '风险',
    'chat.openclawWriteGate.gates': 'Gates',
    'chat.openclawWriteGate.evidence': 'Evidence',
    'chat.openclawWriteGate.blocked': '已禁用',
    'chat.memoryReview.title': 'Agent Memory 审核',
    'chat.memoryReview.refresh': '刷新审核面',
    'chat.memoryReview.boundaryTitle': '认知边界',
    'chat.memoryReview.boundary': '个人经验默认只留在本机；不自动升格为系统指令或共享认知。',
    'chat.memoryReview.patches': '当前 Patch',
    'chat.memoryReview.patchReviewOnly': '仅展示待审核线索；写入云端进化需要单独权限 gate。',
    'chat.memoryReview.candidates': 'Memory Candidates',
    'chat.memoryReview.simulationEvals': 'Simulation Evals',
    'chat.memoryReview.trainingRuns': 'Training Runs',
    'chat.memoryReview.peer-agentBackflow': 'Peer Agent Backflow',
    'chat.memoryReview.relatedShadow': '相关 Shadow',
    'chat.memoryReview.empty': '暂无审核数据。',
    'chat.memoryWriteGate.title': 'Agent Memory 写动作 Gate',
    'chat.memoryWriteGate.boundary': '这些 migration / simulation 接口真实存在，但仅允许预发或本地环境；客户端只展示权限矩阵，不触发执行，也不会把个人经验自动写入云端 Patch。',
    'chat.memoryWriteGate.risk': '风险',
    'chat.memoryWriteGate.gates': 'Gates',
    'chat.memoryWriteGate.evidence': 'Evidence',
    'chat.memoryWriteGate.blocked': '已禁用',
    'chat.observability.title': '云端观测',
    'chat.observability.refresh': '刷新观测',
    'chat.observability.trace': '会话 Trace',
    'chat.observability.latestMessageTrace': '最新消息 Trace',
    'chat.observability.toolCalls': 'Tool Calls',
    'chat.observability.memoryCompile': 'Memory Compile',
    'chat.observability.retryCompile': '重试编译',
    'chat.observability.billingTrend': 'Agent Billing',
    'chat.observability.thinking': 'Thinking',
    'chat.observability.empty': '暂无数据。',
    'chat.confirm.approve': '允许',
    'chat.confirm.reject': '拒绝',
    'chat.agent.default': '默认模型',
    'chat.agent.refresh': '刷新 Agent',
    'chat.composer.placeholder': '继续交代任务或补充信息...',
    'chat.composer.suggest': '建议',
    'chat.composer.complete': '补全',
    'chat.composer.applyCompletion': '应用补全：{text}',
    'chat.composer.send': '发送',
    'chat.role.user': '用户',
    'chat.role.assistant': 'Agent',
    'chat.role.system': '系统',
    'chat.role.tool': '工具',
    'runtime.auth': '认证',
    'runtime.cloud': '云端运行时',
    'runtime.session': '本地会话',
    'runtime.workspace': '当前工作区',
    'runtime.capabilities': '本地能力 Manifest',
    'runtime.projects': '项目索引',
    'runtime.clientId': 'client_id',
    'runtime.endpoint': 'endpoint',
    'runtime.mode': '模式',
    'runtime.mode.prod': '生产',
    'runtime.mode.pre': '预发',
    'runtime.mode.custom': '自定义',
    'runtime.noEndpoint': '未配置 endpoint',
    'runtime.noRuntimeGateway': '未配置 Runtime Gateway',
    'runtime.sessionId': 'session_id',
    'runtime.gitBranch': '分支 {branch}',
    'runtime.gitChanges': '{count} 项变更',
    'runtime.noCapabilities': '没有发现本地能力 Manifest。',
    'runtime.noProjects': '没有发现本地项目。',
    'runtime.projection.publish': '接入本地工具',
    'runtime.projection.publishing': '正在接入',
    'runtime.projection.published': '本地工具已接入',
    'runtime.projection.failed': '本地工具接入失败：{message}',
    'message.assistantWorkSummary': 'Assistant work summary',
    'message.evidenceSummary': 'Evidence summary',
    'message.returnedToCloud': '已返回云端',
    'message.localOnly': '仅本地',
    'review.single': '1 个本地动作需要确认',
    'review.multiple': '{count} 个本地动作需要确认',
    'review.badge': '待确认',
    'review.allow': '允许',
    'review.allowAlways': '一直允许',
    'review.deny': '拒绝',
    'review.morePending': '再 {count} 项',
    'review.returnEvidence': '回传 Evidence',
    'tool.waitingReview': '等待确认',
    'access.cloud_only': '仅云端',
    'access.ask_before_local': '本地执行前询问',
    'access.session_local': '本会话允许本地',
    'access.restricted_local': '受限本地',
    'access.full_local': '完全本地',
    'artifact.evidence.local': 'Evidence 摘要保留在本地，只有明确允许后才会返回云端。',
    'artifact.evidence.returned': 'Evidence 摘要已经返回 Cloud Runtime。',
    'task.pinned.minimalLoop': '端云最小闭环',
    'task.pinned.reviewDesign': 'Review card 设计',
    'updater.badge.upToDate': '已是最新',
    'updater.badge.checking': '检查更新中…',
    'updater.badge.updateAvailable': '有新版本',
    'updater.badge.ariaHasUpdate': '有可用更新，点击查看',
    'updater.badge.downloading': '正在后台下载更新…{percent}%',
    'updater.badge.newVersion': '新版本',
    'updater.badge.install': '安装',
    'updater.badge.ready': '新版本 v{version} 已就绪',
    'updater.modal.title': '发现新版本',
    'updater.modal.checking': '正在检查更新…',
    'updater.modal.newUpdatePill': '新版本',
    'updater.modal.fromVersion': '来自 v{version}',
    'updater.modal.backgroundDownloadHint': '下载在后台进行，完成后用侧边栏 Install 安装。',
    'updater.modal.currentVersion': '当前版本',
    'updater.modal.newVersion': '新版本',
    'updater.modal.releaseNotes': '更新内容',
    'updater.modal.noReleaseNotes': '本次更新暂无详细说明。',
    'updater.modal.update': '更新',
    'updater.modal.later': '稍后',
    'updater.modal.close': '关闭',
    'updater.modal.installing': '正在安装 {version}',
    'updater.modal.installHint': '当前工作已保存。安装完成后将自动重启，通常需要 10–30 秒。',
    'updater.modal.downloading': '正在下载更新…',
    'updater.modal.restartNow': '立即重启安装',
    'updater.modal.openReleasePage': '打开下载页面',
    'updater.modal.upToDate': '当前已是最新版本。',
    'updater.modal.checkAgain': '重新检查',
    'updater.modal.error': '更新出错：{message}',
    'updater.settings.title': '更新',
    'updater.settings.description': '管理 Peer Agent 的更新通道与版本检查。',
    'updater.settings.channel': '更新通道',
    'updater.settings.channel.description': '选择 Beta 体验尝鲜版本，选择正式获取稳定版本。手动选择优先于按版本号自动判断。',
    'updater.settings.channel.auto': '自动（跟随当前版本）',
    'updater.settings.channel.beta': 'Beta（尝鲜版）',
    'updater.settings.channel.stable': '正式（稳定版）',
    'updater.badge.channel.auto': '自动',
    'updater.badge.channel.beta': 'Beta',
    'updater.badge.channel.stable': '正式',
    'updater.settings.currentVersion': '当前版本',
    'updater.settings.checkNow': '检查更新',
    'updater.settings.checking': '检查中…',
    'updater.settings.disabledHint': '开发环境下自动更新已禁用。',
    'updater.settings.help.title': '帮助与链接',
    'updater.settings.help.description': 'GitHub 仓库、反馈入口与发布说明',
    'updater.settings.help.github': 'GitHub',
    'updater.settings.help.feedback': '提交反馈',
    'updater.settings.help.releaseNotes': '发布说明',
    'header.capabilities.label': '能力',
    'header.capabilities.title': '已挂载能力',
    'header.capabilities.group.skill': '技能',
    'header.capabilities.group.mcp': 'MCP',
    'header.capabilities.group.plugin': '插件',
    'header.capabilities.group.builtin': '内置',
    'header.capabilities.builtin.localExecution': '本地执行',
    'header.capabilities.builtin.browserControl': '浏览器操作',
    'header.capabilities.builtin.webAccess': '网页访问',
    'header.capabilities.empty': '暂无已挂载的能力',
    'header.capabilities.manage': '管理',
    'header.capabilities.toolCount': '{count} 个工具',
    'header.capabilities.aria': '已挂载 {count} 项能力',
    'header.capabilities.status.available': '可用',
    'header.capabilities.status.needsAuth': '调用前询问',
    'header.capabilities.status.disabled': '已停用',
    'header.capabilities.status.unavailable': '不可用',
  },
  'en-US': {
    "projectAgent.chat.taskFallback": "that task",
    "projectAgent.chat.inputTooLong": "Messages support up to 100000 UTF-16 units. Shorten the draft before sending.",
    "projectAgent.quick.title": "Quick Chat",
    "projectAgent.quick.content": "Quick Chat message",
    "projectAgent.quick.placeholder": "Ask Peer Agent to help…",
    "projectAgent.quick.chooseBot": "Choose bot",
    "projectAgent.quick.noBots": "No bots yet",
    "projectAgent.quick.textOnly": "Bot Quick Chat currently supports text only",
    "projectAgent.quick.empty": "Write a message first",
    "projectAgent.quick.workspace": "Choose workspace",
    "projectAgent.quick.attach": "Add attachment",
    "projectAgent.quick.attachmentLimit": "Add up to {count} attachments",
    "projectAgent.quick.imageLimit": "Image {name} exceeds 8 MB",
    "projectAgent.quick.fileLimit": "File {name} exceeds 512 KB",
    "projectAgent.quick.sending": "Sending",
    "projectAgent.quick.failed": "Send failed",
    "projectAgent.background.title": "Background runs",
    "projectAgent.background.device": "This device",
    "projectAgent.background.close": "Close",
    "projectAgent.background.readFailed": "Unable to read background runs",
    "projectAgent.background.previous": " · Previous snapshot",
    "projectAgent.background.retry": "Retry",
    "projectAgent.background.loading": "Loading…",
    "projectAgent.background.unavailable": "Run record unavailable",
    "projectAgent.background.empty": "No background runs",
    "projectAgent.background.history": "Recently ended",
    "projectAgent.background.more": "Show more",
    "projectAgent.background.refresh": "Refresh status",
    "projectAgent.settings.quietStart": "Quiet hours start",
    "projectAgent.settings.quietEnd": "Quiet hours end",
    "projectAgent.settings.hour": "{label}: hour",
    "projectAgent.settings.minute": "{label}: minute",

    ...remoteAccessEn,
    'app.newTask': 'New task',
    'searchChats.open': 'Search tasks',
    'searchChats.placeholder': 'Search tasks',
    'searchChats.section.chats': 'Tasks',
    'searchChats.section.suggested': 'Suggested',
    'searchChats.workspace.current': 'Current workspace',
    'searchChats.workspace.unassigned': 'Unassigned workspace',
    'searchChats.empty': 'No tasks found',
    'searchChats.untitled': 'Untitled',
    'searchChats.newTask': 'New task',
    'searchChats.shortcut': '⌘K',
    'app.search': 'Search',
    'app.plugins': 'Plugins',
    'app.agents': 'Agents',
    'app.automations': 'Automations',
    'app.pinned': 'Pinned',
    'app.projects': 'Projects',
    'app.settings': 'Settings',
    'app.run': 'Run',
    'app.open': 'Open',
    'app.workspaceFallback': 'current workspace',
    'account.personal': 'Personal account',
    'account.usageRemaining': 'Usage remaining',
    'appearance.title': 'Appearance',
    'appearance.subtitle': 'Adjust workspace themes, fonts, and contrast.',
    'appearance.mode': 'Theme mode',
    'appearance.mode.light': 'Light',
    'appearance.mode.dark': 'Dark',
    'appearance.mode.system': 'System',
    'appearance.palette': 'Palette',
    'appearance.quick': 'Quick appearance switch',
    'appearance.quick.black': 'Black',
    'appearance.quick.white': 'White',
    'appearance.swatches': 'Palette colors',
    'appearance.codePreview': 'Code preview',
    'appearance.editTheme': 'Edit theme',
    'appearance.scheme.light': 'Light theme',
    'appearance.scheme.dark': 'Dark theme',
    'appearance.import': 'Import',
    'appearance.copy': 'Copy',
    'appearance.copied': 'Copied',
    'appearance.copyFallback': 'Copy this theme configuration:',
    'appearance.importPrompt': 'Paste theme configuration JSON',
    'appearance.importFailed': 'Invalid theme configuration.',
    'appearance.preset': 'Preset',
    'appearance.custom': 'Custom',
    'appearance.accent': 'Accent',
    'appearance.background': 'Background',
    'appearance.foreground': 'Foreground',
    'appearance.uiFont': 'UI font',
    'appearance.codeFont': 'Code font',
    'appearance.diffMarker': 'Diff markers',
    'appearance.diffMarker.color': 'Color',
    'appearance.diffMarker.sign': '+/- signs',
    'appearance.translucentSidebar': 'Translucent sidebar',
    'appearance.contrast': 'Contrast',
    'appearance.fontScale': 'Interface font size',
    'appearance.fontScale.small': 'Small',
    'appearance.fontScale.medium': 'Medium',
    'appearance.fontScale.large': 'Large',
    'appearance.preview': 'Live preview',
    'appearance.diffPreview': 'Diff preview',
    'appearance.deriveCustom': 'Customize from this',
    'appearance.settingsList': 'Interface & code',
    'appearance.reset': 'Reset appearance',
    'appearance.language': 'Language',
    'settings.search': 'Search settings…',
    'settings.searchEmpty': 'No matching settings',
    'settings.general': 'General',
    'settings.shell.title': 'Interface',
    'settings.shell.description': 'Switching takes effect immediately and leaves existing chats in place.',
    'settings.shell.bots': 'Bot list',
    'settings.shell.classic': 'Classic',
    'settings.archived': 'Archived chats',
    'settings.archived.description': 'View and manage archived chats in the current workspace.',
    'settings.archived.loading': 'Loading archived chats…',
    'settings.archived.empty': 'No archived chats',
    'settings.archived.emptyDescription': 'Chats will appear here after you archive them.',
    'settings.archived.loadFailed': 'Failed to load archived chats. Please try again.',
    'settings.archived.actionFailed': 'The action failed. Please try again.',
    'settings.archived.messageCount': '{count} messages',
    'settings.archived.date': 'Archived {date}',
    'settings.archived.restore': 'Restore',
    'settings.archived.delete': 'Delete',
    'settings.archived.deleteTitle': 'Delete archived chat',
    'settings.archived.confirmDelete': 'Permanently delete “{title}”? This action cannot be undone.',
    'settings.archived.working': 'Working…',
    'settings.backToChat': 'Back to chat',
    'settings.appearance.description': 'Choose light, dark, or follow system preference.',
    'settings.language.description': 'The language used in menus, buttons and settings.',
    'settings.general.description': 'Make Peer work the way you do.',
    'settings.general.loadFailed': 'Could not load current settings. Please reopen Settings.',
    'settings.general.interfaceAndLanguage': 'Interface & language',
    'settings.general.interfaceAndLanguage.description': 'Choose a familiar starting point and language.',
    'settings.replyLanguage': 'Reply language',
    'settings.bots.title': 'Notifications & rhythm',
    'settings.bots.description': 'Hear from Peer when you are needed; let it work quietly otherwise.',
    'settings.bots.proactivity': 'How often to speak up',
    'settings.bots.proactivity.description': 'Choose how often bots report progress and follow up.',
    'settings.bots.proactivity.quiet': 'Quiet',
    'settings.bots.proactivity.low': 'Low',
    'settings.bots.proactivity.standard': 'Standard',
    'settings.bots.proactivity.high': 'High',
    'settings.bots.quietHours': 'Quiet hours',
    'settings.bots.quietHours.description': 'During these hours, notifications become unread messages unless something needs you.',
    'settings.bots.quietFrom': 'From',
    'settings.bots.quietUntil': 'Until',
    'settings.bots.digestTime': 'Daily summary',
    'settings.bots.digestTime.description': 'At this time, held notes become one message.',
    'settings.replyLanguage.description': 'The language bots use when talking with you.',
    'settings.replyLanguage.followInterface': 'Follow interface language',
    'settings.replyLanguage.auto': 'Auto (match the question)',
    'settings.replyLanguage.autoShort': 'Match the question',
    'settings.git': 'Git',
    'settings.git.branchNaming': 'Branch naming',
    'settings.git.branchPrefix': 'Branch prefix',
    'settings.git.branchPrefix.description': 'Name prefix used when the agent creates Git branches, e.g. PeerAgent/.',
    'settings.fallbackVision': 'Fallback vision model',
    'settings.fallbackVision.description': 'When the main model cannot read images, use this model to recognize new images in the current turn and silently pass text to the main model. If unset, images are stripped with a light notice.',
    'settings.fallbackVision.none': 'None (strip images only)',
    'settings.fallbackVision.strippedHint': 'Current model does not support images; new images were stripped. Configure a fallback vision model in Settings → Models.',
    'settings.config': 'Configuration',
    'settings.config.description': 'Export your skills, permission rules and UI settings to restore on another device. Login state and device identity are not exported.',
    'settings.config.export': 'Export',
    'settings.config.import': 'Import',
    'settings.config.exported': 'Exported {count} item(s) to {dir}',
    'settings.config.imported': 'Imported {count} item(s); restart to apply',
    'settings.config.canceled': 'Canceled',
    'settings.config.failed': 'Operation failed',
    'settings.usage': 'Usage',
    'settings.usage.description': 'Aggregate token usage across conversations and estimate cost from current model prices. Heatmap and trend use the request log (starts after logging was enabled).',
    'settings.usage.loading': 'Loading…',
    'settings.usage.refresh': 'Refresh',
    'settings.usage.loadFailed': 'Failed to load usage stats',
    'settings.usage.totalTokens': 'Total tokens',
    'settings.usage.estimatedCost': 'Estimated cost',
    'settings.usage.conversations': 'Conversations',
    'settings.usage.inputTokens': 'Input tokens',
    'settings.usage.outputTokens': 'Output tokens',
    'settings.usage.cacheTokens': 'Cache tokens',
    'settings.usage.cacheSplit': 'read {read} · write {write}',
    'settings.usage.note': 'Cost is estimated from the model currently bound to each conversation (USD / 1M tokens). After a model switch, historical usage is re-priced with the current rates.',
    'settings.usage.unpricedNote': '{count} conversation(s) lack pricing and are excluded from cost totals.',
    'settings.usage.byProvider': 'By provider',
    'settings.usage.byModel': 'By model',
    'settings.usage.byRole': 'By role',
    'settings.usage.showByRole': 'View by role',
    'settings.usage.col.role': 'Role',
    'modelRouting.nav': 'Model routing',
    'modelRouting.title': 'Model routing',
    'modelRouting.description': 'Choose a tier or a specific model for each kind of work. Ordinary chat still uses the model selected in the conversation.',
    'modelRouting.singleModel': 'When only one model is available, every kind of work uses it',
    'modelRouting.noModel': 'No usable model',
    'modelRouting.tiers': 'Tiers',
    'modelRouting.roles': 'Roles',
    'modelRouting.primary': 'Primary',
    'modelRouting.fallbacks': 'Fallbacks',
    'modelRouting.addFallback': 'Add fallback',
    'modelRouting.moveUp': 'Move up',
    'modelRouting.moveDown': 'Move down',
    'modelRouting.remove': 'Remove',
    'modelRouting.mode.tier': 'Follow tier',
    'modelRouting.mode.fixed': 'Fixed model',
    'modelRouting.mode.auto': 'Automatic',
    'modelRouting.pool': 'Pool',
    'modelRouting.poolInvalid': 'An automatic pool needs at least one model that meets the role.',
    'modelRouting.resolved': 'Resolved',
    'modelRouting.unresolved': 'No usable model',
    'modelRouting.preferDifferentFamily': 'Prefer a different family for verification',
    'modelRouting.spendCap': 'Daily spend cap (USD)',
    'modelRouting.spendExceeded': 'This role has reached its daily spend cap',
    'modelRouting.essentialSpend': 'Over today’s cap. This work still continues, and you will be asked when it needs you',
    'modelRouting.tier.strong': 'Strong',
    'modelRouting.tier.fast': 'Fast',
    'modelRouting.tier.economy': 'Economy',
    'modelRouting.tier.vision': 'Vision',
    'modelRouting.role.project_agent': 'Project agent',
    'modelRouting.role.session_worker': 'Task worker',
    'modelRouting.role.explorer': 'Explorer',
    'modelRouting.role.verifier': 'Verifier',
    'modelRouting.role.visual_verifier': 'Visual review',
    'modelRouting.role.memory_curator': 'Memory curator',
    'modelRouting.role.objective_probe': 'Objective probe',
    'modelRouting.role.compactor': 'Compactor',
    'modelRouting.reason.vision': 'Cannot see images',
    'modelRouting.reason.tools': 'Cannot use tools',
    'modelRouting.reason.structured': 'Cannot return structured output',
    'modelRouting.reason.context': 'Context window is too short',
    'modelRouting.loadFailed': 'Could not load model routing',
    'modelRouting.saveFailed': 'Could not save model routing',
    'settings.usage.emptyGroup': 'No grouped usage yet',
    'settings.usage.col.provider': 'Provider',
    'settings.usage.col.model': 'Model',
    'settings.usage.col.conversations': 'Chats',
    'settings.usage.col.input': 'Input',
    'settings.usage.col.output': 'Output',
    'settings.usage.col.cacheRead': 'Cache read',
    'settings.usage.col.cacheWrite': 'Cache write',
    'settings.usage.col.total': 'Total',
    'settings.usage.col.cost': 'Est. cost',
    'settings.usage.range': 'Range',
    'settings.usage.range.7d': '7 days',
    'settings.usage.range.1m': '1 month',
    'settings.usage.range.3m': '3 months',
    'settings.usage.range.6m': '6 months',
    'settings.usage.range.1y': '1 year',
    'settings.usage.heatmap': 'Token heatmap',
    'settings.usage.heatmap.note': 'Daily tokens from the request log (only after logging was enabled)',
    'settings.usage.heatmap.empty': 'No request log yet. Send a message to start daily accumulation.',
    'settings.usage.heatmap.less': 'Less',
    'settings.usage.heatmap.more': 'More',
    'settings.usage.trend': 'Usage trend',
    'settings.usage.daily.totalTokens': 'Range tokens',
    'settings.usage.daily.requests': 'Requests',
    'settings.usage.daily.activeDays': 'Active days',
    'settings.usage.dayDetail': 'Day detail',
    'settings.usage.dayDetail.close': 'Close detail',
    'settings.usage.dayDetail.hint': 'Click a day in the heatmap or trend chart to see that day\'s per-model breakdown and hourly distribution.',
    'settings.usage.dayDetail.models': 'By model',
    'settings.usage.dayDetail.hours': '24-hour distribution',
    'settings.usage.dayDetail.hour': ':00',
    'settings.usage.dayDetail.empty': 'No usage recorded on this day (request log starts once connected).',
    'settings.usage.col.requests': 'Requests',
    'auth.login': 'Sign in',
    'auth.logout': 'Sign out',
    'auth.not_configured': 'Auth not configured',
    'auth.signed_out': 'Signed out',
    'auth.signing_in': 'Signing in',
    'auth.authenticated': 'Signed in',
    'auth.error': 'Auth error',
    'auth.loginFailed': 'Sign-in failed: {message}',
    'auth.cancelLogin': 'Cancel sign-in',
    'auth.permissionHint': 'Sign-in opened in your browser. If access is denied, follow the prompts to request permission, then come back and retry.',
    'developer.title': 'Developer mode',
    'developer.subtitle': 'Switch request targets and inspect auth diagnostics',
    'developer.currentMode': 'Current environment',
    'developer.enable': 'Enable developer mode',
    'developer.cloudMode': 'Service environment',
    'developer.gatewayUrl': 'HTTP API URL',
    'developer.streamUrl': 'SSE Stream URL',
    'developer.runtimeGatewayUrl': 'Runtime Gateway WS URL',
    'developer.auth': 'Auth',
    'developer.bucEnv': 'BUC environment',
    'developer.lastRequest': 'Last request',
    'developer.probe': 'Probe',
    'developer.apply': 'Apply',
    'developer.reset': 'Reset',
    'developer.saving': 'Saving',
    'developer.probing': 'Probing',
    'developer.loadFailed': 'Failed to load developer settings',
    'developer.saveFailed': 'Failed to save developer settings',
    'developer.probeFailed': 'Cloud contract probe failed',
    'developer.ipcUnavailable': 'Developer mode IPC is not registered in the main process. Fully quit and restart the desktop client so the updated Electron main process is running.',
    'projectAgent.host.title': "Execution host",
    'projectAgent.host.hint': "Desktop and terminal share this bot. Takeover stops the old host before desktop continues its tasks.",
    'projectAgent.host.action': "Take over on desktop",
    'projectAgent.host.requested': "Takeover requested. Tasks continue after the old host stops.",
    'projectAgent.host.ready': "Desktop can now host this bot.",
    'projectAgent.host.failed': "Takeover failed. Check the bot and its host.",
    'developer.projectAgent.nav': 'Developer',
    'developer.projectAgent.title': 'Developer',
    'developer.projectAgent.description': 'Choose the interface in Settings → General. The old project-agent switch is no longer read, and its stored value stays.',
    'developer.projectAgent.switch': 'Choose the interface in Settings → General. The project agent keeps working on existing tasks.',
    'developer.projectAgent.diagnostics': 'Project agent diagnostics',
    'developer.projectAgent.inactive': 'Not enabled',
    'developer.diagnostics.description': 'Read-only runtime snapshot. Identifiers and text retain only length and hash; project paths are anonymized. Keeps the latest 200 events and 20 turns per bot. Older turn timing is unknown.',
    'developer.diagnostics.refresh': 'Refresh diagnostics',
    'developer.diagnostics.export': 'Export JSON',
    'developer.diagnostics.busy': 'Reading diagnostics…',
    'developer.diagnostics.saved': 'Diagnostics exported',
    'developer.diagnostics.cancelled': 'Export cancelled',
    'developer.diagnostics.failed': 'Could not read or export diagnostics. Try again.',
    'developer.diagnostics.unknown': 'Unknown',
    'developer.diagnostics.generated': 'Snapshot time',
    'developer.diagnostics.bots': 'Bots',
    'developer.diagnostics.slots': 'Active turn slots',
    'developer.diagnostics.waiting': 'Waiting turns',
    'developer.diagnostics.errors': 'Unavailable sources',
    'developer.diagnostics.preview': 'View redacted JSON',
    'projectAgent.list.brand': 'Peer',
    'projectAgent.list.newBot': 'New bot',
    'projectAgent.list.searchPlaceholder': 'Search bots, messages, tasks',
    'projectAgent.list.needsYou': 'Needs you {count}',
    'projectAgent.list.empty': 'No bots yet',
    'projectAgent.list.emptyHint': 'Use + to bind a folder, or create a blank bot.',
    'projectAgent.list.emptyNeedsYou': 'Nothing needs you right now.',
    'projectAgent.list.emptySearch': 'No matching bots.',
    'projectAgent.list.me': 'Me',
    'projectAgent.list.settings': 'Settings',
    'projectAgent.list.automations': 'Automations',
    'projectAgent.list.capabilities': 'Capabilities',
    'projectAgent.list.capabilitiesHint': 'Plugins, skills, and MCP',
    'projectAgent.list.history': 'History',
    'projectAgent.shell.classicNotice': 'Switch to the bot list to view this',
    'projectAgent.shell.banner': 'This is the new bot list. Older chats are in each bot’s profile → tasks → history. Switch back from Settings → General.',
    'projectAgent.shell.bannerTitle': 'New bot list',
    'projectAgent.shell.bannerWhere': 'Older chats are in each bot’s profile',
    'projectAgent.shell.bannerPath': 'Tasks → History',
    'projectAgent.shell.bannerSwitch': 'Settings → General switches back',
    'projectAgent.shell.bannerDismiss': 'Got it',
    'projectAgent.onboarding.connectTitle': 'Connect a model first',
    'projectAgent.onboarding.connectBody': 'A bot needs a model before it can start.',
    'projectAgent.onboarding.connectAction': 'Connect a model',
    'projectAgent.onboarding.createTitle': 'New bot',
    'projectAgent.onboarding.createBody': 'Bind a folder, or create a blank bot.',
    'projectAgent.onboarding.createAction': 'New bot',
    'projectAgent.search.placeholder': 'Search bots, messages, tasks, and memory',
    'projectAgent.search.empty': 'No matches',
    'projectAgent.search.section.bots': 'Bots',
    'projectAgent.search.section.messages': 'Messages',
    'projectAgent.search.section.tasks': 'Tasks',
    'projectAgent.search.section.memory': 'Memory',
    'projectAgent.list.loading': 'Loading bots',
    'projectAgent.list.unavailable': 'Project agent is off',
    'projectAgent.list.loadFailed': 'The bot list did not load',
    'projectAgent.list.noPreview': 'No messages yet',
    'projectAgent.list.mainEmptyTitle': 'Start with a project',
    'projectAgent.list.mainEmptyBody': 'Choose a bot to continue a conversation or assign a new task.',
    'projectAgent.list.recentBots': 'Recent bots',
    'projectAgent.list.openBot': 'Open conversation',
    'projectAgent.list.mainPlaceholder': 'The conversation with this bot will show up here.',
    'projectAgent.list.profile': 'Profile',
    'projectAgent.list.unread': 'Unread',
    'projectAgent.list.running': 'In progress',
    'projectAgent.list.needsYouBadge': 'Needs you {count}',
    'projectAgent.list.newSheetTitle': 'New bot',
    'projectAgent.list.bindFolder': 'Choose a folder',
    'projectAgent.list.bindFolderHint': 'Bind an existing project. The bot will familiarize itself by reading only.',
    'projectAgent.list.blankBot': 'Blank bot',
    'projectAgent.list.blankBotHint': 'Type a name to create an empty project in the managed folder.',
    'projectAgent.list.namePlaceholder': 'Bot name',
    'projectAgent.list.nameInvalid': 'This name cannot be used',
    'projectAgent.list.nameWillUse': 'Will use “{name}”',
    'projectAgent.list.create': 'Create',
    'projectAgent.list.creating': 'Creating',
    'projectAgent.list.createFailed': 'Could not create it',
    'projectAgent.list.nameExhausted': 'Too many folders already use this name',
    'projectAgent.list.columnResize': 'Resize the bot list',
    'projectAgent.list.backToBots': 'Back to bots',
    'projectAgent.list.close': 'Close',
    'projectAgent.chat.empty': 'No messages yet. Say something and the bot will continue.',
    'projectAgent.chat.loadFailed': 'The conversation did not load',
    'projectAgent.chat.thinking': 'Thinking…',
    'projectAgent.chat.waiting': 'Waiting for a response…',
    'projectAgent.chat.generating': 'Generating a response',
    'projectAgent.chat.toolLabel.read': 'file reading',
    'projectAgent.chat.toolLabel.search': 'project search',
    'projectAgent.chat.toolLabel.edit': 'file editing',
    'projectAgent.chat.toolLabel.command': 'command execution',
    'projectAgent.chat.toolRunning': 'Running {tool}',
    'projectAgent.chat.toolDone': '{tool} finished',
    'projectAgent.chat.toolFailed': '{tool} did not complete',
    'projectAgent.chat.stop': 'Stop generating',
    'projectAgent.chat.stopHint': 'Stop this response; dispatched tasks keep running',
    'projectAgent.chat.stopping': 'Stopping',
    'projectAgent.chat.stopped': 'Generation stopped. The content above is incomplete.',
    'projectAgent.chat.stopFailed': 'Could not stop. Please try again.',
    'projectAgent.chat.latest': 'Jump to latest message',
    'projectAgent.chat.received': 'Received',
    'projectAgent.chat.loadOlder': 'Earlier messages',
    'projectAgent.chat.loadingOlder': 'Loading earlier messages',
    'projectAgent.chat.olderFailed': 'Load failed, retry',
    'projectAgent.chat.sending': 'Sending',
    'projectAgent.chat.failed': 'Not sent',
    'projectAgent.chat.retry': 'Retry',
    'projectAgent.chat.replied': 'Replied',
    'projectAgent.chat.disposition.answered': 'Answered',
    'projectAgent.chat.disposition.merged': 'Merged',
    'projectAgent.chat.disposition.stopped': 'Stopped',
    'projectAgent.chat.disposition.superseded': 'Replaced',
    'projectAgent.chat.disposition.parallel': 'In parallel',
    'projectAgent.chat.disposition.queued': 'Queued',
    'projectAgent.chat.disposition.outOfScope': 'This message was about “{title}” and did not affect the others',
    'projectAgent.chat.quote': 'Quote',
    'projectAgent.chat.quoteRemove': 'Remove quote',
    'projectAgent.chat.placeholder': 'Message this bot',
    'projectAgent.chat.attach': 'Attach files or images',
    'projectAgent.chat.previewAttachment': 'Preview image',
    'projectAgent.chat.removeAttachment': 'Remove attachment',
    'projectAgent.chat.attachmentMetadataOnly': 'File information only · content not read',
    'projectAgent.chat.readingAttachments': 'Reading attachments…',
    'projectAgent.chat.dropAttachments': 'Drop to attach files or images',
    'projectAgent.chat.send': 'Send',
    'projectAgent.chat.hint': 'Enter to send, Shift+Enter for a new line',
    'projectAgent.chat.source': 'Source',
    'projectAgent.chat.evidence': 'Evidence',
    'projectAgent.chat.evidenceMore': '{count} more evidence records',
    'projectAgent.chat.evidenceCollapse': 'Collapse evidence',
    'projectAgent.chat.process': 'Process',
    'projectAgent.chat.chooseAnswer': 'Choose an answer, or type your own',
    'projectAgent.chat.you': 'You',
    'projectAgent.process.reply': 'Send reply',
    'projectAgent.process.sessions': 'Find work sessions',
    'projectAgent.process.session': 'Read work session',
    'projectAgent.process.start': 'Create work task',
    'projectAgent.process.resume': 'Resume work task',
    'projectAgent.process.cancel': 'Cancel work task',
    'projectAgent.process.update': 'Update work settings',
    'projectAgent.process.verification': 'Check verification',
    'projectAgent.process.memory': 'Manage project memory',
    'projectAgent.process.objective': 'Manage project objective',
    'projectAgent.process.tool': 'Call tool',
    'projectAgent.process.runningTitle': 'Running · {tool}',
    'projectAgent.process.preparingTitle': 'Preparing · {tool}',
    'projectAgent.process.organizing': 'Preparing the reply',
    'projectAgent.process.preparingReply': 'Preparing a response',
    'projectAgent.process.preparing': 'Preparing',
    'projectAgent.process.running': 'Running',
    'projectAgent.process.stopped': 'Stopped',
    'projectAgent.process.awaitingContent': 'The model has not returned visible content yet. Execution steps will appear here.',
    'projectAgent.process.receiving': 'Receiving arguments · {count} characters',
    'projectAgent.process.preparingNote': 'Arguments are being generated. Execution has not started.',
    'projectAgent.process.runningNote': 'The call is running. Its returned content will appear here when available.',
    'projectAgent.process.parameters': 'Arguments',
    'projectAgent.process.output': 'Returned content',
    'projectAgent.process.truncated': 'Truncated',
    'projectAgent.process.redacted': 'Redacted',
    'projectAgent.process.previewLimit': 'Content exceeds the preview limit.',
    'projectAgent.process.seconds': '{seconds}s',
    'projectAgent.process.minutes': '{minutes}m {seconds}s',
    'projectAgent.process.done': 'Finished',
    'projectAgent.process.failed': 'Did not complete',
    'projectAgent.process.suppressed': 'Not delivered',
    'projectAgent.process.unknown': 'Status not recorded',
    'projectAgent.process.sent': 'Sent',
    'projectAgent.process.count': 'Returned {count} records',
    'projectAgent.process.technical': 'Technical details',
    'projectAgent.process.input': 'Arguments (up to 12,000 characters)',
    'projectAgent.process.result': 'Returned record (up to 12,000 characters)',
    'projectAgent.process.empty': 'No process record is available for this turn',
    'projectAgent.chat.openProcess': 'View process',
    'projectAgent.chat.memoryUsed': 'Used {count} memories',
    'projectAgent.chat.memoryLearned': 'Remembered {count} new',
    'projectAgent.chat.digest': 'Daily digest',
    'projectAgent.chat.today': 'Today {time}',
    'projectAgent.chat.earlierDay': '{date} {time}',
    'projectAgent.chat.replyTo': 'Reply',
    'projectAgent.chat.sessionState.paused': 'Paused',
    'projectAgent.chat.sessionState.queued': 'Queued',
    'projectAgent.chat.sessionState.starting': 'Starting',
    'projectAgent.chat.work.heading': 'Related work',
    'projectAgent.chat.work.more': '{count} more tasks',
    'projectAgent.chat.work.related': 'Related task',
    'projectAgent.chat.work.unavailable': 'Status unavailable',
    'projectAgent.chat.work.unavailableHint': 'The latest status is unavailable. Open the task to check.',
    'projectAgent.chat.work.handle': 'Review and respond',
    'projectAgent.chat.work.open': 'Open task',
    'projectAgent.chat.work.background': '{count} tasks to follow up',
    'projectAgent.chat.context.basis': 'Result basis · {count} records',
    'projectAgent.chat.originalMessage': 'View original message',
    'projectAgent.chat.context.details': 'Reply details',
    'projectAgent.chat.context.memoryUnavailable': 'The related memories are unavailable.',
    'projectAgent.drawer.inspectBack': 'Back to bot profile',
    'projectAgent.drawer.evidenceUnavailable': 'This evidence is unavailable.',
    'projectAgent.drawer.botDescription': 'Coordinates work for this project, follows up on tasks and brings back results.',
    'projectAgent.drawer.acceptance.confirm': 'Your confirmation',
    'projectAgent.drawer.memory.details': 'Memory details',
    'projectAgent.chat.sessionState.running': 'Running',
    'projectAgent.chat.sessionState.waiting_user': 'Needs your input',
    'projectAgent.chat.sessionState.verifying': 'Verifying',
    'projectAgent.chat.sessionState.result_ready': 'Awaiting your confirmation',
    'projectAgent.chat.sessionState.accepted': 'Accepted',
    'projectAgent.chat.sessionState.failed': 'Failed',
    'projectAgent.chat.sessionState.cancelled': 'Cancelled',
    'projectAgent.chat.sessionState.superseded': 'Superseded',
    'projectAgent.chat.verdict.passed': 'Verdict: verified',
    'projectAgent.chat.verdict.failed': 'Verdict: failed',
    'projectAgent.chat.verdict.partial': 'Verdict: partial',
    'projectAgent.chat.verdict.unverifiable': 'Verdict: unverifiable',
    'projectAgent.chat.surfacingLabel': 'Delivery: ',
    'projectAgent.chat.surfacing.interrupt': 'Immediate',
    'projectAgent.chat.surfacing.message': 'Show in the chat',
    'projectAgent.chat.surfacing.digest': 'Keep for the digest',
    'projectAgent.chat.surfacing.silent': 'Stay quiet',
    'projectAgent.chat.approve': 'Approve',
    'projectAgent.chat.allowOnce': 'Allow',
    'projectAgent.chat.allowTask': 'Allow for this task',
    'projectAgent.chat.approveContinue': 'Approve and continue',
    'projectAgent.chat.reject': 'Reject',
    'projectAgent.chat.answer': 'Answer',
    'projectAgent.policy.planApproval': 'Approve plans before starting',
    'projectAgent.policy.planApproval.never': 'Start directly',
    'projectAgent.policy.planApproval.writes': 'Approve write tasks',
    'projectAgent.policy.planApproval.always': 'Approve every task',
    'projectAgent.policy.acceptance.auto': 'Accept eligible results automatically',
    'projectAgent.policy.acceptance.confirm': 'I confirm results',
    'projectAgent.policy.models': 'Bot models',
    'projectAgent.model.defaults': 'Defaults and tiers',
    'projectAgent.model.botOnly': 'This bot',
    'projectAgent.model.nextReply': 'Applies to future replies or new tasks',
    'projectAgent.model.runningReply': 'Model used by the current reply',
    'projectAgent.model.unavailable': 'Choose model',
    'projectAgent.model.select': 'Choose bot model',
    'projectAgent.model.noEffort': 'No adjustable effort',
    'projectAgent.model.saveFailed': 'Model settings were not saved. Please retry.',
    'projectAgent.policy.modelsHint': 'Choose this bot’s model and reasoning effort directly. Conversation changes apply to future replies; task changes apply to new tasks.',
    'projectAgent.policy.inherit': 'Use global routing',
    'projectAgent.policy.autoPool': 'Configured automatic pool',
    'projectAgent.policy.moreRoles': 'More roles',
    'projectAgent.policy.fewerRoles': 'Fewer roles',
    'projectAgent.policy.scope': 'Allowed models',
    'projectAgent.policy.scope.all': 'All configured models',
    'projectAgent.policy.scope.restricted': 'Selected models only',
    'projectAgent.policy.localOnly': 'Use local models only',
    'projectAgent.chat.confirmResult': 'Confirm result',
    'projectAgent.chat.acceptReadme': 'Write README',
    'projectAgent.chat.actionFailed': 'Action failed. Please try again',
    'projectAgent.drawer.title': 'Profile',
    'projectAgent.drawer.close': 'Close',
    'projectAgent.drawer.back': 'Back to tasks',
    'projectAgent.drawer.missing': 'None yet',
    'projectAgent.drawer.tab.overview': 'Overview',
    'projectAgent.drawer.tab.tasks': 'Tasks',
    'projectAgent.drawer.tab.objectives': 'Objectives',
    'projectAgent.drawer.tab.memory': 'Memory',
    'projectAgent.drawer.tab.settings': 'Settings',
    'projectAgent.drawer.folder': 'Bound folder',
    'projectAgent.drawer.noPath': 'No folder yet',
    'projectAgent.drawer.reveal': 'Show in Finder',
    'projectAgent.drawer.brief': 'Project brief',
    'projectAgent.drawer.briefEmpty': 'No project brief yet',
    'projectAgent.drawer.running': 'Tasks in progress',
    'projectAgent.drawer.runningEmpty': 'Nothing is in progress',
    'projectAgent.drawer.acceptance': 'Sign-off',
    'projectAgent.drawer.acceptance.auto': 'Automatic',
    'projectAgent.drawer.acceptance.pending': 'Sign-off does not have its own save path yet. It stays automatic.',
    'projectAgent.drawer.model': 'Conversation model',
    'projectAgent.drawer.modelEmpty': 'Follow the global routing',
    'projectAgent.drawer.model.pending': 'A per-project model scope does not have its own save path yet. This shows the global conversation model.',
    'projectAgent.drawer.tasksEmpty': 'No tasks yet',
    'projectAgent.drawer.showAll': 'Show all',
    'projectAgent.drawer.collapse': 'Show less',
    'projectAgent.drawer.group.needsYou': 'Needs you',
    'projectAgent.drawer.group.running': 'In progress',
    'projectAgent.drawer.group.queued': 'Queued',
    'projectAgent.drawer.group.done': 'Done',
    'projectAgent.drawer.group.paused': 'Paused',
    'projectAgent.drawer.supersededBy': 'Replaced by “{task}”',
    'projectAgent.drawer.resume': 'Resume',
    'projectAgent.drawer.resumeFailed': 'Could not resume. Please retry.',
    'projectAgent.drawer.replacement': 'a later task',
    'projectAgent.drawer.group.history': 'History',
    'projectAgent.drawer.group.classic': 'Classic tasks',
    'projectAgent.drawer.historyEmpty': 'No history to continue',
    'projectAgent.drawer.continueHistory': 'Hand this to the bot',
    'projectAgent.drawer.historyPartial': 'This chat has tool or attachment material that will not come along. Hand it to the bot anyway?',
    'projectAgent.drawer.historyPartialConfirm': 'Continue anyway',
    'projectAgent.drawer.historyPickBot': 'Choose a bot',
    'projectAgent.drawer.classicOpen': 'Open the original conversation',
    'projectAgent.drawer.legacyAutomations': 'Automations (legacy)',
    'projectAgent.drawer.legacyAutomationsEmpty': 'This project has no legacy automations',
    'projectAgent.drawer.anchor': 'Anchor',
    'projectAgent.drawer.taskDetail.back': "Task list",
    'projectAgent.drawer.taskDetail.untitled': "Untitled task",
    'projectAgent.drawer.taskDetail.created': "Created {time}",
    'projectAgent.drawer.taskDetail.createdAt': "Created at",
    'projectAgent.drawer.taskDetail.open': "Open work conversation",
    'projectAgent.drawer.taskDetail.review': "View result",
    'projectAgent.drawer.taskDetail.noScene': "No work conversation is available yet.",
    'projectAgent.drawer.taskDetail.report': "Task report",
    'projectAgent.drawer.taskDetail.noReport': "No task report yet.",
    'projectAgent.drawer.taskDetail.evidenceCount': "{count} supporting records",
    'projectAgent.drawer.taskDetail.info': "Task information",
    'projectAgent.drawer.taskDetail.model': "Execution model",
    'projectAgent.drawer.taskDetail.id': "Task ID",
    'projectAgent.drawer.taskDetail.sourceId': "Source message ID",
    'projectAgent.drawer.taskDetail.evidenceRefs': "Supporting references",
    'projectAgent.drawer.taskDetail.evidenceHint': "These references come from the task record. View their contents in the work conversation.",
    'projectAgent.drawer.taskDetail.status.starting': "Starting",
    'projectAgent.drawer.taskDetail.status.queued': "Queued",
    'projectAgent.drawer.taskDetail.status.paused': "Paused",
    'projectAgent.drawer.taskDetail.hint.starting': "The task is preparing to start. Open its work conversation for details.",
    'projectAgent.drawer.taskDetail.hint.running': "The bot is working on this task. Open its work conversation to follow progress.",
    'projectAgent.drawer.taskDetail.hint.waiting_user': "Open the work conversation to review and respond to the pending decision.",
    'projectAgent.drawer.taskDetail.hint.verifying': "The result and supporting records are being checked. Open the work conversation to view the review.",
    'projectAgent.drawer.taskDetail.hint.queued': "The task is waiting to run. Its queue status is shown above.",
    'projectAgent.drawer.taskDetail.hint.paused': "The task is paused. Resume it from the task list, or open its work conversation.",
    'projectAgent.drawer.taskDetail.hint.result_ready': "Open the work conversation to review and confirm the result.",
    'projectAgent.drawer.taskDetail.hint.accepted': "The result has been accepted. Its records remain in the work conversation.",
    'projectAgent.drawer.taskDetail.hint.failed': "The task did not finish. Open the work conversation to review the failure.",
    'projectAgent.drawer.taskDetail.hint.cancelled': "The task was cancelled. Its work conversation remains available.",
    'projectAgent.drawer.taskDetail.hint.superseded': "This task was replaced by a later task. Its history remains available.",
    'projectAgent.drawer.taskDetail.hint.unavailable': "The latest status cannot be confirmed. Existing records are for reference.",
    'projectAgent.drawer.frozenModel': 'Frozen model',
    'projectAgent.drawer.conclusion': 'Conclusion',
    'projectAgent.drawer.evidence': 'Evidence',
    'projectAgent.drawer.progress': 'Latest progress',
    'projectAgent.drawer.openScene': 'Open the scene',
    'projectAgent.drawer.scene': 'Task scene',
    'projectAgent.drawer.sceneMissing': 'This task has no scene yet',
    'projectAgent.drawer.objective.source': 'Objective',
    'projectAgent.drawer.objective.empty': 'No ongoing objectives',
    'projectAgent.drawer.objective.hint': 'Tell this bot what to work on or watch over time.',
    'projectAgent.drawer.objective.active': 'Active',
    'projectAgent.drawer.objective.paused': 'Paused',
    'projectAgent.drawer.objective.achieved': 'Achieved',
    'projectAgent.drawer.objective.abandoned': 'Abandoned',
    'projectAgent.drawer.objective.pending': 'Awaiting your confirmation',
    'projectAgent.drawer.objective.report_only': 'Report only',
    'projectAgent.drawer.objective.propose': 'Propose first',
    'projectAgent.drawer.objective.act': 'Act directly',
    'projectAgent.drawer.objective.autonomy': 'Autonomy',
    'projectAgent.drawer.objective.budget': 'Automatic tasks per day',
    'projectAgent.drawer.objective.probes': 'Checks per day',
    'projectAgent.drawer.objective.autoAccept': 'Allow automatic acceptance',
    'projectAgent.drawer.objective.autoUsage': 'Automatic tasks today {used}/{limit}',
    'projectAgent.drawer.objective.usage': 'Checks today {used}/{limit}',
    'projectAgent.drawer.objective.watch.unavailable': 'Check temporarily unavailable',
    'projectAgent.drawer.objective.watch.auth': 'Sign in to GitHub to check CI',
    'projectAgent.drawer.objective.watch.cli': 'GitHub CLI is required to check CI',
    'projectAgent.drawer.objective.watch.daily': 'Daily check limit reached',
    'projectAgent.drawer.objective.watch.hourly': 'Hourly check limit reached',
    'projectAgent.drawer.objective.watch.scope': 'Path is outside this project',
    'projectAgent.drawer.objective.watch.range': 'Watch range is too large; narrow the paths',
    'projectAgent.drawer.objective.watch.model': 'No observation model is configured',
    'projectAgent.drawer.objective.watch.cancelled': 'Check stopped',
    'projectAgent.drawer.objective.last': 'Last check',
    'projectAgent.drawer.objective.next': 'Next check',
    'projectAgent.drawer.objective.unchecked': 'Not checked yet',
    'projectAgent.drawer.objective.event': 'Check on events',
    'projectAgent.drawer.objective.edit': 'Edit plan',
    'projectAgent.drawer.objective.save': 'Save',
    'projectAgent.drawer.objective.cancel': 'Cancel',
    'projectAgent.drawer.objective.pause': 'Pause',
    'projectAgent.drawer.objective.resume': 'Resume',
    'projectAgent.drawer.objective.reopen': 'Reopen',
    'projectAgent.drawer.objective.abandon': 'Abandon',
    'projectAgent.drawer.objective.failed': 'Could not save. Refresh and retry.',
    'projectAgent.drawer.objective.loading': 'Loading objectives',
    'projectAgent.drawer.objective.title': 'Title',
    'projectAgent.drawer.objective.outcome': 'Desired outcome',
    'projectAgent.drawer.objective.tasks': 'Related tasks',
    'projectAgent.drawer.objective.noTasks': 'No related tasks yet',
    'projectAgent.drawer.objectives.body': 'Objectives will open in a later version',
    'projectAgent.drawer.objectives.hint': 'For now, you can give this bot specific tasks in chat.',
    'projectAgent.drawer.memory.empty': 'No memories yet',
    'projectAgent.drawer.memory.emptyHint': 'Project facts, preferences, and decisions remembered by the bot will appear here.',
    'projectAgent.drawer.memory.filterEmpty': 'No memories match these filters',
    'projectAgent.drawer.memory.controls': 'Memory settings',
    'projectAgent.drawer.memory.saved': 'Saved memories',
    'projectAgent.drawer.memory.page': '{start}–{end} / {total}',
    'projectAgent.drawer.memory.previous': 'Previous page',
    'projectAgent.drawer.memory.next': 'Next page',
    'projectAgent.drawer.memory.scope.project': 'This project',
    'projectAgent.drawer.memory.scope.global': 'All projects',
    'projectAgent.drawer.memory.readonly': 'Pin, revoke, restore, and export these memories',
    'projectAgent.drawer.memory.filter.kind': 'Kind',
    'projectAgent.drawer.memory.filter.trust': 'Trust',
    'projectAgent.drawer.memory.filter.status': 'Status',
    'projectAgent.drawer.memory.filter.all': 'All',
    'projectAgent.drawer.memory.kind.fact': 'Fact',
    'projectAgent.drawer.memory.kind.preference': 'Preference',
    'projectAgent.drawer.memory.kind.decision': 'Decision',
    'projectAgent.drawer.memory.kind.procedure': 'Procedure',
    'projectAgent.drawer.memory.kind.responsibility': 'Responsibility',
    'projectAgent.drawer.memory.trust.stated': 'Stated',
    'projectAgent.drawer.memory.trust.verified': 'Verified',
    'projectAgent.drawer.memory.status.active': 'Active',
    'projectAgent.drawer.memory.status.forgotten': 'Revoked',
    'projectAgent.drawer.memory.sources': 'Sources',
    'projectAgent.drawer.memory.status.expired': 'Expired',
    'projectAgent.drawer.memory.status.conflicted': 'Conflicted',
    'projectAgent.drawer.memory.needsReverify': 'Possibly outdated · Needs verification',
    'projectAgent.drawer.memory.keepThis': 'Keep this memory',
    'projectAgent.drawer.memory.pin': 'Pin',
    'projectAgent.drawer.memory.unpin': 'Unpin',
    'projectAgent.drawer.memory.revoke': 'Revoke',
    'projectAgent.drawer.memory.restore': 'Restore',
    'projectAgent.drawer.memory.edit': 'Edit',
    'projectAgent.drawer.memory.save': 'Save',
    'projectAgent.drawer.memory.exportJson': 'Export JSON',
    'projectAgent.drawer.memory.exportMarkdown': 'Export Markdown',
    'projectAgent.drawer.memory.projectSwitch': 'Enable memory',
    'projectAgent.drawer.memory.useMemory': 'Use memory in conversations',
    'projectAgent.drawer.memory.learnPreferences': 'Learn preferences from my habits',
    'projectAgent.drawer.memory.learnLater': 'Preference learning starts in a later step. This switch is saved now.',
    'projectAgent.drawer.settings.name': 'Name',
    'projectAgent.drawer.settings.appearance': 'Appearance',
    'projectAgent.drawer.settings.workflow': 'Working style',
    'projectAgent.drawer.settings.runtime': 'Runtime and global settings',
    'projectAgent.drawer.settings.globalScope': 'Applies to all bots',
    'projectAgent.drawer.settings.advancedModels': 'More roles and model limits',
    'projectAgent.drawer.settings.save': 'Save',
    'projectAgent.drawer.settings.avatar': 'Avatar',
    'projectAgent.drawer.settings.avatarNew': 'Generate another',
    'projectAgent.drawer.settings.avatarUpload': 'Upload an image',
    'projectAgent.drawer.settings.avatarColor': 'Color',
    'projectAgent.drawer.settings.avatarColorImageHint': 'Choosing a color switches back to a generated avatar.',
    'projectAgent.drawer.settings.avatarColor.0': 'Iris blue',
    'projectAgent.drawer.settings.avatarColor.1': 'Coral',
    'projectAgent.drawer.settings.avatarColor.2': 'Amber',
    'projectAgent.drawer.settings.avatarColor.3': 'Mint',
    'projectAgent.drawer.settings.avatarColor.4': 'Lilac',
    'projectAgent.drawer.settings.avatarColor.5': 'Rose',
    'projectAgent.drawer.settings.avatarColor.6': 'Lagoon',
    'projectAgent.drawer.settings.avatarColor.7': 'Warm gray',
    'projectAgent.drawer.settings.delete': 'Delete bot',
    'projectAgent.drawer.settings.deleteManaged': 'Delete the managed folder',
    'projectAgent.drawer.settings.deleteConfirm': 'Click again to confirm deletion',
    'projectAgent.drawer.settings.concurrency': 'Global concurrent turns',
    'projectAgent.drawer.settings.concurrencyHint': 'Shared by all bots, from 1 to 8. Each project admits one in-place writer and two readers.',
    'projectAgent.drawer.queuedBehind': 'Waiting for {tasks}',
    'projectAgent.drawer.dependencyFailed': 'Dependency needs attention: {tasks}',
    'projectAgent.drawer.dependencyMissing': 'Dependency is missing; please replan',
    'projectAgent.drawer.diskSpace': 'Queued: less than 2 GB of free disk space',
    'projectAgent.drawer.isolationFailed': 'Queued: isolated workspace is unavailable',
    'projectAgent.drawer.settings.autoHandoff': 'Merge automatically after policy acceptance',
    'projectAgent.drawer.settings.autoHandoffHint': 'Off by default. Verified, accepted changes may merge into this project when enabled.',
    'projectAgent.drawer.settings.proactivity': 'How often to speak up',
    'projectAgent.drawer.settings.proactivity.inherit': 'Follow the global setting',
    'projectAgent.drawer.settings.proactivity.quiet': 'Quiet',
    'projectAgent.drawer.settings.proactivity.low': 'Low',
    'projectAgent.drawer.settings.proactivity.standard': 'Standard',
    'projectAgent.drawer.settings.proactivity.high': 'High',
    'projectAgent.drawer.settings.proactivity.muted': 'Muted',
    'header.subtitle': 'Electron Shell + Local Capability Runtime',
    'status.connecting': 'connecting',
    'session.cloud_only': 'cloud only',
    'session.local_ready': 'local ready',
    'session.hybrid_ready': 'hybrid ready',
    'session.permission_required': 'permission required',
    'session.degraded': 'degraded',
    'session.offline': 'offline',
    'status.cloud.not_configured': 'Cloud Runtime not configured',
    'status.cloud.configured': 'Cloud Runtime configured',
    'status.cloud.connected': 'Model channel connected',
    'status.cloud.degraded': 'Cloud Runtime degraded',
    'status.localCapabilityRegistered': '{count} local capability registered',
    'status.accessMode': 'Access mode: {mode}',
    'status.git.clean': 'git clean',
    'status.git.dirty': '{count} local change(s)',
    'sidebar.noPinned': 'No pinned tasks',
    'composer.placeholder': 'Describe the task to hand off...',
    'composer.disabledPlaceholder': 'Configure a model before sending the first task...',
    'composer.model.ceoAgent': 'Peer Agent',
    'thread.empty.title': 'No task yet',
    'thread.empty.body':
      'Send the first handoff. Peer will proceed under local authorization and close with Evidence.',
    'thread.empty.authAction': 'Sign-in is required',
    'thread.empty.cloudAction': 'A model channel must be configured',
    'thread.loading.bootstrap': 'Preparing client session and local capability registry...',
    'thread.running.approvedCapability': 'Running approved local capability through Electron main and Rust core...',
    'chat.conversations.title': 'Tasks',
    'chat.conversations.refresh': 'Refresh',
    'chat.conversations.empty': 'No tasks yet.',
    'chat.conversations.new': 'New task',
    'chat.conversations.delete': 'Delete task',
    'chat.conversations.confirmDelete': 'Delete this task?',
    'chat.conversations.pin': 'Pin task',
    'chat.conversations.unpin': 'Unpin',
    'chat.conversations.untitled': 'Untitled task',
    'chat.conversations.messageCount': '{count} messages',
    'chat.sidebar.resize': 'Resize sidebar',
    'chat.channel.all': 'All',
    'chat.channel.web': 'Direct',
    'chat.channel.dingtalk': 'DingTalk',
    'chat.channel.dingtalk-direct': 'Direct',
    'chat.channel.dingtalk-group': 'Group',
    'chat.channel.roundtable': 'RoundTable',
    'chat.channel.automation': 'Automation',
    'chat.channel.share': 'Share',
    'chat.channelEvidence.title': 'Channel Evidence',
    'chat.channelEvidence.runtime': 'Runtime Resolution',
    'chat.channelEvidence.source': 'Source',
    'chat.channelEvidence.dingtalk': 'DingTalk Metadata',
    'chat.channelEvidence.roundtable': 'RoundTable Metadata',
    'chat.channelEvidence.callbacks': 'Callback Clues',
    'chat.channelEvidence.rawMetadata': 'Raw Metadata',
    'chat.channelEvidence.participant': 'Participant',
    'chat.channelEvidence.boundary': 'Read-only channel evidence; external callbacks and write actions stay behind existing governance APIs.',
    'chat.channelEvidence.empty': 'No channel evidence yet.',
    'chat.thread.newTitle': 'New task',
    'chat.thread.stop': 'Stop',
    'chat.thread.empty': 'Select a task, or send a message to create a new one.',
    'chat.thread.loading': 'Opening this thread',
    'chat.empty.title': 'What should Peer Agent handle first?',
    'chat.empty.placeholder': 'Hand work to Peer. Come back only when it needs you.',
    'chat.empty.suggestionsLabel': 'Common tasks',
    'chat.empty.suggestion.focus': 'Find the root cause of this error and propose a verifiable fix',
    'chat.empty.suggestion.todo': 'Plan a cross-file refactor and list regression risks',
    'chat.empty.suggestion.minutes': 'Turn this research into a cited document',
    'chat.message.streaming': 'Streaming...',
    'chat.message.timeline': 'Thinking',
    'chat.message.timelineThinking': 'Thinking',
    'chat.message.timelineDone': 'Thought complete',
    'chat.message.confirmRegenerate': 'Regenerate response? Current reply will be replaced.',
    'chat.message.confirmShare': 'Share the full conversation? The link will be accessible to others.',
    'share.title': 'Share Settings',
    'share.description': 'Choose a sharing mode. The share link will be copied to your clipboard.',
    'share.modeFull': 'Share full conversation',
    'share.modeFullDesc': 'Includes all messages in this conversation',
    'share.modeSelect': 'Select messages to share',
    'share.modeSelectDesc': 'Pick specific messages to include',
    'share.modeSelectDisabled': 'Message selection will be available in a future update',
    'share.sectionMode': 'Share scope',
    'share.sectionAccess': 'Access control',
    'share.accessPublic': 'Public',
    'share.accessPublicDesc': 'Anyone with the link can view',
    'share.accessAcl': 'Restricted',
    'share.accessAclDesc': 'Only whitelisted work IDs can access',
    'share.aclWhitelist': 'Allowed work IDs (comma-separated)',
    'share.aclPlaceholder': 'Enter work IDs, e.g. 246944,351282',
    'share.cancel': 'Cancel',
    'share.confirm': 'Share',
    'share.creating': 'Sharing...',
    'share.copied': 'Share link copied to clipboard',
    'share.aclPreparing': 'Generating permissions...',
    'share.selectionHint': 'Select messages to share ({count} selected)',
    'share.confirmSelection': 'Done selecting',
    'chat.message.confirmBranch': 'Create a new conversation branch from this point?',
    'chat.message.confirmationPending': 'Awaiting confirmation: {title}',
    'chat.message.images': 'Images',
    'chat.message.references': 'References',
    'chat.message.data': 'Structured data',
    'chat.message.action.copy': 'Copy',
    'chat.message.action.copied': 'Copied',
    'chat.message.action.regenerate': 'Regenerate',
    'chat.message.action.branch': 'Branch',
    'chat.message.action.share': 'Share',
    'chat.message.action.truncate': 'Truncate',
    'chat.message.action.delete': 'Delete',
    'chat.message.action.unsupported': 'This client only supports filling prompt actions into the composer.',
    'chat.message.confirmDelete': 'Delete this message?',
    'chat.message.confirmTruncate': 'Delete every message after this one?',
    'chat.message.shareCreated': 'Shared: {shareUuid}',
    'chat.message.inspector': 'Cloud Message Inspector',
    'chat.message.inspectorDetail': 'Message Detail',
    'chat.message.inspectorTrace': 'Trace',
    'chat.message.inspectorToolCalls': 'Tool Calls',
    'chat.message.inspectorThinking': 'Thinking',
    'chat.message.inspectorContext': 'Context',
    'chat.message.inspectorEmpty': 'No data yet.',
    'chat.timeline.iteration': 'Iteration {iteration}',
    'chat.timeline.toolCount': '{count} tool call(s)',
    'chat.timeline.noContent': 'No thinking or tool event is available yet.',
    'chat.timeline.toolStdout': 'stdout',
    'chat.timeline.toolStderr': 'stderr',
    'chat.timeline.toolInput': 'arguments',
    'chat.timeline.hydrating': 'Loading thinking process…',
    'chat.tool.localShellExec': 'Local Bash',
    'chat.tool.localShellStop': 'Stop Local Bash',
    'chat.skill.using': 'Using Skill',
    'chat.skill.used': 'Used Skill',
    'chat.context.title': 'Current Context',
    'chat.context.refresh': 'Refresh context',
    'chat.context.memory': 'Working Memory',
    'chat.context.memoryEmpty': 'No Working Memory yet.',
    'chat.context.wiki': 'Memory Wiki',
    'chat.context.wikiEmpty': 'No Memory Wiki status yet.',
    'chat.context.wikiPageCount': '{count} pages',
    'chat.context.wikiInitialize': 'Initialize',
    'chat.context.wikiPagesEmpty': 'No Wiki pages yet.',
    'chat.context.billing': 'Billing',
    'chat.context.billingEmpty': 'No Billing summary yet.',
    'chat.context.shareTitle': 'Share',
    'chat.context.share': 'Create share',
    'chat.context.shareCreated': 'Share created: {shareUuid}',
    'chat.context.shareCreateFailed': 'Share creation failed: {message}',
    'chat.context.shareEmpty': 'No shares yet.',
    'chat.context.shareContinue': 'Continue',
    'chat.context.shareRevoke': 'Revoke',
    'chat.localProxy.title': 'Local tool execution',
    'chat.localProxy.start': 'Start execution channel',
    'chat.localProxy.stop': 'Stop execution channel',
    'chat.localProxy.poll': 'Fetch pending work',
    'chat.localProxy.idle': 'not started',
    'chat.localProxy.projection': 'Local tool surface connected',
    'chat.localProxy.probeContracts': 'Probe cloud contracts',
    'chat.localProxy.contractsPassed': 'Cloud contracts available',
    'chat.localProxy.contractsBlocked': 'Cloud contracts blocked: {count}',
    'chat.localProxy.contractsUnavailable': 'Cloud contract probe failed',
    'chat.execution.title': 'Execution Inspector',
    'chat.execution.refresh': 'Refresh execution',
    'chat.execution.empty': 'No execution events yet.',
    'chat.execution.loadingEvidence': 'Loading execution evidence...',
    'chat.execution.detail': 'Execution Detail',
    'chat.execution.result': 'Final Result',
    'chat.execution.sourceTrace': 'Source Trace',
    'chat.execution.relatedShadow': 'Related Shadow',
    'chat.execution.recent': 'Recent Executions',
    'chat.execution.control': 'Execution Control',
    'chat.execution.cancel': 'Cancel execution',
    'chat.execution.confirmCancel': 'Cancel current cloud execution?',
    'chat.execution.cancelResult': 'Cancel requested, signalSent={signalSent}',
    'chat.governance.title': 'Cloud Governance',
    'chat.governance.refresh': 'Refresh governance',
    'chat.governance.access': 'Access',
    'chat.governance.spectatorEnable': 'Enable spectator',
    'chat.governance.spectatorDisable': 'Disable spectator',
    'chat.governance.createAuth': 'Create ACL',
    'chat.governance.authDetail': 'ACL detail',
    'chat.governance.automations': 'Automation',
    'chat.governance.automationEmpty': 'No Automation sessions yet.',
    'chat.governance.pause': 'Pause',
    'chat.governance.resume': 'Resume',
    'chat.governance.complete': 'Complete',
    'chat.governance.recover': 'Recover runs',
    'chat.governance.roundtable': 'RoundTable',
    'chat.governance.roundtablePlaceholder': 'Inject into current RoundTable...',
    'chat.governance.inject': 'Inject',
    'chat.governance.evolution': 'Evolution Patch',
    'chat.governance.evolutionEmpty': 'No Patch found in current messages.',
    'chat.governance.activatePatch': 'Activate',
    'chat.governance.rejectPatch': 'Reject',
    'chat.governance.reviewPatch': 'Review',
    'chat.dispatch.title': 'Dispatch Review',
    'chat.dispatch.refresh': 'Refresh dispatch',
    'chat.dispatch.pending': 'Pending',
    'chat.dispatch.subtasks': 'Subtasks',
    'chat.dispatch.decision': 'Decision',
    'chat.dispatch.empty': 'No pending dispatch.',
    'chat.dispatch.reason': 'Reason',
    'chat.dispatch.sender': 'Sender',
    'chat.dispatch.feedbackPlaceholder': 'Feedback for cloud dispatch...',
    'chat.dispatch.approve': 'Approve dispatch',
    'chat.dispatch.reject': 'Reject dispatch',
    'chat.dispatch.approved': 'Dispatch approved.',
    'chat.dispatch.rejected': 'Dispatch rejected.',
    'chat.statistics.title': 'Chat Statistics',
    'chat.statistics.refresh': 'Refresh statistics',
    'chat.statistics.startDate': 'Start',
    'chat.statistics.endDate': 'End',
    'chat.statistics.overview': 'Overview',
    'chat.statistics.trends': 'Trends',
    'chat.statistics.toolRanking': 'Tool Ranking',
    'chat.statistics.userRanking': 'User Ranking',
    'chat.statistics.realtime': 'Realtime',
    'chat.statistics.export': 'Export snapshot',
    'chat.statistics.exportFormat': 'Format',
    'chat.statistics.exportJson': 'JSON',
    'chat.statistics.exportCsv': 'CSV',
    'chat.statistics.exportSaved': 'Saved: {filePath}',
    'chat.statistics.exportCloudReady': 'Cloud export is ready: {artifact}',
    'chat.statistics.exportCloudFallback': 'Cloud export is unavailable; saved a local snapshot instead: {reason}',
    'chat.statistics.exportCloudEmpty': 'Cloud export returned an empty result.',
    'chat.statistics.exportCloudFailed': 'Cloud export failed.',
    'chat.statistics.exportCancelled': 'Export cancelled.',
    'chat.statistics.empty': 'No statistics yet.',
    'chat.studio.title': 'Agent Studio',
    'chat.studio.refresh': 'Refresh Studio',
    'chat.studio.enterChat': 'Enter Chat',
    'chat.studio.channelPlaceholder': 'Select Channel',
    'chat.studio.scene': 'Scene',
    'chat.studio.events': 'Events',
    'chat.studio.channels': 'Channels',
    'chat.studio.sessions': 'Sessions',
    'chat.studio.enterSession': 'Enter Session',
    'chat.studio.enterResult': 'Enter Result',
    'chat.studio.empty': 'No Studio data yet.',
    'chat.openclawGovernance.title': 'OpenClaw Governance Directory',
    'chat.openclawGovernance.refresh': 'Refresh directory',
    'chat.openclawGovernance.identityPlaceholder': 'Select Identity Profile',
    'chat.openclawGovernance.catalog': 'Catalog Summary',
    'chat.openclawGovernance.identityProfiles': 'Identity Profiles',
    'chat.openclawGovernance.rolePostures': 'Role Postures',
    'chat.openclawGovernance.unifiedServiceRefs': 'Unified Service Refs',
    'chat.openclawGovernance.capabilityProfiles': 'Capability Profiles',
    'chat.openclawGovernance.memoryPacks': 'Memory Packs',
    'chat.openclawGovernance.seedMemoryPacks': 'Seed Memory Packs',
    'chat.openclawGovernance.memoryBindingPolicies': 'Memory Binding Policies',
    'chat.openclawGovernance.memoryWorkspaces': 'Memory Workspaces',
    'chat.openclawGovernance.memorySnapshots': 'Memory Snapshots',
    'chat.openclawGovernance.memoryTrainingRuns': 'Training Runs',
    'chat.openclawGovernance.trainingScorecards': 'Training Scorecards',
    'chat.openclawGovernance.learningSamples': 'Learning Samples',
    'chat.openclawGovernance.memoryCandidates': 'Memory Candidates',
    'chat.openclawGovernance.peer-agentBackflowExports': 'Peer Agent Backflow',
    'chat.openclawGovernance.modelPolicies': 'Model Policies',
    'chat.openclawGovernance.credentialProfiles': 'Credential Profiles',
    'chat.openclawGovernance.evalSuites': 'Eval Suites',
    'chat.openclawGovernance.simulationEvals': 'Simulation Evals',
    'chat.openclawGovernance.certifications': 'Certifications',
    'chat.openclawGovernance.agentReleases': 'Agent Releases',
    'chat.openclawGovernance.releaseChannels': 'Release Channels',
    'chat.openclawGovernance.onDutyPolicies': 'On Duty Policies',
    'chat.openclawGovernance.schedulePolicies': 'Schedule Policies',
    'chat.openclawGovernance.alertPolicies': 'Alert Policies',
    'chat.openclawGovernance.alertIncidents': 'Alert Incidents',
    'chat.openclawGovernance.remediationPolicies': 'Remediation Policies',
    'chat.openclawGovernance.remediationActions': 'Remediation Actions',
    'chat.openclawGovernance.humanTakeovers': 'Human Takeovers',
    'chat.openclawGovernance.upgradeJobs': 'Upgrade Jobs',
    'chat.openclawGovernance.effectiveConfig': 'Effective Config',
    'chat.openclawGovernance.conversationConfig': 'Conversation Config',
    'chat.openclawGovernance.empty': 'No governance data yet.',
    'chat.openclawWriteGate.title': 'OpenClaw Write Gates',
    'chat.openclawWriteGate.boundary': 'These are real cloud POST capabilities, but the client only shows the permission matrix for now; execution stays blocked until cloud policy, Effective Config, operator confirmation, audit reason, and Evidence return are all wired.',
    'chat.openclawWriteGate.governance': 'Governance Writes',
    'chat.openclawWriteGate.studio': 'Studio Writes',
    'chat.openclawWriteGate.risk': 'Risk',
    'chat.openclawWriteGate.gates': 'Gates',
    'chat.openclawWriteGate.evidence': 'Evidence',
    'chat.openclawWriteGate.blocked': 'blocked',
    'chat.memoryReview.title': 'Agent Memory Review',
    'chat.memoryReview.refresh': 'Refresh review',
    'chat.memoryReview.boundaryTitle': 'Cognition Boundary',
    'chat.memoryReview.boundary': 'Personal experience stays on this machine by default; it is not automatically promoted into system instructions or shared cognition.',
    'chat.memoryReview.patches': 'Current Patches',
    'chat.memoryReview.patchReviewOnly': 'Review signal only; cloud evolution writes need a separate permission gate.',
    'chat.memoryReview.candidates': 'Memory Candidates',
    'chat.memoryReview.simulationEvals': 'Simulation Evals',
    'chat.memoryReview.trainingRuns': 'Training Runs',
    'chat.memoryReview.peer-agentBackflow': 'Peer Agent Backflow',
    'chat.memoryReview.relatedShadow': 'Related Shadow',
    'chat.memoryReview.empty': 'No review data yet.',
    'chat.memoryWriteGate.title': 'Agent Memory Write Gates',
    'chat.memoryWriteGate.boundary': 'These migration / simulation endpoints are real, but they are pre/local only; the client only shows the permission matrix and does not execute them or automatically promote personal experience into cloud Patch.',
    'chat.memoryWriteGate.risk': 'Risk',
    'chat.memoryWriteGate.gates': 'Gates',
    'chat.memoryWriteGate.evidence': 'Evidence',
    'chat.memoryWriteGate.blocked': 'blocked',
    'chat.observability.title': 'Cloud Observability',
    'chat.observability.refresh': 'Refresh observability',
    'chat.observability.trace': 'Conversation Trace',
    'chat.observability.latestMessageTrace': 'Latest Message Trace',
    'chat.observability.toolCalls': 'Tool Calls',
    'chat.observability.memoryCompile': 'Memory Compile',
    'chat.observability.retryCompile': 'Retry compile',
    'chat.observability.billingTrend': 'Agent Billing',
    'chat.observability.thinking': 'Thinking',
    'chat.observability.empty': 'No data yet.',
    'chat.confirm.approve': 'Approve',
    'chat.confirm.reject': 'Reject',
    'chat.agent.default': 'Default model',
    'chat.agent.refresh': 'Refresh agents',
    'chat.composer.placeholder': 'Continue with a task or extra context...',
    'chat.composer.suggest': 'Suggest',
    'chat.composer.complete': 'Complete',
    'chat.composer.applyCompletion': 'Apply completion: {text}',
    'chat.composer.send': 'Send',
    'chat.role.user': 'User',
    'chat.role.assistant': 'Agent',
    'chat.role.system': 'System',
    'chat.role.tool': 'Tool',
    'runtime.auth': 'Auth',
    'runtime.cloud': 'Cloud Runtime',
    'runtime.session': 'Local session',
    'runtime.workspace': 'Workspace',
    'runtime.capabilities': 'Local capability Manifests',
    'runtime.projects': 'Project index',
    'runtime.clientId': 'client_id',
    'runtime.endpoint': 'endpoint',
    'runtime.mode': 'mode',
    'runtime.mode.prod': 'production',
    'runtime.mode.pre': 'pre',
    'runtime.mode.custom': 'custom',
    'runtime.noEndpoint': 'No endpoint configured',
    'runtime.noRuntimeGateway': 'Runtime Gateway not configured',
    'runtime.sessionId': 'session_id',
    'runtime.gitBranch': 'branch {branch}',
    'runtime.gitChanges': '{count} change(s)',
    'runtime.noCapabilities': 'No local capability Manifest was found.',
    'runtime.noProjects': 'No local project was found.',
    'runtime.projection.publish': 'Connect local tools',
    'runtime.projection.publishing': 'Connecting',
    'runtime.projection.published': 'Local tools connected',
    'runtime.projection.failed': 'Local tools failed to connect: {message}',
    'message.assistantWorkSummary': 'Assistant work summary',
    'message.evidenceSummary': 'Evidence summary',
    'message.returnedToCloud': 'Returned to cloud',
    'message.localOnly': 'Local only',
    'review.single': '1 local action needs review',
    'review.multiple': '{count} local actions need review',
    'review.badge': 'review',
    'review.allow': 'Review and allow',
    'review.allowAlways': 'Always allow',
    'review.deny': 'Deny',
    'review.morePending': '+{count} more',
    'review.returnEvidence': 'Return Evidence',
    'tool.waitingReview': 'waiting review',
    'access.cloud_only': 'Cloud only',
    'access.ask_before_local': 'Ask before local',
    'access.session_local': 'Session local',
    'access.restricted_local': 'Restricted local',
    'access.full_local': 'Full local',
    'artifact.evidence.local': 'Evidence summary remains local and available for explicit return.',
    'artifact.evidence.returned': 'Evidence summary has been returned to the cloud runtime.',
    'task.pinned.minimalLoop': 'Cloud-client minimal loop',
    'task.pinned.reviewDesign': 'Review card design',
    'updater.badge.upToDate': 'Up to date',
    'updater.badge.checking': 'Checking…',
    'updater.badge.updateAvailable': 'Update available',
    'updater.badge.ariaHasUpdate': 'An update is available, click to view',
    'updater.badge.downloading': 'Downloading update… {percent}%',
    'updater.badge.newVersion': 'New',
    'updater.badge.install': 'Install',
    'updater.badge.ready': 'Version v{version} is ready',
    'updater.modal.title': 'Update available',
    'updater.modal.checking': 'Checking for updates…',
    'updater.modal.newUpdatePill': 'New update',
    'updater.modal.fromVersion': 'from v{version}',
    'updater.modal.backgroundDownloadHint': 'Download runs in the background. Install from the sidebar when ready.',
    'updater.modal.currentVersion': 'Current version',
    'updater.modal.newVersion': 'New version',
    'updater.modal.releaseNotes': "What's new",
    'updater.modal.noReleaseNotes': 'No release notes for this update.',
    'updater.modal.update': 'Update',
    'updater.modal.later': 'Later',
    'updater.modal.close': 'Close',
    'updater.modal.installing': 'Installing {version}',
    'updater.modal.installHint':
      'Your work is saved. The app will restart automatically after install, usually 10–30 seconds.',
    'updater.modal.downloading': 'Downloading update…',
    'updater.modal.restartNow': 'Restart & install',
    'updater.modal.openReleasePage': 'Open download page',
    'updater.modal.upToDate': 'You are on the latest version.',
    'updater.modal.checkAgain': 'Check again',
    'updater.modal.error': 'Update error: {message}',
    'updater.settings.title': 'Updates',
    'updater.settings.description': 'Manage the update channel and version checks for Peer Agent.',
    'updater.settings.channel': 'Update channel',
    'updater.settings.channel.description':
      'Choose Beta for early features, or Stable for production builds. A manual choice overrides version-based detection.',
    'updater.settings.channel.auto': 'Auto (follow current version)',
    'updater.settings.channel.beta': 'Beta (early access)',
    'updater.settings.channel.stable': 'Stable (production)',
    'updater.badge.channel.auto': 'Auto',
    'updater.badge.channel.beta': 'Beta',
    'updater.badge.channel.stable': 'Stable',
    'updater.settings.currentVersion': 'Current version',
    'updater.settings.checkNow': 'Check for updates',
    'updater.settings.checking': 'Checking…',
    'updater.settings.disabledHint': 'Auto-update is disabled in development.',
    'updater.settings.help.title': 'Help and links',
    'updater.settings.help.description': 'GitHub repository, feedback, and release notes',
    'updater.settings.help.github': 'GitHub',
    'updater.settings.help.feedback': 'Submit feedback',
    'updater.settings.help.releaseNotes': 'Release notes',
    'header.capabilities.label': 'Capabilities',
    'header.capabilities.title': 'Mounted capabilities',
    'header.capabilities.group.skill': 'Skills',
    'header.capabilities.group.mcp': 'MCP',
    'header.capabilities.group.plugin': 'Plugins',
    'header.capabilities.group.builtin': 'Built-in',
    'header.capabilities.builtin.localExecution': 'Local execution',
    'header.capabilities.builtin.browserControl': 'Browser control',
    'header.capabilities.builtin.webAccess': 'Web access',
    'header.capabilities.empty': 'No capabilities mounted',
    'header.capabilities.manage': 'Manage',
    'header.capabilities.toolCount': '{count} tools',
    'header.capabilities.aria': '{count} capabilities mounted',
    'header.capabilities.status.available': 'Available',
    'header.capabilities.status.needsAuth': 'Asks first',
    'header.capabilities.status.disabled': 'Disabled',
    'header.capabilities.status.unavailable': 'Unavailable',
  },
};

export interface I18nRuntime {
  readonly locale: LocaleCode;
  readonly t: (key: TranslationKey, values?: TranslationValues) => string;
  readonly localize: (fallback: string, localized?: LocalizedText) => string;
  readonly capabilityName: (capability: CapabilityManifest) => string;
  readonly capabilityDescription: (capability: CapabilityManifest) => string;
}

export function resolveLocale(input?: string | null): LocaleCode {
  if (!input) {
    return DEFAULT_LOCALE;
  }

  const normalized = input.replace('_', '-').toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }

  if (normalized.startsWith('en')) {
    return 'en-US';
  }

  return DEFAULT_LOCALE;
}

export function createI18n(inputLocale?: string | null): I18nRuntime {
  const locale = resolveLocale(inputLocale);

  function t(key: TranslationKey, values: TranslationValues = {}) {
    const template = resources[locale][key] ?? resources[DEFAULT_LOCALE][key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
  }

  function localize(fallback: string, localized?: LocalizedText) {
    return localized?.[locale] ?? localized?.[DEFAULT_LOCALE] ?? fallback;
  }

  return {
    locale,
    t,
    localize,
    capabilityName: (capability) => localize(capability.name, capability.localizedName),
    capabilityDescription: (capability) => localize(capability.description, capability.localizedDescription),
  };
}
