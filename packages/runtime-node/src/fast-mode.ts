/**
 * Product Fast mode admission.
 *
 * Desktop and CLI share this gate: only ChatGPT / Grok OAuth may send
 * Responses `service_tier: "priority"`. Session flags may persist `true`
 * across model switches; encoding still requires this admission.
 */
export function supportsFastMode(authMethod: string | null | undefined): boolean {
  return authMethod === 'oauth_chatgpt' || authMethod === 'oauth_grok';
}

export function effectiveFastMode(
  authMethod: string | null | undefined,
  fastMode: boolean | null | undefined,
): boolean {
  return supportsFastMode(authMethod) && fastMode === true;
}
