// Canonical rendering helpers shared by every Peer Agent host.
export function joinPromptSections(sections) {
  return sections.filter(Boolean).join('\n\n');
}

export function bulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}
