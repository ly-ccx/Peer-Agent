export function joinPromptSections(sections) {
  return sections.filter(Boolean).join('\n\n');
}

export function bulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}
