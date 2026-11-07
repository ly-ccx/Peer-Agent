/** A stalled sample is not a snap. One frame may cross at most 80% of the disclosure. */
export function disclosureHeightSnapped(samples) {
  const heights = samples.map(sample => sample.height);
  const span = Math.max(...heights) - Math.min(...heights);
  return samples.slice(1).some((sample, index) => {
    const previous = samples[index];
    const gap = sample.at - previous.at;
    const frames = Math.max(1, gap / 32);
    return Math.abs(sample.height - previous.height) >= span * 0.8 * frames;
  });
}
