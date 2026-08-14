import anthropicIcon from '../../assets/llm-providers/anthropic.png';
import bailianIcon from '../../assets/llm-providers/bailian.png';
import deepseekIcon from '../../assets/llm-providers/deepseek.png';
import geminiIcon from '../../assets/llm-providers/gemini.jpg';
import kimiIcon from '../../assets/llm-providers/kimi.png';
import metaIcon from '../../assets/llm-providers/meta.png';
import minimaxIcon from '../../assets/llm-providers/minimax.png';
import mistralIcon from '../../assets/llm-providers/mistral.png';
import moonshotIcon from '../../assets/llm-providers/moonshot.png';
import openaiIcon from '../../assets/llm-providers/openai.png';
import opencodeIcon from '../../assets/llm-providers/opencode.png';
import openrouterIcon from '../../assets/llm-providers/openrouter.jpg';
import qoderIcon from '../../assets/llm-providers/qoder.svg';
import qwenIcon from '../../assets/llm-providers/qwen.png';
import volcengineIcon from '../../assets/llm-providers/volcengine.png';
import xaiIcon from '../../assets/llm-providers/xai.png';
import xiaomiIcon from '../../assets/llm-providers/xiaomi.png';
import zhipuIcon from '../../assets/llm-providers/zhipu.png';
import { llmBrandLabel, resolveLlmBrand, type LlmBrandHints, type LlmBrandId } from './llmBrand';

/** Original images published by the providers; provenance is recorded in assets/llm-providers/SOURCES.md. */
const OFFICIAL_ASSETS: Readonly<Partial<Record<LlmBrandId, string>>> = {
  openai: openaiIcon,
  anthropic: anthropicIcon,
  google: geminiIcon,
  xai: xaiIcon,
  qoder: qoderIcon,
  deepseek: deepseekIcon,
  zhipu: zhipuIcon,
  kimi: kimiIcon,
  moonshot: moonshotIcon,
  minimax: minimaxIcon,
  volcengine: volcengineIcon,
  xiaomi: xiaomiIcon,
  bailian: bailianIcon,
  opencode: opencodeIcon,
  openrouter: openrouterIcon,
  qwen: qwenIcon,
  meta: metaIcon,
  mistral: mistralIcon,
};

export function llmBrandAsset(brand: LlmBrandId): string | null {
  return OFFICIAL_ASSETS[brand] ?? null;
}

export function LlmBrandIcon({ className = '', ...hints }: LlmBrandHints & { readonly className?: string }) {
  const brand = resolveLlmBrand(hints);
  const label = llmBrandLabel(brand);
  const asset = llmBrandAsset(brand);
  return (
    <span className={`llm-brand-icon is-${brand} ${className}`.trim()} title={label} aria-label={label}>
      {asset ? (
        <img src={asset} alt="" aria-hidden="true" draggable={false} />
      ) : (
        <svg className="llm-brand-icon-signal" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 12h4l2.2-4 3.6 8L16 12h4" />
          <circle cx="4" cy="12" r="1.4" />
          <circle cx="20" cy="12" r="1.4" />
        </svg>
      )}
    </span>
  );
}
