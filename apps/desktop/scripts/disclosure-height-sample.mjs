/**
 * 单帧不能跨过披露高度的 80%。
 * 更长的采样间隔只说明中间帧没被采到，不能当成动画是连续的。
 * 但两次样本已经相差整段高度时，仍然是跳变，不因为间隔变长就放过。
 */
export function disclosureHeightSnapped(samples) {
  const heights = samples.map(sample => sample.height);
  const span = Math.max(...heights) - Math.min(...heights);
  if (!(span > 0)) return false;
  return samples.slice(1).some((sample, index) => {
    const previous = samples[index];
    const gap = sample.at - previous.at;
    const delta = Math.abs(sample.height - previous.height);
    if (gap <= 32) return delta >= span * 0.8;
    return delta >= span - 0.5;
  });
}
