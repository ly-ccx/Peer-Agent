import { INTERACTIVE_INSPECT_CAPABILITY as INSPECT, INTERACTIVE_PUBLISH_CAPABILITY as PUBLISH } from '@peer-agent/protocol';

/** The same role map is used by inventory, projection and the actual Provider. */
export function interactiveExecutionRole(profile = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  if (profile.role === 'project_agent') return 'project_agent';
  if (profile.role === 'work_session') {
    const kind = profile.agentKind ?? profile.turnContext?.agentKind;
    return kind === 'worker' ? 'session_worker' : ['verifier', 'visual_verifier'].includes(kind) ? kind : null;
  }
  return null;
}
export function interactiveCapabilitiesForProfile(profile) {
  const role = interactiveExecutionRole(profile);
  return role === 'session_worker' ? [PUBLISH, INSPECT] : role ? [INSPECT] : [];
}
export function interactiveExcludedCapabilityPrefixes(profile) {
  const allowed = interactiveCapabilitiesForProfile(profile);
  return [PUBLISH, INSPECT].filter(capabilityId => !allowed.includes(capabilityId));
}
export function interactiveRoleAllows(capabilityId, profile) {
  return ![PUBLISH, INSPECT].includes(capabilityId) || interactiveCapabilitiesForProfile(profile).includes(capabilityId);
}

/** Publishing requires its original-call status/read path in the same projection.
 * @template {{capabilityId: string}} T
 * @param {readonly T[]} tools
 * @returns {readonly T[]}
 */
export function admitInteractiveToolSet(tools) {
  return tools.some(tool => tool.capabilityId === INSPECT) ? tools : tools.filter(tool => tool.capabilityId !== PUBLISH);
}
