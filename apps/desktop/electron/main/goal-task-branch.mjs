import { resolveGitBranchPrefix } from '@peer-agent/system-context';
import { createGoalTaskBranchAdapter as createPortableAdapter } from '@peer-agent/runtime-node';
export { slugifyTaskBranchName, planNeedsTaskBranch } from '@peer-agent/runtime-node';
export function createGoalTaskBranchAdapter(options = {}) {
  return createPortableAdapter({ resolvePrefix: () => resolveGitBranchPrefix(), ...options });
}
