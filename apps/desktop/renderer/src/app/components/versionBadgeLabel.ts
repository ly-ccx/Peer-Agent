/** Display only: release selection and version ordering remain in the updater. */
export function versionBadgeLabel(version: string): { version: string; stage?: string } {
  const candidate = /^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$/.exec(version);
  if (!candidate) return { version: `v${version}` };
  return { version: `v${candidate[1]}`, stage: `${candidate[2].toUpperCase()} ${candidate[3]}` };
}
