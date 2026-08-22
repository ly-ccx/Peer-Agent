import { useEffect, useMemo, useState } from 'react';
import type { GoalPlan, TaskOverviewArtifact, TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import {
  acceptancePageMeta,
  pairAcceptanceCriteria,
  resolveEvidenceLabel,
} from './acceptanceCriteria';
import { projectTaskOverviewArtifacts } from '../pages/taskOverviewArtifacts';

/**
 * 工作台「先看依据」：只展示验收对照。
 * 进度条、计划步骤和对话现场不进这一页；退回补充才回到任务。
 * 操作区（确认验收 / 退回补充）在 Drawer footer。
 */
export function ConversationResultView({
  item,
  isZh = true,
}: {
  readonly item: TaskOverviewItem;
  readonly isZh?: boolean;
}) {
  const [loading, setLoading] = useState(item.source === 'goal_plan' && Boolean(item.taskId));
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<GoalPlan | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (item.source !== 'goal_plan' || !item.taskId) {
      setPlan(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setPlan(null);

    void clientApi.goalPlansGet({ planId: item.taskId }).then(
      (detail) => {
        if (cancelled) return;
        setPlan(detail ?? null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [item.source, item.taskId]);

  const acceptanceRows = useMemo(() => pairAcceptanceCriteria(plan), [plan]);
  const leftoverEvidence = plan?.evidenceRefs ?? [];
  const evidenceSources = useMemo(
    () => (item.planSteps ?? []).flatMap((step) => step.artifacts ?? []),
    [item.planSteps],
  );
  const artifacts = useMemo(
    () => projectTaskOverviewArtifacts(item).groups.flatMap((group) => group.artifacts),
    [item],
  );
  const metaBits = acceptancePageMeta(item);
  const qualityChecks = item.qualityChecks ?? [];
  const hasCriteria = acceptanceRows.length > 0;
  const hasLeftover = leftoverEvidence.length > 0;

  return (
    <div className="conversation-result-view">
      <header className="conversation-result-view__header">
        <div className="conversation-result-view__kicker">{isZh ? '待验收' : 'Ready to accept'}</div>
        <h3 className="conversation-result-view__title">{item.title}</h3>
        {metaBits.length > 0 ? (
          <p className="conversation-result-view__meta">{metaBits.join(' · ')}</p>
        ) : null}
      </header>

      <section className="conversation-result-view__criteria-block">
        <div className="conversation-result-view__section-title">
          {isZh ? '对照标准' : 'Criteria'}
        </div>
        {loading ? (
          <p className="conversation-result-view__hint">{isZh ? '正在读取对照…' : 'Loading criteria…'}</p>
        ) : error ? (
          <p className="conversation-result-view__error">{error}</p>
        ) : hasCriteria ? (
          <ul className="conversation-result-view__criteria">
            {acceptanceRows.map(({ criterion, result }) => {
              const state = result ? (result.passed ? 'passed' : 'failed') : 'pending';
              const evidenceLabel = resolveEvidenceLabel(result?.evidenceRef, evidenceSources, isZh);
              return (
                <li
                  key={criterion.id}
                  className={`conversation-result-view__criterion is-${state}`}
                >
                  <span className="conversation-result-view__mark" aria-hidden="true">
                    {state === 'passed' ? '✓' : state === 'failed' ? '✗' : '·'}
                  </span>
                  <div className="conversation-result-view__criterion-body">
                    <span className="conversation-result-view__criterion-title">{criterion.description}</span>
                    <span className="conversation-result-view__ref">
                      {evidenceLabel
                        ?? (state === 'pending'
                          ? (isZh ? '还缺对照证据' : 'Evidence still missing')
                          : (isZh ? '已对照' : 'Matched'))}
                    </span>
                    {result?.detail ? <em>{result.detail}</em> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : hasLeftover ? (
          <ul className="conversation-result-view__criteria">
            {leftoverEvidence.map((ref) => (
              <li key={ref} className="conversation-result-view__criterion is-passed">
                <span className="conversation-result-view__mark" aria-hidden="true">✓</span>
                <div className="conversation-result-view__criterion-body">
                  <span className="conversation-result-view__criterion-title">
                    {resolveEvidenceLabel(ref, evidenceSources, isZh) ?? (isZh ? '证据' : 'Evidence')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="conversation-result-view__hint">
            {isZh ? '这条任务还没有写下成功标准或证据。' : 'This task has no success criteria or evidence yet.'}
          </p>
        )}
      </section>

      {artifacts.length > 0 ? (
        <section className="conversation-result-view__artifacts">
          <div className="conversation-result-view__section-title">
            {isZh ? '可打开的产物' : 'Openable artifacts'}
          </div>
          <ul className="conversation-result-view__artifact-list">
            {artifacts.map((artifact) => (
              <AcceptanceArtifactButton key={`${artifact.kind}:${artifact.ref}`} artifact={artifact} />
            ))}
          </ul>
        </section>
      ) : null}

      {qualityChecks.length > 0 ? (
        <section className="conversation-result-view__checks-block">
          <div className="conversation-result-view__section-title">
            {isZh ? '交卷前查过' : 'Checked before handoff'}
          </div>
          <ul className="conversation-result-view__checks">
            {qualityChecks.map((check) => (
              <li key={check.id} className="conversation-result-view__check">
                <span>{check.label}</span>
                <b>
                  {check.note
                    || (check.status === 'passed'
                      ? (isZh ? '已通过' : 'Passed')
                      : check.status === 'skipped'
                        ? (isZh ? '未做' : 'Skipped')
                        : (isZh ? '未通过' : 'Failed'))}
                </b>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AcceptanceArtifactButton({ artifact }: { readonly artifact: TaskOverviewArtifact }) {
  const canOpen = Boolean(artifact.openPath);
  return (
    <li className="task-artifact-shell">
      <button
        type="button"
        className={`task-artifact task-artifact--${artifact.kind}`}
        disabled={!canOpen}
        onClick={() => {
          if (!artifact.openPath) return;
          void clientApi.openPath(artifact.openPath);
        }}
      >
        <span className="task-artifact-copy">
          <span className="task-artifact-name" title={artifact.label}>{artifact.label}</span>
        </span>
        {artifact.preview?.kind === 'code' ? (
          <span className="task-artifact-stat">
            <span className="task-artifact-stat-add">+{artifact.preview.additions}</span>
            {artifact.preview.deletions > 0 ? (
              <span className="task-artifact-stat-del">−{artifact.preview.deletions}</span>
            ) : null}
          </span>
        ) : null}
        <span className="task-artifact-action">{artifact.actionLabel}</span>
      </button>
    </li>
  );
}
