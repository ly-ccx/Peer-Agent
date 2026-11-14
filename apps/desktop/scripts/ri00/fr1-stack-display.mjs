/** Presentation is derived outside the observed process from its durable current facts. */
export function formatFr1Stack(stack, scripts) {
  if (stack.encoding !== 'node-location-tuples-v1') throw Error('fr1_stack_encoding');
  return 'FR1 current synchronous JS stack\n'+stack.frames.map(([name,scriptId,line,column]) => {
    if (!scripts.has(scriptId)) throw Error('fr1_stack_script_missing');
    return '    at '+(name||'<anonymous>')+' ('+(scripts.get(scriptId)||'<script '+scriptId+'>')+':'+line+':'+column+')';
  }).join('\n');
}
