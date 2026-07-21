import type { CapabilityManifest, LocaleCode, LocalizedText } from '@peer-agent/protocol';

export type { LocaleCode };

export const DEFAULT_LOCALE: LocaleCode = 'zh-CN';

export const AVAILABLE_LOCALES = ['zh-CN', 'en-US'] as const satisfies readonly LocaleCode[];

export type TranslationKey =
  | 'app.newTask'
  | 'searchChats.open'
  | 'searchChats.placeholder'
  | 'searchChats.section.chats'
  | 'searchChats.section.suggested'
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
  | 'settings.replyLanguage'
  | 'settings.replyLanguage.description'
  | 'settings.replyLanguage.followInterface'
  | 'settings.replyLanguage.auto'
  | 'settings.git'
  | 'settings.git.branchPrefix'
  | 'settings.git.branchPrefix.description'
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
  | 'updater.badge.openInstaller'
  | 'updater.badge.ready'
  | 'updater.modal.title'
  | 'updater.modal.checking'
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
  | 'updater.modal.readyToOpen'
  | 'updater.modal.openInstaller'
  | 'updater.modal.openInstallerHint'
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
  | 'updater.settings.currentVersion'
  | 'updater.settings.checkNow'
  | 'updater.settings.checking'
  | 'updater.settings.disabledHint'
  | 'header.capabilities.label'
  | 'header.capabilities.title'
  | 'header.capabilities.group.skill'
  | 'header.capabilities.group.mcp'
  | 'header.capabilities.group.plugin'
  | 'header.capabilities.group.builtin'
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
    'app.newTask': '新任务',
    'searchChats.open': '打开搜索会话',
    'searchChats.placeholder': '搜索会话',
    'searchChats.section.chats': '会话',
    'searchChats.section.suggested': '建议',
    'searchChats.empty': '未找到相关会话',
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
    'settings.language.description': '选择界面显示语言。',
    'settings.replyLanguage': '回复语言',
    'settings.replyLanguage.description': '选择 AI 回复时使用的语言，避免回复语言混乱。',
    'settings.replyLanguage.followInterface': '跟随界面语言',
    'settings.replyLanguage.auto': '自动（跟随提问语言）',
    'settings.git': 'Git',
    'settings.git.branchPrefix': '分支前缀',
    'settings.git.branchPrefix.description': 'Agent 创建 Git 分支时使用的名称前缀，例如 PeerAgent/。',
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
    'status.cloud.connected': 'Cloud CEO Agent 已连接',
    'status.cloud.degraded': 'Cloud Runtime 降级',
    'status.localCapabilityRegistered': '{count} 个本地能力已注册',
    'status.accessMode': '访问模式：{mode}',
    'status.git.clean': 'git 干净',
    'status.git.dirty': '{count} 项本地变更',
    'sidebar.noPinned': '暂无置顶任务',
    'composer.placeholder': '向 Cloud CEO Agent 发送任务...',
    'composer.disabledPlaceholder': '登录并连接 Cloud Runtime 后开始真实任务...',
    'composer.model.ceoAgent': 'CEO Agent',
    'thread.empty.title': '等待真实云端任务',
    'thread.empty.body':
      '当前没有来自 Cloud CEO Agent Runtime 的 task thread。客户端只展示本地 bootstrap、认证、Cloud Runtime、能力 Manifest 和项目索引这些真实状态。',
    'thread.empty.authAction': '需要完成 BUC 登录',
    'thread.empty.cloudAction': '需要配置并连接 Cloud Runtime',
    'thread.loading.bootstrap': '正在准备客户端会话和本地能力注册表...',
    'thread.running.approvedCapability': '正在通过 Electron main 和 Rust core 执行已授权的本地能力...',
    'chat.conversations.title': '真实会话',
    'chat.conversations.refresh': '刷新',
    'chat.conversations.empty': '暂无云端会话。',
    'chat.conversations.new': '新会话',
    'chat.conversations.delete': '删除会话',
    'chat.conversations.confirmDelete': '确认删除这个会话？',
    'chat.conversations.pin': '固定会话',
    'chat.conversations.unpin': '取消固定',
    'chat.conversations.untitled': '未命名会话',
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
    'chat.channelEvidence.boundary': '只读展示企业通道证据；外部回调和插话类写动作仍由云端治理接口控制。',
    'chat.channelEvidence.empty': '暂无通道证据。',
    'chat.thread.newTitle': '新会话',
    'chat.thread.stop': '停止',
    'chat.thread.empty': '选择一个会话，或直接发送消息创建真实云端会话。',
    'chat.thread.loading': '正在载入这段会话',
    'chat.empty.title': '今天要我先处理什么？',
    'chat.empty.placeholder': '交给 Peer Agent：安排会议、整理聊天、生成待办...',
    'chat.empty.suggestionsLabel': '常用任务',
    'chat.empty.suggestion.focus': '帮我梳理今天的工作重点',
    'chat.empty.suggestion.todo': '把一段钉钉聊天整理成待办',
    'chat.empty.suggestion.minutes': '根据会议记录生成纪要',
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
    'chat.memoryReview.boundary': '云端为准，个人为辅；个人经验只作为本地辅助上下文，不自动进入云端 Patch 或 1688 认知本体。',
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
    'chat.agent.default': '默认 CEO Agent',
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
    'updater.badge.openInstaller': '安装',
    'updater.badge.ready': '新版本 v{version} 已就绪',
    'updater.modal.title': '发现新版本',
    'updater.modal.checking': '正在检查更新…',
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
    'updater.modal.readyToOpen': '{version} 已下载完成。',
    'updater.modal.openInstaller': '安装',
    'updater.modal.openInstallerHint':
      '点击「安装」后，在弹出的窗口中将 Peer Agent 拖入「应用程序」完成覆盖安装。',
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
    'updater.settings.currentVersion': '当前版本',
    'updater.settings.checkNow': '检查更新',
    'updater.settings.checking': '检查中…',
    'updater.settings.disabledHint': '开发环境下自动更新已禁用。',
    'header.capabilities.label': '能力',
    'header.capabilities.title': '已挂载能力',
    'header.capabilities.group.skill': '技能',
    'header.capabilities.group.mcp': 'MCP',
    'header.capabilities.group.plugin': '插件',
    'header.capabilities.group.builtin': '内置',
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
    'app.newTask': 'New task',
    'searchChats.open': 'Search chats',
    'searchChats.placeholder': 'Search chats',
    'searchChats.section.chats': 'Chats',
    'searchChats.section.suggested': 'Suggested',
    'searchChats.empty': 'No chats found',
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
    'settings.language.description': 'Choose the display language for the interface.',
    'settings.replyLanguage': 'Reply language',
    'settings.replyLanguage.description': 'Choose the language the AI replies in, to avoid mixed-language responses.',
    'settings.replyLanguage.followInterface': 'Follow interface language',
    'settings.replyLanguage.auto': 'Auto (match the question)',
    'settings.git': 'Git',
    'settings.git.branchPrefix': 'Branch prefix',
    'settings.git.branchPrefix.description': 'Name prefix used when the agent creates Git branches, e.g. PeerAgent/.',
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
    'status.cloud.connected': 'Cloud CEO Agent connected',
    'status.cloud.degraded': 'Cloud Runtime degraded',
    'status.localCapabilityRegistered': '{count} local capability registered',
    'status.accessMode': 'Access mode: {mode}',
    'status.git.clean': 'git clean',
    'status.git.dirty': '{count} local change(s)',
    'sidebar.noPinned': 'No pinned tasks',
    'composer.placeholder': 'Send a task to Cloud CEO Agent...',
    'composer.disabledPlaceholder': 'Sign in and connect Cloud Runtime to start a real task...',
    'composer.model.ceoAgent': 'CEO Agent',
    'thread.empty.title': 'Waiting for a real cloud task',
    'thread.empty.body':
      'No task thread has arrived from Cloud CEO Agent Runtime. The client is only showing real local bootstrap, auth, Cloud Runtime, capability Manifest, and project index state.',
    'thread.empty.authAction': 'BUC sign-in is required',
    'thread.empty.cloudAction': 'Cloud Runtime must be configured and connected',
    'thread.loading.bootstrap': 'Preparing client session and local capability registry...',
    'thread.running.approvedCapability': 'Running approved local capability through Electron main and Rust core...',
    'chat.conversations.title': 'Real conversations',
    'chat.conversations.refresh': 'Refresh',
    'chat.conversations.empty': 'No cloud conversations yet.',
    'chat.conversations.new': 'New conversation',
    'chat.conversations.delete': 'Delete conversation',
    'chat.conversations.confirmDelete': 'Delete this conversation?',
    'chat.conversations.pin': 'Pin conversation',
    'chat.conversations.unpin': 'Unpin conversation',
    'chat.conversations.untitled': 'Untitled conversation',
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
    'chat.channelEvidence.boundary': 'Read-only enterprise channel evidence; external callbacks and write actions remain controlled by cloud governance APIs.',
    'chat.channelEvidence.empty': 'No channel evidence yet.',
    'chat.thread.newTitle': 'New conversation',
    'chat.thread.stop': 'Stop',
    'chat.thread.empty': 'Select a conversation, or send a message to create a real cloud conversation.',
    'chat.thread.loading': 'Opening this thread',
    'chat.empty.title': 'What should Peer Agent handle first?',
    'chat.empty.placeholder': 'Ask Peer Agent to plan meetings, organize messages, or create tasks...',
    'chat.empty.suggestionsLabel': 'Common tasks',
    'chat.empty.suggestion.focus': "Help me sort today's work priorities",
    'chat.empty.suggestion.todo': 'Turn a DingTalk thread into action items',
    'chat.empty.suggestion.minutes': 'Draft meeting minutes from notes',
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
    'chat.memoryReview.boundary': 'Cloud remains authoritative and personal experience stays auxiliary; local experience is not automatically promoted into cloud Patch or the 1688 cognition ontology.',
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
    'chat.agent.default': 'Default CEO Agent',
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
    'updater.badge.openInstaller': 'Install',
    'updater.badge.ready': 'Version v{version} is ready',
    'updater.modal.title': 'Update available',
    'updater.modal.checking': 'Checking for updates…',
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
    'updater.modal.readyToOpen': '{version} has been downloaded.',
    'updater.modal.openInstaller': 'Install',
    'updater.modal.openInstallerHint':
      'After clicking “Install”, drag Peer Agent into “Applications” to overwrite the current version.',
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
    'updater.settings.currentVersion': 'Current version',
    'updater.settings.checkNow': 'Check for updates',
    'updater.settings.checking': 'Checking…',
    'updater.settings.disabledHint': 'Auto-update is disabled in development.',
    'header.capabilities.label': 'Capabilities',
    'header.capabilities.title': 'Mounted capabilities',
    'header.capabilities.group.skill': 'Skills',
    'header.capabilities.group.mcp': 'MCP',
    'header.capabilities.group.plugin': 'Plugins',
    'header.capabilities.group.builtin': 'Built-in',
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
