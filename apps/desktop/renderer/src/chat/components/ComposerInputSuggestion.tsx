import { useLayoutEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { useInputPrediction } from '../hooks/useInputPrediction';
import './input-prediction.css';

export function ComposerInputSuggestion({ prediction, text, i18n }: {
  readonly prediction: ReturnType<typeof useInputPrediction>;
  readonly text: string;
  readonly i18n: I18nRuntime;
}) {
  const mirror = useRef<HTMLDivElement>(null), suffix = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  const candidate = prediction.view.candidate;
  useLayoutEffect(() => {
    const node = prediction.textareaRef.current, overlay = mirror.current;
    if (!node || !overlay || !candidate || typeof ResizeObserver !== 'function') {
      prediction.markPresented(false); setFits(false); return;
    }
    let frame = 0;
    const measure = () => {
      const parent = node.parentElement;
      if (!parent || !suffix.current) return;
      const field = node.getBoundingClientRect(), host = parent.getBoundingClientRect(), style = getComputedStyle(node);
      Object.assign(overlay.style, { left: `${field.left - host.left - parent.clientLeft + parent.scrollLeft}px`,
        top: `${field.top - host.top - parent.clientTop + parent.scrollTop}px`, width: `${field.width}px`, height: `${field.height}px`,
        fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
        fontStretch: style.fontStretch, fontVariant: style.fontVariant, fontKerning: style.fontKerning,
        fontFeatureSettings: style.fontFeatureSettings, fontVariationSettings: style.fontVariationSettings, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
        padding: style.padding, borderWidth: style.borderWidth, borderStyle: 'solid', borderColor: 'transparent',
        textIndent: style.textIndent, textAlign: style.textAlign, tabSize: style.tabSize,
        overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, direction: style.direction });
      overlay.scrollTop = node.scrollTop; overlay.scrollLeft = node.scrollLeft;
      const suffixNode = suffix.current;
      const fullText = candidate.insertionText;
      const fitsInside = (rects: readonly DOMRect[]) => rects.length > 0 && rects.every(rect =>
        rect.top >= field.top - 1 && rect.bottom <= field.bottom + 1
        && rect.left >= field.left - 1 && rect.right <= field.right + 1);
      const measureRects = (value: string) => {
        suffixNode.textContent = value;
        const range = document.createRange();
        range.selectNodeContents(suffixNode);
        return [...range.getClientRects()];
      };
      const fullRects = measureRects(fullText);
      let inside = fitsInside(fullRects);
      // When the composer starts at single-line height, a longer suggestion can wrap past field.bottom.
      // Clip the visual ghost preview with an ellipsis so the suggestion and Tab affordance remain usable
      // while accepting still inserts the full candidate.insertionText.
      if (!inside && fullRects.length > 0
        && fullRects[0].top >= field.top - 1 && fullRects[0].bottom <= field.bottom + 1
        && fullRects[0].left >= field.left - 1) {
        const chars = Array.from(fullText);
        let lo = 1, hi = chars.length - 1, best = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (fitsInside(measureRects(`${chars.slice(0, mid).join('')}…`))) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (best > 0) {
          suffixNode.textContent = `${chars.slice(0, best).join('')}…`;
          inside = true;
        } else {
          suffixNode.textContent = fullText;
        }
      }
      overlay.style.visibility = inside ? 'visible' : 'hidden';
      prediction.markPresented(inside); setFits(inside);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule); observer.observe(node);
    const appearance = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    appearance?.observe(document.documentElement, { attributes: true });
    appearance?.observe(document.body, { attributes: true });
    node.addEventListener('scroll', schedule); window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    measure();
    return () => { observer.disconnect(); appearance?.disconnect(); cancelAnimationFrame(frame); node.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule); document.fonts?.removeEventListener('loadingdone', schedule); prediction.markPresented(false); };
  }, [candidate, prediction.view.status, text, prediction.textareaRef]);
  if (!candidate) return null;
  return <>
    <div ref={mirror} className="input-prediction-mirror" aria-hidden="true">
      <span className="input-prediction-prefix">{text}</span><span ref={suffix}>{candidate.insertionText}</span>
    </div>
    {fits ? <>
      <button type="button" className="input-prediction-accept" data-prediction-accept="true" data-prediction-instance={candidate.composerInstanceId}
        aria-label={`${i18n.t('inputPrediction.accept')}: ${candidate.insertionText}`}
        aria-disabled={prediction.view.status === 'accepting'}
        onPointerDown={event => event.preventDefault()} onClick={prediction.accept}>
        <kbd>Tab</kbd><span>{i18n.t('inputPrediction.accept')}</span>
      </button>
      <span className="input-prediction-status" role="status">{i18n.t('inputPrediction.available')} {candidate.insertionText}</span>
    </> : null}
  </>;
}
