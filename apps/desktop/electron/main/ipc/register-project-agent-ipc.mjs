function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createProjectAgentIpcRegistrations({ projectAgent } = {}) {
  const ports = {
    list: assertFunction(projectAgent?.list, 'projectAgent.list'),
    get: assertFunction(projectAgent?.get, 'projectAgent.get'),
    readAvatar: assertFunction(projectAgent?.readAvatar, 'projectAgent.readAvatar'),
    create: assertFunction(projectAgent?.create, 'projectAgent.create'),
    updateProfile: assertFunction(projectAgent?.updateProfile, 'projectAgent.updateProfile'),
    deleteBot: assertFunction(projectAgent?.deleteBot, 'projectAgent.deleteBot'),
    submitInput: assertFunction(projectAgent?.submitInput, 'projectAgent.submitInput'),
    readConversation: assertFunction(projectAgent?.readConversation, 'projectAgent.readConversation'),
    readEvidence: assertFunction(projectAgent?.readEvidence, 'projectAgent.readEvidence'),
    listSessions: assertFunction(projectAgent?.listSessions, 'projectAgent.listSessions'),
    getSession: assertFunction(projectAgent?.getSession, 'projectAgent.getSession'),
    cancelSession: assertFunction(projectAgent?.cancelSession, 'projectAgent.cancelSession'),
    resumeSession: assertFunction(projectAgent?.resumeSession, 'projectAgent.resumeSession'),
    listApprovals: assertFunction(projectAgent?.listApprovals, 'projectAgent.listApprovals'),
    decideApproval: assertFunction(projectAgent?.decideApproval, 'projectAgent.decideApproval'),
    markRead: assertFunction(projectAgent?.markRead, 'projectAgent.markRead'),
    search: assertFunction(projectAgent?.search, 'projectAgent.search'),
    listHistory: assertFunction(projectAgent?.listHistory, 'projectAgent.listHistory'),
    continueHistory: assertFunction(projectAgent?.continueHistory, 'projectAgent.continueHistory'),
    startFamiliarize: assertFunction(projectAgent?.startFamiliarize, 'projectAgent.startFamiliarize'),
    confirmResult: assertFunction(projectAgent?.confirmResult, 'projectAgent.confirmResult'),
    acceptReadme: assertFunction(projectAgent?.acceptReadme, 'projectAgent.acceptReadme'),
    takeoverHost: assertFunction(projectAgent?.takeoverHost, 'projectAgent.takeoverHost'),
    retry: assertFunction(projectAgent?.retry, 'projectAgent.retry'),
    diagnostics: assertFunction(projectAgent?.diagnostics, 'projectAgent.diagnostics'),
  };

  return Object.freeze([
    owner('project-agent-ipc', (ipc) => {
      ipc.handle('project-agent:list', (_event, payload) => ports.list(payload));
      ipc.handle('project-agent:get', (_event, payload) => ports.get(payload));
      ipc.handle('project-agent:read-avatar', (_event, payload) => ports.readAvatar(payload));
      ipc.handle('project-agent:create', (event, payload) => ports.create(payload, event.sender));
      ipc.handle('project-agent:update-profile', (event, payload) => ports.updateProfile(payload, event.sender));
      ipc.handle('project-agent:delete', (_event, payload) => ports.deleteBot(payload));
      ipc.handle('project-agent:submit-input', (_event, payload) => ports.submitInput(payload));
      ipc.handle('project-agent:read-conversation', (_event, payload) => ports.readConversation(payload));
      ipc.handle('project-agent:read-evidence', (_event, payload) => ports.readEvidence(payload));
      ipc.handle('project-agent:list-sessions', (_event, payload) => ports.listSessions(payload));
      ipc.handle('project-agent:get-session', (_event, payload) => ports.getSession(payload));
      ipc.handle('project-agent:cancel-session', (_event, payload) => ports.cancelSession(payload));
      ipc.handle('project-agent:resume-session', (_event, payload) => ports.resumeSession(payload));
      ipc.handle('project-agent:list-approvals', (_event, payload) => ports.listApprovals(payload));
      ipc.handle('project-agent:decide-approval', (_event, payload) => ports.decideApproval(payload));
      ipc.handle('project-agent:mark-read', (_event, payload) => ports.markRead(payload));
      ipc.handle('project-agent:search', (_event, payload) => ports.search(payload));
      ipc.handle('project-agent:list-history', (_event, payload) => ports.listHistory(payload));
      ipc.handle('project-agent:continue-history', (_event, payload) => ports.continueHistory(payload));
      ipc.handle('project-agent:start-familiarize', (_event, payload) => ports.startFamiliarize(payload));
      ipc.handle('project-agent:confirm-result', (_event, payload) => ports.confirmResult(payload));
      ipc.handle('project-agent:accept-readme', (_event, payload) => ports.acceptReadme(payload));
      ipc.handle('project-agent:retry', (_event, payload) => ports.retry(payload));
      ipc.handle('project-agent:takeover-host', (_event, payload) => ports.takeoverHost(payload));
      ipc.handle('project-agent:diagnostics', (event, payload) => ports.diagnostics(payload, event.sender));
    }),
  ]);
}
