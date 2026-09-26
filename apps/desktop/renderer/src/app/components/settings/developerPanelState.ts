export function projectAgentModeEnabled(settings: { readonly projectAgentMode?: unknown } | null | undefined): boolean {
  return settings?.projectAgentMode === true;
}
