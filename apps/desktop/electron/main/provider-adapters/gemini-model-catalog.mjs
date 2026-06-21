export async function listGeminiModels(tokens, { projectId, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' } = {}) {
  if (!tokens?.access) throw new Error('oauth_not_logged_in');
  const headers = { Authorization: `Bearer ${tokens.access}` };
  if (projectId) headers['x-goog-user-project'] = projectId;
  const res = await fetch(`${String(baseUrl || '').replace(/\/+$/, '')}/models`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini models list failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const models = (Array.isArray(data.models) ? data.models : [])
    .filter((model) => model?.name && Array.isArray(model.supportedGenerationMethods)
      && model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => {
      const id = String(model.name).replace(/^models\//, '');
      return {
        id,
        label: model.displayName || id,
        contextWindow: model.inputTokenLimit,
        maxOutputTokens: model.outputTokenLimit,
      };
    });
  return { models, source: 'remote' };
}
