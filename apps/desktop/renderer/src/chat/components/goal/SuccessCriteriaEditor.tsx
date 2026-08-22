import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { GoalPlan, GoalSuccessCriterion } from '@peer-agent/protocol';
import { clientApi } from '../../../clientApi';
import {
  addManualCriterion,
  cloneSuccessCriteria,
  removeCriterion,
  replaceCriterionDescription,
  sanitizeSuccessCriteriaDraft,
  successCriteriaDraftEquals,
} from './successCriteriaDraft';

export interface SuccessCriteriaEditorHandle {
  readonly flush: () => Promise<boolean>;
  readonly isDirty: () => boolean;
}

export const SuccessCriteriaEditor = forwardRef<SuccessCriteriaEditorHandle, {
  readonly plan: GoalPlan;
  readonly isZh: boolean;
  readonly disabled?: boolean;
}>(function SuccessCriteriaEditor({ plan, isZh, disabled = false }, ref) {
  const [draft, setDraft] = useState<GoalSuccessCriterion[]>(() => cloneSuccessCriteria(plan.successCriteria));
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const incoming = cloneSuccessCriteria(plan.successCriteria);
    const dirty = !successCriteriaDraftEquals(
      sanitizeSuccessCriteriaDraft(draftRef.current),
      incoming,
    );
    if (dirty) return;
    setDraft(incoming);
  }, [plan.planId, plan.successCriteria, plan.updatedAt]);

  const persist = useCallback(async (next: readonly GoalSuccessCriterion[]) => {
    const sanitized = sanitizeSuccessCriteriaDraft(next);
    const current = cloneSuccessCriteria(plan.successCriteria);
    if (successCriteriaDraftEquals(sanitized, current)) return true;
    try {
      await clientApi.goalPlansRevise({
        planId: plan.planId,
        patch: { successCriteria: sanitized },
        reason: 'edit_success_criteria',
        changedBy: 'user',
      });
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : (isZh ? '标准没写上' : 'Could not save criteria'));
      return false;
    }
  }, [isZh, plan.planId, plan.successCriteria]);

  useImperativeHandle(ref, () => ({
    flush: () => persist(draftRef.current),
    isDirty: () => !successCriteriaDraftEquals(
      sanitizeSuccessCriteriaDraft(draftRef.current),
      cloneSuccessCriteria(plan.successCriteria),
    ),
  }), [persist, plan.successCriteria]);

  return (
    <div className="success-criteria-editor">
      <div className="success-criteria-editor__label">
        {isZh ? '成功标准（可改再批）' : 'Success criteria (edit before approval)'}
      </div>
      <ul className="success-criteria-editor__list">
        {draft.map((criterion) => (
          <li key={criterion.id} className="success-criteria-editor__row">
            <input
              type="text"
              className="success-criteria-editor__input"
              value={criterion.description}
              disabled={disabled}
              placeholder={isZh ? '这条怎样算完成' : 'What done looks like'}
              onChange={(event) => {
                setDraft((current) => replaceCriterionDescription(current, criterion.id, event.target.value));
              }}
              onBlur={() => {
                void persist(draftRef.current);
              }}
            />
            <button
              type="button"
              className="success-criteria-editor__remove"
              disabled={disabled}
              aria-label={isZh ? '删掉这条标准' : 'Remove criterion'}
              onClick={() => {
                const next = removeCriterion(draft, criterion.id);
                setDraft(next);
                void persist(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="success-criteria-editor__add"
        disabled={disabled}
        onClick={() => {
          const next = addManualCriterion(draft);
          setDraft(next);
        }}
      >
        {isZh ? '加一条标准' : 'Add a criterion'}
      </button>
      {error ? <p className="success-criteria-editor__error">{error}</p> : null}
    </div>
  );
});
