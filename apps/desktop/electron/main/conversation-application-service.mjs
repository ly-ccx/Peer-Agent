function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function withoutReturnedMessages(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Object.hasOwn(result, 'messages')) return result;
  const { messages: _messages, ...meta } = result;
  return meta;
}

export function createConversationApplicationService({
  listConversations,
  listConversationsByWorkspace,
  searchConversations,
  createConversation,
  getConversation,
  updateTitle,
  updateMode,
  updateFastMode,
  updatePreferredExecutionIsolation,
  updateAutomationCreateContext,
  updateModelEffort,
  appendMessage,
  updateLastMessage,
  replaceMessages,
  archiveConversation,
  restoreConversation,
  pinConversation,
  unpinConversation,
  reorderPinnedConversations,
  autoArchiveConversations,
  deleteConversation,
  addUsage,
  listActiveConversationIds,
  deletePlanByConversation,
  removeConversationToolArtifacts,
  reportCascadeFailure,
} = {}) {
  const ports = {
    listConversations: assertFunction(listConversations, 'listConversations'),
    listConversationsByWorkspace: assertFunction(
      listConversationsByWorkspace,
      'listConversationsByWorkspace',
    ),
    searchConversations: assertFunction(searchConversations, 'searchConversations'),
    createConversation: assertFunction(createConversation, 'createConversation'),
    getConversation: assertFunction(getConversation, 'getConversation'),
    updateTitle: assertFunction(updateTitle, 'updateTitle'),
    updateMode: assertFunction(updateMode, 'updateMode'),
    updateFastMode: assertFunction(updateFastMode, 'updateFastMode'),
    updatePreferredExecutionIsolation: assertFunction(
      updatePreferredExecutionIsolation,
      'updatePreferredExecutionIsolation',
    ),
    updateAutomationCreateContext: assertFunction(
      updateAutomationCreateContext,
      'updateAutomationCreateContext',
    ),
    updateModelEffort: assertFunction(updateModelEffort, 'updateModelEffort'),
    appendMessage: assertFunction(appendMessage, 'appendMessage'),
    updateLastMessage: assertFunction(updateLastMessage, 'updateLastMessage'),
    replaceMessages: assertFunction(replaceMessages, 'replaceMessages'),
    archiveConversation: assertFunction(archiveConversation, 'archiveConversation'),
    restoreConversation: assertFunction(restoreConversation, 'restoreConversation'),
    pinConversation: assertFunction(pinConversation, 'pinConversation'),
    unpinConversation: assertFunction(unpinConversation, 'unpinConversation'),
    reorderPinnedConversations: assertFunction(
      reorderPinnedConversations,
      'reorderPinnedConversations',
    ),
    autoArchiveConversations: assertFunction(autoArchiveConversations, 'autoArchiveConversations'),
    deleteConversation: assertFunction(deleteConversation, 'deleteConversation'),
    addUsage: assertFunction(addUsage, 'addUsage'),
    listActiveConversationIds: assertFunction(
      listActiveConversationIds,
      'listActiveConversationIds',
    ),
    deletePlanByConversation: assertFunction(
      deletePlanByConversation,
      'deletePlanByConversation',
    ),
    removeConversationToolArtifacts: assertFunction(
      removeConversationToolArtifacts,
      'removeConversationToolArtifacts',
    ),
    reportCascadeFailure: assertFunction(reportCascadeFailure, 'reportCascadeFailure'),
  };

  function list(params = {}) {
    const wantsPage =
      params?.paginated === true || params?.limit != null || params?.cursor != null;
    const listParams = {
      status: params?.status,
      includeMessageCount: params?.includeMessageCount,
      backfillMessageCount: params?.backfillMessageCount,
      limit: params?.limit,
      cursor: params?.cursor,
      paginated: wantsPage,
    };
    if (params?.workspacePath !== undefined) {
      return ports.listConversationsByWorkspace(params.workspacePath, listParams);
    }
    return ports.listConversations(listParams);
  }

  function autoArchive({ before, excludeIds } = {}) {
    const activeStreamIds = ports.listActiveConversationIds();
    return ports.autoArchiveConversations({
      before,
      excludeIds: [...new Set([...(excludeIds || []), ...activeStreamIds])],
    });
  }

  function remove({ id }) {
    const result = ports.deleteConversation(id);
    try {
      ports.deletePlanByConversation(id);
    } catch (error) {
      ports.reportCascadeFailure('deletePlanByConversation', error);
    }
    try {
      ports.removeConversationToolArtifacts({ conversationId: id });
    } catch (error) {
      ports.reportCascadeFailure('removeConversationToolArtifacts', error);
    }
    return result;
  }

  return Object.freeze({
    list,
    search: (params) => ports.searchConversations(params || {}),
    create: (params) => ports.createConversation(params),
    get: ({ id, limit, before, full } = {}) => ports.getConversation(id, {
      ...(limit != null ? { limit } : {}),
      ...(typeof before === 'string' && before ? { before } : {}),
      ...(full === true ? { full: true } : {}),
    }),
    updateTitle: ({ id, title }) => ports.updateTitle(id, title),
    updateMode: ({ id, mode }) => ports.updateMode(id, mode),
    updateFastMode: ({ id, fastMode }) => ports.updateFastMode(id, fastMode),
    updatePreferredExecutionIsolation: ({ id, preferredExecutionIsolation }) =>
      ports.updatePreferredExecutionIsolation(id, preferredExecutionIsolation),
    updateAutomationCreateContext: ({ id, context }) =>
      ports.updateAutomationCreateContext(id, context),
    updateModelEffort: ({ id, effort, modelProviderId }) =>
      ports.updateModelEffort(id, { effort, modelProviderId }),
    appendMessage: ({ id, message }) => withoutReturnedMessages(
      ports.appendMessage(id, message, { returnMessages: false }),
    ),
    updateLastMessage: ({ id, content }) => ports.updateLastMessage(id, content),
    replaceMessages: ({ id, messages, allowEmpty = false }) =>
      ports.replaceMessages(id, messages, { allowEmpty }),
    archive: ({ id }) => ports.archiveConversation(id),
    restore: ({ id }) => ports.restoreConversation(id),
    pin: ({ id }) => ports.pinConversation(id),
    unpin: ({ id }) => ports.unpinConversation(id),
    reorderPinned: ({ ids }) => ports.reorderPinnedConversations(ids),
    autoArchive,
    remove,
    addUsage: ({ id, usage }) => ports.addUsage(id, usage),
  });
}
