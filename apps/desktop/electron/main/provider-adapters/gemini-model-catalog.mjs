/**
 * Gemini 订阅模型目录。
 *
 * 对齐 google-gemini/gemini-cli：
 * - 模型列表以本地 curated 目录为准（packages/core/src/config/models.ts + acpUtils.buildAvailableModels）
 * - 不是靠 GET /v1beta/models 远程枚举当真相源
 * - 默认模型使用官方 DEFAULT_GEMINI_MODEL
 *
 * 参考：
 * - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/models.ts
 * - https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpUtils.ts
 */

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** gemini-cli DEFAULT_GEMINI_MODEL */
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-pro';

/** gemini-cli DEFAULT_GEMINI_FLASH_MODEL（未开 3.5 实验时） */
export const GEMINI_DEFAULT_FLASH_MODEL = 'gemini-2.5-flash';

/** gemini-cli DEFAULT_GEMINI_3_5_FLASH_MODEL */
export const GEMINI_3_5_FLASH_MODEL = 'gemini-3.5-flash';

/** gemini-cli SECONDARY_GEMINI_3_5_FLASH_MODEL */
export const GEMINI_3_FLASH_MODEL = 'gemini-3-flash';

/** gemini-cli DEFAULT_GEMINI_FLASH_LITE_MODEL */
export const GEMINI_DEFAULT_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite';

/** gemini-cli PREVIEW_* */
export const GEMINI_PREVIEW_PRO_MODEL = 'gemini-3-pro-preview';
export const GEMINI_PREVIEW_3_1_PRO_MODEL = 'gemini-3.1-pro-preview';
export const GEMINI_PREVIEW_FLASH_MODEL = 'gemini-3-flash-preview';

/**
 * 订阅登录可选模型目录（curated）。
 * 顺序对齐 gemini-cli buildAvailableModels：
 * preview(若可) → stable pro → flash → flash-lite
 *
 * 默认对订阅账号露出 preview；若后续有账号能力探测，可再收紧。
 */
export const GEMINI_CURATED_MODELS = [
  {
    id: GEMINI_PREVIEW_PRO_MODEL,
    label: 'Gemini 3 Pro Preview',
    description: 'gemini-cli PREVIEW_GEMINI_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: true,
  },
  {
    id: GEMINI_PREVIEW_3_1_PRO_MODEL,
    label: 'Gemini 3.1 Pro Preview',
    description: 'gemini-cli PREVIEW_GEMINI_3_1_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: true,
  },
  {
    id: GEMINI_PREVIEW_FLASH_MODEL,
    label: 'Gemini 3 Flash Preview',
    description: 'gemini-cli PREVIEW_GEMINI_FLASH_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: true,
  },
  {
    id: GEMINI_DEFAULT_MODEL,
    label: 'Gemini 2.5 Pro',
    description: 'gemini-cli DEFAULT_GEMINI_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: false,
  },
  {
    id: GEMINI_3_5_FLASH_MODEL,
    label: 'Gemini 3.5 Flash',
    description: 'gemini-cli DEFAULT_GEMINI_3_5_FLASH_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: false,
  },
  {
    id: GEMINI_3_FLASH_MODEL,
    label: 'Gemini 3 Flash',
    description: 'gemini-cli SECONDARY_GEMINI_3_5_FLASH_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: false,
  },
  {
    id: GEMINI_DEFAULT_FLASH_MODEL,
    label: 'Gemini 2.5 Flash',
    description: 'gemini-cli DEFAULT_GEMINI_FLASH_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: false,
  },
  {
    id: GEMINI_DEFAULT_FLASH_LITE_MODEL,
    label: 'Gemini 3.1 Flash-Lite',
    description: 'gemini-cli DEFAULT_GEMINI_FLASH_LITE_MODEL',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    preview: false,
  },
];

function cloneModels(models) {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  }));
}

/**
 * 默认模型选择：对齐 gemini-cli 的 DEFAULT_GEMINI_MODEL。
 * 列表里没有时再退到稳定 flash / 第一项。
 */
export function preferGeminiModel(models = []) {
  const list = Array.isArray(models) ? models.filter((m) => m?.id) : [];
  if (list.length === 0) return null;

  const preferredIds = [
    GEMINI_DEFAULT_MODEL,
    GEMINI_DEFAULT_FLASH_MODEL,
    GEMINI_3_5_FLASH_MODEL,
    GEMINI_3_FLASH_MODEL,
    GEMINI_DEFAULT_FLASH_LITE_MODEL,
  ];
  for (const id of preferredIds) {
    const hit = list.find((m) => m.id === id);
    if (hit) return hit;
  }
  // 避免默认落到 preview
  const stable = list.find((m) => !/preview|exp|experimental/i.test(m.id));
  return stable || list[0];
}

/**
 * 返回 gemini-cli 风格 curated 模型目录。
 * tokens 参数保留是为了与 OAuth 登录/列表 IPC 签名兼容；目录本身不依赖远程 /models。
 */
export async function listGeminiModels(
  _tokens,
  {
    includePreview = true,
  } = {},
) {
  const models = GEMINI_CURATED_MODELS.filter((model) => includePreview || !model.preview);
  return {
    models: cloneModels(models),
    source: 'builtin',
  };
}
