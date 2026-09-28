/**
 * 旧会话和经典目标的只读投影。不读盘，不改会话文件。
 * 归档留在设置里的归档列表，不进历史对话。
 */

const TERMINAL_GOAL = new Set(['completed', 'cancelled', 'accepted']);

export function projectHistory(conversations, { workspacePath = null, includeArchived = false } = {}) {
  const wanted = workspacePath == null || workspacePath === '' ? null : String(workspacePath);
  const items = [];
  for (const meta of Array.isArray(conversations) ? conversations : []) {
    if (!meta || typeof meta !== 'object') continue;
    if (hasRole(meta)) continue;
    const status = typeof meta.status === 'string' && meta.status ? meta.status : 'active';
    if (!includeArchived && status === 'archived') continue;
    const folder = meta.workspacePath || null;
    if (wanted == null) {
      if (folder) continue;
    } else if (folder !== wanted) continue;
    items.push({
      id: typeof meta.id === 'string' ? meta.id : '',
      title: typeof meta.title === 'string' ? meta.title : '',
      workspacePath: folder,
      updatedAt: typeof meta.updatedAt === 'string' && meta.updatedAt
        ? meta.updatedAt
        : (typeof meta.createdAt === 'string' ? meta.createdAt : ''),
      status,
    });
  }
  items.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return items.filter((item) => item.id);
}

export function projectClassicGoals(plans, { workspacePath = '', conversationIds = [] } = {}) {
  const folder = typeof workspacePath === 'string' ? workspacePath : '';
  const ids = new Set((Array.isArray(conversationIds) ? conversationIds : []).filter((id) => typeof id === 'string' && id));
  const goals = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || typeof plan !== 'object' || plan.delegationOrigin) continue;
    const status = typeof plan.status === 'string' ? plan.status : '';
    if (TERMINAL_GOAL.has(status)) continue;
    const planPath = plan.targetWorkspacePath || plan.originWorkspacePath || plan.workspacePath || '';
    const conversationId = typeof plan.conversationId === 'string' ? plan.conversationId : '';
    const inWorkspace = (folder && planPath === folder) || (conversationId && ids.has(conversationId));
    if (!inWorkspace) continue;
    const planId = typeof plan.planId === 'string' ? plan.planId : '';
    if (!planId) continue;
    goals.push({
      planId,
      conversationId,
      title: typeof plan.title === 'string' && plan.title
        ? plan.title
        : (typeof plan.goal === 'string' ? plan.goal : ''),
      status,
      waitingUser: goalWaitsOnUser(plan),
      updatedAt: typeof plan.updatedAt === 'string' ? plan.updatedAt : '',
    });
  }
  return goals;
}

export function classicNeedsYouCount(goals) {
  return (Array.isArray(goals) ? goals : []).filter((goal) => goal?.waitingUser === true).length;
}

function hasRole(meta) {
  return typeof meta.role === 'string' && meta.role.trim() !== '';
}

function goalWaitsOnUser(plan) {
  if (plan?.runner?.status === 'waiting_user') return true;
  return tasksWait(plan?.tasks);
}

function tasksWait(tasks) {
  if (!Array.isArray(tasks)) return false;
  for (const task of tasks) {
    if (task?.status === 'waiting_user') return true;
    if (tasksWait(task?.subtasks)) return true;
  }
  return false;
}
