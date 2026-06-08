import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationFormValues } from './cronFormValues';
import { type TriggerModeOption, triggerModeOptions, validateFormValues } from './cronFormValues';

function CustomSelect({
  options,
  value,
  onChange,
}: {
  readonly options: readonly TriggerModeOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className={`automation-select ${open ? 'open' : ''}`}>
      <button type="button" className="automation-select-trigger" onClick={() => setOpen((v) => !v)}>
        <span>{selected?.label ?? value}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open ? (
        <ul className="automation-select-menu">
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                className={opt.value === value ? 'active' : ''}
                onClick={() => { onChange(opt.value); setOpen(false); }}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface AutomationFormProps {
  readonly initialValues: AutomationFormValues;
  readonly submitting: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (values: AutomationFormValues) => void;
  readonly onCancel: () => void;
}

export function AutomationForm({
  initialValues,
  submitting,
  submitLabel,
  onSubmit,
  onCancel,
}: AutomationFormProps) {
  const [values, setValues] = useState<AutomationFormValues>(initialValues);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(<K extends keyof AutomationFormValues>(key: K, value: AutomationFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }, []);

  const handleSubmit = useCallback(() => {
    const validationError = validateFormValues(values);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(values);
  }, [values, onSubmit]);

  return (
    <div className="automation-form">
      {error ? <p className="automation-form-error">{error}</p> : null}

      <label className="automation-form-field">
        <span>目标名称</span>
        <input
          type="text"
          maxLength={80}
          placeholder="例如：每日项目进展汇总"
          value={values.title}
          onChange={(e) => update('title', e.target.value)}
        />
      </label>

      <div className="automation-form-field">
        <span>执行节奏</span>
        <CustomSelect
          options={triggerModeOptions}
          value={values.triggerMode}
          onChange={(v) => update('triggerMode', v as AutomationFormValues['triggerMode'])}
        />
        <small className="automation-form-hint">最小执行间隔 10 分钟</small>
      </div>

      {values.triggerMode === 'custom_cron' ? (
        <label className="automation-form-field">
          <span>Cron 表达式</span>
          <input
            type="text"
            placeholder="0 6 * * *"
            value={values.cronExpr || ''}
            onChange={(e) => update('cronExpr', e.target.value)}
          />
        </label>
      ) : null}

      <fieldset className="automation-form-field">
        <legend>完成方式</legend>
        <div className="automation-form-radios">
          {(['manual_only', 'goal_achieved', 'max_runs'] as const).map((type) => (
            <label key={type}>
              <input
                type="radio"
                name="completionType"
                value={type}
                checked={values.completionType === type}
                onChange={() => update('completionType', type)}
              />
              {type === 'manual_only' ? '手动' : type === 'goal_achieved' ? '目标达成' : '次数'}
            </label>
          ))}
        </div>
      </fieldset>

      {values.completionType === 'max_runs' ? (
        <label className="automation-form-field">
          <span>最多运行次数</span>
          <input
            type="number"
            min={1}
            max={999}
            value={values.maxRuns ?? 1}
            onChange={(e) => update('maxRuns', Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      ) : null}

      <label className="automation-form-field">
        <span>Agent 指令</span>
        <textarea
          rows={5}
          maxLength={4000}
          placeholder="描述 Agent 每次执行时需要完成的目标、可接受的停止条件和输出要求"
          value={values.content}
          onChange={(e) => update('content', e.target.value)}
        />
      </label>

      <fieldset className="automation-form-field">
        <legend>结果发送</legend>
        <div className="automation-form-radios">
          <label>
            <input
              type="radio"
              name="deliveryTarget"
              value="dingtalk_self"
              checked={values.deliveryTarget === 'dingtalk_self'}
              onChange={() => update('deliveryTarget', 'dingtalk_self')}
            />
            钉钉机器人
          </label>
          <label>
            <input
              type="radio"
              name="deliveryTarget"
              value="in_conversation_only"
              checked={values.deliveryTarget === 'in_conversation_only'}
              onChange={() => update('deliveryTarget', 'in_conversation_only')}
            />
            不推送
          </label>
        </div>
      </fieldset>

      {values.deliveryTarget === 'dingtalk_self' ? (
        <>
          <fieldset className="automation-form-field">
            <legend>推送策略</legend>
            <div className="automation-form-radios">
              <label>
                <input
                  type="radio"
                  name="deliveryMode"
                  value="always"
                  checked={values.deliveryMode === 'always'}
                  onChange={() => update('deliveryMode', 'always')}
                />
                每次推送
              </label>
              <label>
                <input
                  type="radio"
                  name="deliveryMode"
                  value="condition"
                  checked={values.deliveryMode === 'condition'}
                  onChange={() => update('deliveryMode', 'condition')}
                />
                满足条件才推送
              </label>
            </div>
          </fieldset>

          {values.deliveryMode === 'condition' ? (
            <label className="automation-form-field">
              <span>推送条件</span>
              <textarea
                rows={2}
                maxLength={1000}
                placeholder="例如：只有发现异常、变化或需要我处理时才推送"
                value={values.deliveryCondition || ''}
                onChange={(e) => update('deliveryCondition', e.target.value)}
              />
            </label>
          ) : null}
        </>
      ) : null}

      <footer className="automation-form-footer">
        <button type="button" onClick={onCancel} disabled={submitting}>取消</button>
        <button type="button" className="primary" onClick={handleSubmit} disabled={submitting}>
          {submitting ? '提交中...' : submitLabel}
        </button>
      </footer>
    </div>
  );
}
