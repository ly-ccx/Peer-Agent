import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_EFFORT_LEVELS,
  LAST_MODEL_PROVIDER_KEY,
  hasTunableEffortLevels,
  normalizeEffortLevels,
  readLastModelProviderId,
  resolveDraftModelProviderId,
  resolveModelSwitchEffort,
  resolveModelSwitchState,
  resolvePreferredEffort,
  resolveProviderById,
  writeLastModelProviderId,
} from './preferences.ts';

describe('normalizeEffortLevels', () => {
  it('falls back to BASE_EFFORT_LEVELS when input is undefined / null / empty', () => {
    assert.deepEqual(normalizeEffortLevels(undefined), BASE_EFFORT_LEVELS);
    assert.deepEqual(normalizeEffortLevels(null), BASE_EFFORT_LEVELS);
    assert.deepEqual(normalizeEffortLevels([]), BASE_EFFORT_LEVELS);
  });

  it('keeps Anthropic/OpenAI native levels without inventing extra off when omitted', () => {
    // channel 的 effortLevels 不含 off 时，不再强制补 off；保持渠道声明。
    const result = normalizeEffortLevels(['low', 'default', 'high', 'xhigh']);
    assert.deepEqual(result, ['low', 'default', 'high', 'xhigh']);
  });

  it('preserves Grok low/medium/high and does not inject off', () => {
    const result = normalizeEffortLevels(['low', 'medium', 'high']);
    assert.deepEqual(result, ['low', 'medium', 'high']);
    assert.equal(result.includes('off'), false);
  });

  it('keeps four levels for a channel that declares off', () => {
    const result = normalizeEffortLevels(['off', 'low', 'default', 'high']);
    assert.deepEqual(result, ['off', 'low', 'default', 'high']);
  });

  it('dedupes off when channel already includes it (e.g. Google off/default)', () => {
    const result = normalizeEffortLevels(['off', 'default']);
    assert.deepEqual(result, ['off', 'default']);
  });

  it('always sorts to canonical order off→low→medium→default→high→xhigh→max', () => {
    const result = normalizeEffortLevels(['xhigh', 'high', 'medium', 'low', 'default']);
    assert.deepEqual(result, ['low', 'medium', 'default', 'high', 'xhigh']);
  });

  it('drops invalid values; falls back to BASE when nothing valid remains', () => {
    assert.deepEqual(normalizeEffortLevels(['bogus', 'nope']), BASE_EFFORT_LEVELS);
  });

  it('drops invalid values but keeps valid ones without inventing off', () => {
    const result = normalizeEffortLevels(['low', 'bogus', 'high']);
    assert.deepEqual(result, ['low', 'high']);
  });

  it('keeps the model-native max level after normalization', () => {
    assert.deepEqual(
      normalizeEffortLevels(['low', 'default', 'high', 'max']),
      ['low', 'default', 'high', 'max'],
    );
  });
});

describe('hasTunableEffortLevels', () => {
  it('returns false for empty / null / undefined', () => {
    assert.equal(hasTunableEffortLevels(undefined), false);
    assert.equal(hasTunableEffortLevels(null), false);
    assert.equal(hasTunableEffortLevels([]), false);
  });

  it('returns false when the only level is off (degenerate channel)', () => {
    // e.g. Qoder Cantus: supportsReasoning=true but effortLevels=['off']
    assert.equal(hasTunableEffortLevels(['off']), false);
  });

  it('returns true when there is at least one non-off level', () => {
    assert.equal(hasTunableEffortLevels(['off', 'default']), true);
    assert.equal(hasTunableEffortLevels(['low', 'medium', 'high']), true);
    assert.equal(hasTunableEffortLevels(['high']), true);
  });
});

describe('resolvePreferredEffort', () => {
  it('uses channel defaultEffort when present', () => {
    assert.equal(resolvePreferredEffort(['low', 'medium', 'high'], 'high'), 'high');
  });

  it('falls back to high before medium/low when no preferred default', () => {
    assert.equal(resolvePreferredEffort(['low', 'medium', 'high']), 'high');
  });
});

describe('resolveModelSwitchEffort', () => {
  it('maps the previous highest xhigh level to a target model max level', () => {
    assert.equal(resolveModelSwitchEffort('xhigh', ['off', 'low', 'default', 'high', 'max']), 'max');
  });

  it('preserves an effort level supported by the target model', () => {
    assert.equal(resolveModelSwitchEffort('high', ['off', 'low', 'default', 'high', 'max']), 'high');
  });

  it('falls back to target default when the old level has no equivalent', () => {
    assert.equal(resolveModelSwitchEffort('low', ['off', 'default']), 'default');
  });

  it('maps default/off to Grok preferred high default', () => {
    assert.equal(
      resolveModelSwitchEffort('default', ['low', 'medium', 'high'], 'high'),
      'high',
    );
    assert.equal(
      resolveModelSwitchEffort('off', ['low', 'medium', 'high'], 'high'),
      'high',
    );
  });
});

describe('resolveModelSwitchState', () => {
  it('switches model capability state atomically and discards the previous context snapshot', () => {
    assert.deepEqual(resolveModelSwitchState({
      providerId: 'chatgpt::gpt-5.6-sol',
      currentEffort: 'xhigh',
      targetLevels: ['off', 'low', 'default', 'high', 'max'],
    }), {
      modelProviderId: 'chatgpt::gpt-5.6-sol',
      effort: 'max',
      authoritativeContext: null,
    });
  });

  it('uses preferredDefault when switching onto Grok-like levels', () => {
    assert.deepEqual(resolveModelSwitchState({
      providerId: 'grok::grok-4.5',
      currentEffort: 'default',
      targetLevels: ['low', 'medium', 'high'],
      preferredDefault: 'high',
    }), {
      modelProviderId: 'grok::grok-4.5',
      effort: 'high',
      authoritativeContext: null,
    });
  });
});

describe('last model provider shared memory', () => {
  const memory = new Map<string, string>();

  const installLocalStorage = () => {
    const storage = {
      getItem(key: string) {
        return memory.has(key) ? memory.get(key)! : null;
      },
      setItem(key: string, value: string) {
        memory.set(key, String(value));
      },
      removeItem(key: string) {
        memory.delete(key);
      },
      clear() {
        memory.clear();
      },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
  };

  it('writes and reads the shared last-model-provider key', () => {
    memory.clear();
    installLocalStorage();
    writeLastModelProviderId('chatgpt::gpt-5.6-sol');
    assert.equal(localStorage.getItem(LAST_MODEL_PROVIDER_KEY), 'chatgpt::gpt-5.6-sol');
    assert.equal(readLastModelProviderId(), 'chatgpt::gpt-5.6-sol');
  });

  it('ignores empty values and blank strings', () => {
    memory.clear();
    installLocalStorage();
    writeLastModelProviderId(null);
    writeLastModelProviderId('');
    writeLastModelProviderId('   ');
    assert.equal(readLastModelProviderId(), null);
  });
});

describe('resolveProviderById / resolveDraftModelProviderId', () => {
  const providers = [
    {
      id: 'uuid-default',
      groupId: 'grok-official',
      model: 'grok-3',
      apiKeyConfigured: true,
      isDefault: true,
    },
    {
      id: 'uuid-grok-45',
      groupId: 'grok-official',
      model: 'grok-4.5',
      apiKeyConfigured: true,
      isDefault: false,
    },
    {
      id: 'uuid-disabled',
      groupId: 'other',
      model: 'x',
      apiKeyConfigured: false,
      isDefault: false,
    },
  ] as const;

  it('resolves exact id and legacy groupId::model', () => {
    assert.equal(resolveProviderById(providers, 'uuid-grok-45')?.id, 'uuid-grok-45');
    assert.equal(resolveProviderById(providers, 'grok-official::grok-4.5')?.id, 'uuid-grok-45');
    assert.equal(resolveProviderById(providers, 'missing::model'), null);
  });

  it('seeds draft from remembered last model when resolvable and configured', () => {
    assert.equal(
      resolveDraftModelProviderId(providers, 'grok-official::grok-4.5'),
      'uuid-grok-45',
    );
    assert.equal(resolveDraftModelProviderId(providers, 'uuid-disabled'), null);
    assert.equal(resolveDraftModelProviderId(providers, null), null);
  });
});
