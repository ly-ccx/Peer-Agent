export function createProjectionGuard({ getSession, getProjection }) {
  function validateRequest(event) {
    const session = getSession();
    const projection = getProjection();
    const call = event?.call;

    if (event?.type !== 'client_tool_call.request') {
      return { accepted: false, reason: 'unsupported_event_type' };
    }

    if (!call?.toolCallId || !call?.capabilityId) {
      return { accepted: false, reason: 'missing_tool_call_identity' };
    }

    if (event.sessionId !== session.sessionId) {
      return { accepted: false, reason: 'session_mismatch' };
    }

    if (!projection) {
      return { accepted: false, reason: 'projection_not_ready' };
    }

    if (event.projectionId !== projection.projectionId) {
      return { accepted: false, reason: 'projection_mismatch' };
    }

    const capability = projection.capabilities.find((item) => item.capabilityId === call.capabilityId);
    if (!capability) {
      return { accepted: false, reason: 'capability_not_projected' };
    }

    if (capability.health === 'policy_disabled' || capability.health === 'local_disabled') {
      return { accepted: false, reason: capability.health };
    }

    return { accepted: true, capability };
  }

  return { validateRequest };
}
