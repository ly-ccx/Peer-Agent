function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function normalizeIdentifier(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createConversationSessionApplicationService({
  getActiveGoalByConversation,
  shouldRecoverGoal,
  scheduleRecovery,
  startGoalRunner,
  markTaskRead,
  markConversationRead,
  reportRecoveryFailure,
  reportNotificationFailure,
} = {}) {
  const ports = {
    getActiveGoalByConversation: assertFunction(
      getActiveGoalByConversation,
      'getActiveGoalByConversation',
    ),
    shouldRecoverGoal: assertFunction(shouldRecoverGoal, 'shouldRecoverGoal'),
    scheduleRecovery: assertFunction(scheduleRecovery, 'scheduleRecovery'),
    startGoalRunner: assertFunction(startGoalRunner, 'startGoalRunner'),
    markTaskRead: assertFunction(markTaskRead, 'markTaskRead'),
    // 可选：旧 harness 可不注入；有注入时打开会话推进 lastReadAt。
    markConversationRead:
      typeof markConversationRead === 'function' ? markConversationRead : null,
    reportRecoveryFailure: assertFunction(reportRecoveryFailure, 'reportRecoveryFailure'),
    reportNotificationFailure: assertFunction(
      reportNotificationFailure,
      'reportNotificationFailure',
    ),
  };

  let activeConversationId = null;

  function scheduleGoalRecovery(conversationId) {
    const activeGoal = ports.getActiveGoalByConversation(conversationId) ?? null;
    if (!ports.shouldRecoverGoal(activeGoal)) return;

    ports.scheduleRecovery(() => {
      const recovery = ports.startGoalRunner(activeGoal.planId);
      if (recovery && typeof recovery.catch === 'function') {
        recovery.catch((error) => ports.reportRecoveryFailure(error));
      }
    });
  }

  function markCurrentTaskRead(planId) {
    if (!planId) return;
    try {
      ports.markTaskRead(planId);
    } catch (error) {
      ports.reportNotificationFailure(error);
    }
  }

  function markCurrentConversationRead(conversationId) {
    if (!conversationId || typeof ports.markConversationRead !== 'function') return;
    try {
      ports.markConversationRead(conversationId);
    } catch (error) {
      ports.reportNotificationFailure(error);
    }
  }

  return Object.freeze({
    setActiveConversation(payload = {}) {
      const conversationId = normalizeIdentifier(payload?.conversationId);
      const planId = normalizeIdentifier(payload?.planId);
      activeConversationId = conversationId;

      if (conversationId) {
        scheduleGoalRecovery(conversationId);
        markCurrentConversationRead(conversationId);
        markCurrentTaskRead(planId);
      }

      return { ok: true, conversationId: activeConversationId };
    },
    getActiveConversationId() {
      return activeConversationId;
    },
  });
}
