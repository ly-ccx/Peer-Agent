export { createSessionVerification } from '@peer-agent/runtime-node';
let current = null;

export function installSessionVerification(port) {
  current = port && typeof port === 'object' ? port : null;
  const installed = current;
  return () => { if (current === installed) current = null; };
}
export function liveSessionVerification() {
  return {
    available: () => current != null,
    facts: (sessionId) => current.facts(sessionId),
    run: (input) => current.run(input),
    markVerifying: (sessionId) => current.markVerifying?.(sessionId),
    finish: (sessionId) => current.finish?.(sessionId),
    record: (input) => current.record?.(input),
  };
}
