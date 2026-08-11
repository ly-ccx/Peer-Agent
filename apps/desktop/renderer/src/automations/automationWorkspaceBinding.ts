export function workspaceForNewAutomation(defaultWorkspace: string): string {
  return defaultWorkspace;
}

export function workspaceForExistingAutomation(workspacePath: string): string {
  return workspacePath;
}

export function hasBoundAutomationWorkspace(workspacePath: string): boolean {
  return workspacePath.trim().length > 0;
}
