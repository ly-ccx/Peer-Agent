function assertSource(source) {
  if (!source || typeof source !== 'object') {
    throw new Error('Prompt source must be an object.');
  }
  if (!source.id || typeof source.id !== 'string') {
    throw new Error('Prompt source must declare id.');
  }
  if (!source.layer || typeof source.layer !== 'string') {
    throw new Error(`Prompt source ${source.id} must declare layer.`);
  }
  if (typeof source.observe !== 'function') {
    throw new Error(`Prompt source ${source.id} must implement observe().`);
  }
  if (typeof source.render !== 'function') {
    throw new Error(`Prompt source ${source.id} must implement render().`);
  }
}

export function createPromptSourceRegistry({ sources = [] } = {}) {
  const sourceById = new Map();

  function register(source) {
    assertSource(source);
    if (sourceById.has(source.id)) {
      throw new Error(`Duplicate prompt source: ${source.id}`);
    }
    sourceById.set(source.id, source);
    return source;
  }

  sources.forEach(register);

  return {
    register,
    getSource: (id) => sourceById.get(id) ?? null,
    listSources: () => [...sourceById.values()],
    listSourceIds: () => [...sourceById.keys()],
  };
}
