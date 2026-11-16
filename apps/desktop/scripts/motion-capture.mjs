/** Browser-side validation only: bounded trusted input, then a full observation
 * interval. DOM state and CSS remain the measured facts, never timer-derived.
 * Self-contained so Playwright can serialize this function into the renderer. */
export function installMotionCapture(node, { kind, expectedClicks }) {
  node.__rcMotionCapture = new Promise(resolve => {
    const samples = [], start = performance.now();
    const trigger = kind === 'disclosure' ? node.querySelector(':scope > summary') : node;
    const panel = kind === 'panel' ? document.querySelector('.bot-work-panel') : null;
    let clicks = 0, lastClick = null, raf = 0, finished = false, deadline;
    const finish = timeoutPhase => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); cancelAnimationFrame(raf); trigger.removeEventListener('click', mark);
      const end = performance.now();
      resolve({ samples, clicks, timedOut: timeoutPhase !== null, timeoutPhase,
        lastClickAt: lastClick === null ? null : lastClick - start,
        observationMs: lastClick === null ? null : end - lastClick });
    };
    const mark = () => {
      lastClick = performance.now(); clicks += 1;
      // Keep the6s deadline for all intended input. Only its completion starts
      // a separate bounded observation; an extra click cannot extend the cap.
      if (clicks === expectedClicks) {
        clearTimeout(deadline);
        deadline = setTimeout(() => finish('observation'), 6000);
      }
    };
    const frame = now => {
      if (kind === 'disclosure') {
        const style = getComputedStyle(node, '::details-content');
        samples.push({ at: Math.round(now - start), height: node.getBoundingClientRect().height,
          opacity: style.opacity, visibility: style.contentVisibility, open: node.open,
          arrow: getComputedStyle(node.querySelector(':scope > summary > svg:last-child')).transform });
      } else {
        samples.push({ at: Math.round(now - start), opacity: Number(getComputedStyle(panel).opacity),
          open: panel.dataset.motionOpen === 'true', inert: panel.inert });
      }
      if (clicks >= expectedClicks && now - lastClick >= 480) finish(null);
      else raf = requestAnimationFrame(frame);
    };
    deadline = setTimeout(() => finish('input'), 6000);
    trigger.addEventListener('click', mark);
    raf = requestAnimationFrame(frame);
  });
}
