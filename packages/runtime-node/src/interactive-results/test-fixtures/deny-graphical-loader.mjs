export function resolve(specifier, context, nextResolve) {
  if (/^(?:@openuidev\/|react(?:-dom)?(?:\/|$)|electron(?:\/|$))/.test(specifier)) throw new Error(`Unexpected interactive engine/GUI dependency on the ordinary host path: ${specifier}`);
  return nextResolve(specifier, context);
}
