const basename = value => value.split(/[\\/]/).at(-1) || '';

/** Root clocks are exact observations; CPU attribution is clipped sampling, not exact span timing. */
export function analyzeGap(observation, profile, calibration, gap) {
  const roots = observation.records.filter(row => row.entered < gap.to && row.syncEnd > gap.from)
    .map(row => ({ id: row.id, kind: row.kind, name: row.name,
      start: Math.max(gap.from, row.entered), end: Math.min(gap.to, row.syncEnd),
      synchronousMs: row.synchronousMs })).sort((a,b) => a.start - b.start);
  const union = [];
  for (const root of roots) {
    const previous = union.at(-1);
    if (previous && root.start <= previous[1]) previous[1] = Math.max(previous[1], root.end);
    else union.push([root.start, root.end]);
  }
  const uncovered = []; let cursor = gap.from;
  for (const [start,end] of union) { if (start > cursor) uncovered.push([cursor,start]); cursor = end; }
  if (cursor < gap.to) uncovered.push([cursor,gap.to]);
  const nodes = new Map(profile.nodes.map(node => [node.id,node])), parents = new Map();
  for (const node of profile.nodes) for (const id of node.children || []) parents.set(id,node.id);
  const chains = new Map();
  function stackOf(sampleId) {
    if (!chains.has(sampleId)) {
      let id = sampleId;
      const value = [], seen = new Set();
      while (nodes.has(id) && !seen.has(id)) {
        seen.add(id); const frame = nodes.get(id).callFrame;
        value.push([frame.functionName,basename(frame.url),frame.lineNumber + 1]); id = parents.get(id);
      }
      chains.set(sampleId,value.reverse());
    }
    return chains.get(sampleId);
  }
  const sources = new Map(), stacks = new Map();
  let clock = profile.startTime / 1000 + calibration.offsetMs;
  for (let i=0;i<profile.samples.length;i++) {
    const end = clock + profile.timeDeltas[i] / 1000;
    const duration = uncovered.reduce((sum,[a,b]) => sum + Math.max(0,Math.min(b,end)-Math.max(a,clock)),0);
    clock = end; if (!duration) continue;
    const stack = stackOf(profile.samples[i]);
    const roster = stack.find(frame => frame[0] === 'resolveRoster' && frame[1] === 'project-agent-host.mjs');
    const application = stack.find(frame => /^(project-agent-host|llm-chat-service|provider-request-coordinator|agent-turn-executor|automation-runtime-owner|project-agent-application-service|tray-controller)\.mjs$/.test(frame[1]));
    const frame = roster || application || stack.at(-1) || ['unclassified','',0];
    const source = frame[1] ? `${frame[1]}:${frame[0]}:${frame[2]}` : frame[0] || 'unclassified';
    sources.set(source,(sources.get(source)||0)+duration);
    const key = JSON.stringify(stack); stacks.set(key,(stacks.get(key)||0)+duration);
  }
  return { gap, roots, rootUnionMs: union.reduce((sum,[a,b])=>sum+b-a,0), uncoveredIntervals: uncovered,
    uncoveredMs: uncovered.reduce((sum,[a,b])=>sum+b-a,0), profileClock: calibration,
    limitation: 'Sample intervals approximate CPU attribution; clocks and interval union do not turn samples into exact call durations.',
    uncoveredSampledAttribution: [...sources].map(([source,sampledMs])=>({source,sampledMs})).sort((a,b)=>b.sampledMs-a.sampledMs),
    topUncoveredStacks: [...stacks].map(([key,sampledMs])=>({sampledMs,rootToLeaf:JSON.parse(key)})).sort((a,b)=>b.sampledMs-a.sampledMs) };
}
