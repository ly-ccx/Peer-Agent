import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

function readSystemInstructions(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.systemInstructions === 'string' ? settings.systemInstructions : '';
}

/**
 * SystemInstructionsPanel 是「系统指令」这一 System Context 输入的独立表达层。
 *
 * 系统指令属于 System Context 装配(云端认知的上下文输入),与模型 Provider
 * 连接配置(LlmSettingsPanel)是不同职责,因此从模型配置面板拆出为独立分区。
 * 本面板只负责该项的本地编辑与读写,数据仍走既有的 clientApi.updateSettings 契约,
 * 不新增任何能力执行路径。
 */
export function SystemInstructionsPanel({
  i18n,
  onBack,
  onSystemInstructionsChanged,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
  readonly onSystemInstructionsChanged?: (value: string) => void;
}) {
  const isZh = i18n.locale === 'zh-CN';
  const [systemInstructions, setSystemInstructions] = useState(() => readSystemInstructions(clientApi.initialSettings));
  const [systemInstructionsDraft, setSystemInstructionsDraft] = useState(() => readSystemInstructions(clientApi.initialSettings));
  const [savingInstructions, setSavingInstructions] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void clientApi.getSettings().then((settings) => {
      if (cancelled) return;
      const value = readSystemInstructions(settings);
      setSystemInstructions(value);
      setSystemInstructionsDraft(value);
      onSystemInstructionsChanged?.(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [onSystemInstructionsChanged]);

  const handleSave = useCallback(async () => {
    setSavingInstructions(true);
    try {
      const next = await clientApi.updateSettings({ systemInstructions: systemInstructionsDraft });
      const saved = readSystemInstructions(next);
      setSystemInstructions(saved);
      setSystemInstructionsDraft(saved);
      onSystemInstructionsChanged?.(saved);
    } catch { /* silent */ } finally {
      setSavingInstructions(false);
    }
  }, [systemInstructionsDraft, onSystemInstructionsChanged]);

  return (
    <div className="system-instructions-panel">
      {onBack ? (
        <header className="llm-settings-header">
          <button type="button" onClick={onBack} aria-label="Back">←</button>
          <strong>{isZh ? '个性化设置' : 'Personalization'}</strong>
        </header>
      ) : null}

      <section className="llm-instructions-card">
        <header className="llm-instructions-header">
          <strong>{isZh ? '个性化设置' : 'Personalization'}</strong>
        </header>
        <p className="llm-instructions-hint">
          {isZh
            ? '这些设置会作为 System Context 注入对话,影响模型的回答偏好与约束。'
            : 'These settings enter the conversation as System Context, shaping the model’s response preferences and constraints.'}
        </p>
        <textarea
          value={systemInstructionsDraft}
          rows={8}
          placeholder={isZh ? '回答偏好、代码风格或项目约束' : 'Response preferences, code style, or project constraints'}
          onChange={(event) => setSystemInstructionsDraft(event.target.value)}
        />
        <div className="llm-instructions-actions">
          <button
            type="button"
            onClick={() => setSystemInstructionsDraft(systemInstructions)}
            disabled={savingInstructions || systemInstructionsDraft === systemInstructions}
          >
            {isZh ? '还原' : 'Reset'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleSave}
            disabled={savingInstructions || systemInstructionsDraft === systemInstructions}
          >
            {savingInstructions ? '...' : (isZh ? '保存设置' : 'Save Settings')}
          </button>
        </div>
      </section>
    </div>
  );
}
