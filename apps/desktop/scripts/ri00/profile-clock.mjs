/** CDP timeDeltas are microseconds, the first relative to profile.startTime. */
export function profileClock(profile, markers) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const samples = new Map(markers.map(marker => [marker.name, []]));
  const ownership = new Map();
  for (const marker of markers) {
    const pending = profile.nodes.filter(node => node.callFrame.functionName === marker.name).map(node => node.id);
    while (pending.length) { const id = pending.pop(); ownership.set(id, marker.name); pending.push(...(nodes.get(id).children || [])); }
  }
  let clock = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    clock += profile.timeDeltas[i];
    samples.get(ownership.get(profile.samples[i]))?.push(clock / 1000);
  }
  const intervals = markers.map(marker => {
    const times = samples.get(marker.name);
    if (times.length < 3) throw new Error('profile_clock_marker_not_sampled');
    return { name: marker.name, samples: times.length, lower: marker.start - times[0], upper: marker.end - times.at(-1) };
  });
  const lower = Math.max(...intervals.map(row => row.lower)), upper = Math.min(...intervals.map(row => row.upper));
  if (lower > upper || upper - lower > 10) throw new Error('profile_clock_calibration_invalid');
  return { offsetMs: (lower + upper) / 2, uncertaintyMs: (upper - lower) / 2, lower, upper, markers: intervals };
}
