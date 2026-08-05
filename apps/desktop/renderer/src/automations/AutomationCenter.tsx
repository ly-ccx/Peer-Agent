import type {
  AutomationAccessPreset,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationRun,
  AutomationSchedule,
  AutomationScheduleKind,
  AutomationSummary,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Overlay } from '../app/components/Overlay';
import { clientApi } from '../clientApi';
import { Switch } from '../ui/boolean-controls';
import { getAutomationCopy, type AutomationCopy, type AutomationLocale } from './automationI18n';
import {
  automationCounts, definitionSubtitle, formatDateTime, nextThreePreview,
  runNeedsAttention, runStatusLabel, scheduleLabel, terminalRun,
} from './automationPresentation';
import {
  buildAutomationDetectionPrompt,
  canInferAutomationDraft,
  detectionToDraftPatch,
  inferAutomationDraftFromPrompt,
  parseLlmAutomationDetectionText,
} from './automationDraftInference';
import {
  systemAutomationTimezone,
  timezoneForExistingAutomation,
} from './automationTimezoneBinding';
import {
  hasBoundAutomationWorkspace,
  workspaceForExistingAutomation,
  workspaceForNewAutomation,
} from './automationWorkspaceBinding';

type CenterView = 'list' | 'editor' | 'detail' | 'run';
type DetailTab = 'overview' | 'runs';

interface Draft {
  name: string;
  prompt: string;
  workspacePath: string;
  scheduleKind: AutomationScheduleKind;
  timezone: string;
  onceAt: string;
  hour: number;
  minute: number;
  everyHours: number;
  dayOfMonth: number;
  cron: string;
  access: AutomationAccessPreset;
  notifySuccess: boolean;
  timeoutMinutes: number;
}

function blankDraft(defaultWorkspace: string, promptTemplate = ''): Draft {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  return {
    name: '', prompt: promptTemplate, workspacePath: workspaceForNewAutomation(defaultWorkspace), scheduleKind: 'daily',
    timezone: systemAutomationTimezone(),
    onceAt: next.toISOString().slice(0, 16), hour: 9, minute: 0, everyHours: 1,
    dayOfMonth: 1, cron: '0 9 * * *', access: 'observe', notifySuccess: false,
    timeoutMinutes: 30,
  };
}

function draftFromDefinition(value: AutomationDefinition): Draft {
  return {
    name: value.name, prompt: value.prompt,
    workspacePath: workspaceForExistingAutomation(value.workspacePath),
    scheduleKind: value.schedule.kind,
    timezone: timezoneForExistingAutomation(value.schedule.timezone),
    onceAt: value.schedule.onceAt?.slice(0, 16) ?? '', hour: value.schedule.hour ?? 9,
    minute: value.schedule.minute ?? 0, everyHours: value.schedule.everyHours ?? 1,
    dayOfMonth: value.schedule.dayOfMonth ?? 1, cron: value.schedule.cron ?? '0 9 * * *',
    access: value.grant.preset, notifySuccess: value.notifications.succeeded,
    timeoutMinutes: Math.max(1, Math.round(value.budget.timeoutMs / 60_000)),
  };
}

function inputFromDraft(draft: Draft): AutomationCreateInput {
  const schedule = {
    kind: draft.scheduleKind, timezone: draft.timezone,
    ...(draft.scheduleKind === 'once' ? { onceAt: new Date(draft.onceAt).toISOString() } : {}),
    ...(draft.scheduleKind === 'hourly' ? { everyHours: draft.everyHours, minute: draft.minute } : {}),
    ...(['daily', 'weekdays', 'weekly', 'monthly'].includes(draft.scheduleKind) ? { hour: draft.hour, minute: draft.minute } : {}),
    ...(draft.scheduleKind === 'weekly' ? { weekdays: [1] } : {}),
    ...(draft.scheduleKind === 'monthly' ? { dayOfMonth: draft.dayOfMonth } : {}),
    ...(draft.scheduleKind === 'custom_cron' ? { cron: draft.cron } : {}),
  } as AutomationCreateInput['schedule'];
  const writing = draft.access === 'work_in_workspace';
  return {
    name: draft.name.trim(), prompt: draft.prompt.trim(), workspacePath: draft.workspacePath.trim(), schedule,
    grant: {
      preset: draft.access, workspacePath: draft.workspacePath.trim(),
      allowedCapabilityIds: writing
        ? ['local.file.read', 'local.file.write', 'local.shell.exec']
        : ['local.file.read'],
      askCapabilityIds: [],
      blockedCapabilityIds: writing ? [] : ['local.file.write', 'local.shell.exec'],
      confirmedAt: new Date().toISOString(), version: 1,
    },
    notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: draft.notifySuccess },
    budget: { timeoutMs: draft.timeoutMinutes * 60_000 }, missedRunPolicy: 'run_latest',
    overlapPolicy: 'skip', enable: true,
  };
}

function Icon({ name }: { name: 'plus' | 'pause' | 'play' | 'back' | 'run' | 'chevronDown' | 'chevronRight' }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    pause: <><path d="M9 6v12M15 6v12" /></>,
    play: <path d="m9 6 9 6-9 6Z" />,
    back: <path d="m15 18-6-6 6-6" />,
    run: <><path d="m8 5 11 7-11 7Z" /></>,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export function AutomationCenter({ isZh, defaultWorkspace, initialRunTarget, onOpenConversation, onCreateNew }: {
  readonly isZh: boolean;
  readonly defaultWorkspace: string;
  readonly initialRunTarget?: { automationId: string; runId: string } | null;
  readonly onOpenConversation?: (conversationId: number) => void;
  readonly onCreateNew?: () => void;
}) {
  const copy = getAutomationCopy(isZh);
  const locale = isZh ? 'zh' : 'en';
  const [items, setItems] = useState<readonly AutomationSummary[]>([]);
  const [globallyPaused, setGloballyPaused] = useState(false);
  const [view, setView] = useState<CenterView>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<AutomationRun | null>(null);
  const [runs, setRuns] = useState<readonly AutomationRun[]>([]);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [draft, setDraft] = useState(() => blankDraft(defaultWorkspace));
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await clientApi.automationsBootstrap();
      setItems(result.automations);
      setGloballyPaused(result.runtime.globallyPaused);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); return clientApi.onAutomationsChanged(() => { void refresh(); }); }, [refresh]);

  useEffect(() => {
    if (!initialRunTarget?.runId) return;
    void (async () => {
      const run = await clientApi.automationRunsGet({ runId: initialRunTarget.runId });
      if (!run) return;
      setSelectedId(initialRunTarget.automationId);
      setSelectedRun(run);
      setView('run');
    })();
  }, [initialRunTarget?.automationId, initialRunTarget?.runId]);

  const selected = items.find((item) => item.definition.automationId === selectedId) ?? null;
  const counts = useMemo(() => automationCounts(items), [items]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter(({ definition }) => `${definition.name} ${definition.workspacePath} ${definition.prompt}`.toLowerCase().includes(needle)) : items;
  }, [items, query]);

  const openDefinition = useCallback(async (automationId: string, nextTab: DetailTab = 'overview') => {
    setSelectedId(automationId); setTab(nextTab); setView('detail'); setSelectedRun(null);
    try { setRuns(await clientApi.automationRunsList({ automationId, limit: 100 })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  const runAction = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [refresh]);

  const openEditor = (definition?: AutomationDefinition) => {
    if (!definition && !hasBoundAutomationWorkspace(defaultWorkspace)) {
      setError(copy.workspaceRequired);
      return;
    }
    setError(null);
    setEditing(definition ?? null); setDraft(definition ? draftFromDefinition(definition) : blankDraft(defaultWorkspace, copy.promptTemplate));
    setView('editor');
  };

  const save = async (draftOverride?: Draft) => {
    const nextDraft = draftOverride ?? draft;
    if (!hasBoundAutomationWorkspace(nextDraft.workspacePath)) {
      setError(copy.workspaceRequired);
      return;
    }
    const input = inputFromDraft(nextDraft);
    await runAction(async () => {
      const definition = editing
        ? await clientApi.automationsUpdate({ automationId: editing.automationId, expectedVersion: editing.version, patch: input })
        : await clientApi.automationsCreate(input);
      setSelectedId(definition.automationId); setView('detail'); setTab('overview');
    });
  };

  const openRun = (run: AutomationRun) => { setSelectedRun(run); setView('run'); };

  if (view === 'editor') return <Editor copy={copy} locale={locale} draft={draft} setDraft={setDraft} editing={editing}
    busy={busy} onCancel={() => setView(editing ? 'detail' : 'list')} onSave={(next) => void save(next)} />;

  if (view === 'run' && selectedRun) return <RunReceipt copy={copy} locale={locale} run={selectedRun} busy={busy}
    onBack={() => { setView('detail'); setTab('runs'); }}
    onRetry={() => void runAction(async () => { const run = await clientApi.automationRunsRetry({ runId: selectedRun.runId }); setSelectedRun(run); })}
    onCancel={() => void runAction(async () => { const run = await clientApi.automationRunsCancel({ runId: selectedRun.runId }); setSelectedRun(run); })}
    onConversation={onOpenConversation} />;

  if (view === 'detail' && selected) return <AutomationDetail copy={copy} locale={locale} summary={selected} runs={runs} tab={tab}
    setTab={setTab} busy={busy} onBack={() => setView('list')} onEdit={() => openEditor(selected.definition)}
    onRun={() => void runAction(async () => { await clientApi.automationsRunNow({ automationId: selected.definition.automationId }); await openDefinition(selected.definition.automationId, 'runs'); })}
    onStatus={(status) => void runAction(() => clientApi.automationsUpdate({ automationId: selected.definition.automationId, expectedVersion: selected.definition.version, patch: { status } }))}
    onOpenRun={openRun} />;

  return <section className="automation-center motion-enter-rise" data-testid="automation-center" data-automation-view="list">
    <header className="automation-page-header">
      <div className="automation-page-heading">
        <h1>{copy.automations}</h1>
        <p className="automation-page-lede">{copy.subtitle}</p>
      </div>
      <div className="automation-header-actions">
        <button className="automation-button secondary" disabled={busy} onClick={() => void runAction(async () => { await clientApi.automationsSetRuntimePaused({ paused: !globallyPaused }); })}>
          <Icon name={globallyPaused ? 'play' : 'pause'} />{globallyPaused ? copy.resumeAll : copy.pauseAll}
        </button>
        <button className="automation-button primary" onClick={() => (onCreateNew ? onCreateNew() : openEditor())}><Icon name="plus" />{copy.newAutomation}</button>
      </div>
    </header>
    {error ? <div className="automation-alert" role="alert">{error}<button onClick={() => void refresh()}>{copy.retry}</button></div> : null}
    {globallyPaused ? <div className="automation-runtime-banner">{copy.pausedBanner}</div> : null}
    <div className="automation-metrics modern">
      <Metric label={copy.total} value={counts.total} /><Metric label={copy.active} value={counts.active} />
      <Metric label={copy.running} value={counts.running} /><Metric label={copy.needsAttention} value={counts.attention} attention={counts.attention > 0} />
    </div>
    <div className="automation-list-panel">
      <div className="automation-list-toolbar">
        <input aria-label={copy.search} placeholder={copy.search} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {loading ? <div className="automation-empty modern">{copy.loading}</div> : visible.length === 0 ? <div className="automation-empty modern">
        <div className="automation-empty-icon">⌁</div><h2>{items.length ? copy.noMatches : copy.emptyTitle}</h2>
        <p>{items.length ? copy.tryAnotherSearch : copy.emptyDetail}</p>
        {!items.length ? <button className="automation-button primary" onClick={() => (onCreateNew ? onCreateNew() : openEditor())}><Icon name="plus" />{copy.createAutomation}</button> : null}
      </div> : <div className="automation-list">{visible.map((summary) => <button key={summary.definition.automationId} className="automation-list-row" onClick={() => void openDefinition(summary.definition.automationId)}>
        <span className={`automation-status-dot ${summary.needsAttention ? 'attention' : summary.activeRun ? 'running' : summary.definition.status}`} />
        <span className="automation-list-main"><strong>{summary.definition.name}</strong><small>{definitionSubtitle(summary.definition, locale)}</small></span>
        <span className="automation-workspace">{summary.definition.workspacePath}</span>
        <span className="automation-next"><small>{copy.nextRun}</small>{formatDateTime(summary.definition.nextRunAt, locale)}</span>
        <span className={`automation-pill ${summary.needsAttention ? 'attention' : ''}`}>{summary.activeRun ? runStatusLabel(summary.activeRun.status, locale) : (summary.definition.status === 'active' ? copy.activeState : copy.pausedState)}</span>
        <span className="automation-chevron" aria-hidden="true"><Icon name="chevronRight" /></span>
      </button>)}</div>}
    </div>
  </section>;
}

function Metric({ label, value, attention = false }: { label: string; value: number; attention?: boolean }) {
  return <div className={`automation-metric ${attention ? 'attention' : ''}`}><strong>{value}</strong><span>{label}</span></div>;
}

function scheduleKindLabel(copy: AutomationCopy, kind: AutomationScheduleKind): string {
  const labels: Record<AutomationScheduleKind, string> = {
    once: copy.once,
    hourly: copy.hourly,
    daily: copy.daily,
    weekdays: copy.weekdays,
    weekly: copy.weekly,
    monthly: copy.monthly,
    custom_cron: copy.customCron,
  };
  return labels[kind];
}

function Editor({ copy, locale, draft, setDraft, editing, busy, onCancel, onSave }: {
  copy: AutomationCopy; locale: AutomationLocale; draft: Draft; setDraft: (value: Draft) => void; editing: AutomationDefinition | null;
  busy: boolean; onCancel: () => void; onSave: (draft?: Draft) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detected, setDetected] = useState(() => Boolean(editing) || Boolean(draft.name.trim()));
  const [nameTouched, setNameTouched] = useState(() => Boolean(editing));
  const [scheduleTouched, setScheduleTouched] = useState(() => Boolean(editing));
  const [detectModelId, setDetectModelId] = useState('');
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [detecting, setDetecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detectNotice, setDetectNotice] = useState<string | null>(null);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const input = useMemo(() => inputFromDraft(draft), [draft]);
  const preview = nextThreePreview(input.schedule, new Date(), locale);
  const valid = Boolean(
    draft.prompt.trim()
    && draft.workspacePath.trim()
    && (draft.scheduleKind !== 'once' || draft.onceAt),
  );
  const primaryLabel = busy
    ? copy.saving
    : editing
      ? copy.save
      : copy.createAndEnable;

  const buildInferredDraft = (prompt: string, force = false): Draft | null => {
    if (!canInferAutomationDraft(prompt)) return null;
    const inferred = inferAutomationDraftFromPrompt(prompt);
    return {
      ...draft,
      prompt,
      name: (!nameTouched || force || !draft.name.trim()) ? inferred.name : draft.name,
      scheduleKind: (!scheduleTouched || force) ? inferred.scheduleKind : draft.scheduleKind,
      hour: (!scheduleTouched || force) ? inferred.hour : draft.hour,
      minute: (!scheduleTouched || force) ? inferred.minute : draft.minute,
      everyHours: (!scheduleTouched || force) ? inferred.everyHours : draft.everyHours,
      onceAt: (!scheduleTouched || force) ? inferred.onceAt : draft.onceAt,
    };
  };

  const applyInference = (prompt: string, force = false) => {
    const next = buildInferredDraft(prompt, force);
    if (!next) return null;
    setDraft(next);
    setDetected(true);
    return next;
  };

  const applyDetectionPatch = (
    patch: {
      name: string;
      scheduleKind: AutomationScheduleKind;
      hour: number;
      minute: number;
      everyHours: number;
      onceAt: string;
    },
    force: boolean,
  ) => {
    const next: Draft = {
      ...draft,
      name: force || !nameTouched || !draft.name.trim() ? patch.name : draft.name,
      scheduleKind: force || !scheduleTouched ? patch.scheduleKind : draft.scheduleKind,
      hour: force || !scheduleTouched ? patch.hour : draft.hour,
      minute: force || !scheduleTouched ? patch.minute : draft.minute,
      everyHours: force || !scheduleTouched ? patch.everyHours : draft.everyHours,
      onceAt: force || !scheduleTouched ? patch.onceAt : draft.onceAt,
    };
    setDraft(next);
    if (force || !nameTouched || !draft.name.trim()) setNameTouched(false);
    if (force || !scheduleTouched) setScheduleTouched(false);
    setDetected(true);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const providers = await clientApi.llmListChatProviders();
        if (cancelled) return;
        const list = providers ?? [];
        const options = list.map((provider) => ({
          id: provider.id,
          label: `${provider.name || provider.provider || provider.id}${provider.model ? ` · ${provider.model}` : ''}${provider.isDefault ? ' ★' : ''}`,
        }));
        setModelOptions(options);
        const preferred = list.find((provider) => provider.isDefault)?.id || list[0]?.id || '';
        setDetectModelId((current) => current || preferred);
      } catch {
        if (!cancelled) setModelOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runDetection = async (force = true): Promise<Draft | null> => {
    const prompt = draft.prompt.trim();
    if (!prompt) return null;
    setDetectNotice(null);
    setDetecting(true);
    try {
      if (detectModelId) {
        try {
          const result = await clientApi.llmComplete({
            id: detectModelId,
            prompt: buildAutomationDetectionPrompt(prompt, locale),
            maxTokens: 500,
          });
          if (result?.success && result.text) {
            const parsed = parseLlmAutomationDetectionText(result.text);
            if (parsed) {
              return applyDetectionPatch(detectionToDraftPatch(parsed), force);
            }
          }
          setDetectNotice(copy.detectFailed);
        } catch {
          setDetectNotice(copy.detectFailed);
        }
      } else {
        setDetectNotice(copy.detectNeedModel);
      }
      return applyInference(prompt, force);
    } finally {
      setDetecting(false);
    }
  };

  const onPromptBlur = () => {
    if (!editing && !detectModelId) applyInference(draft.prompt);
  };

  const onPrimary = () => {
    if (editing) {
      onSave();
      return;
    }
    if (!draft.prompt.trim()) return;
    void (async () => {
      const next = await runDetection(true);
      if (!next?.name.trim() && !draft.name.trim()) return;
      setConfirmOpen(true);
    })();
  };

  const confirmSchedule = {
    kind: draft.scheduleKind,
    hour: draft.hour,
    minute: draft.minute,
    everyHours: draft.everyHours,
    onceAt: draft.onceAt || undefined,
    timezone: draft.timezone,
  } as const;

  return <section className={`automation-center narrow automation-editor motion-enter-rise${!editing ? ' automation-create-home' : ''}`} data-automation-view="editor">
    <PageBack onClick={onCancel} label={copy.automations} />
    <header className="automation-page-header compact">
      <div className="automation-page-heading">
        <h1>{editing ? copy.editTitle : copy.createHomeTitle}</h1>
        <p className="automation-page-lede">{editing ? copy.editorSubtitle : copy.createHomeLede}</p>
      </div>
    </header>

    <div
      className="automation-bound-workspace top-meta"
      title={copy.workspaceBoundDetail}
    >
      <span>{copy.workspace}</span>
      <strong>{draft.workspacePath || '—'}</strong>
    </div>

    <div className="automation-form modern automation-form-single">
      {!editing ? (
        <section className="automation-create-home-card">
          <label className="automation-create-home-label" htmlFor="automation-create-prompt">{copy.instructions}</label>
          <textarea
            id="automation-create-prompt"
            className="automation-create-home-prompt"
            rows={10}
            value={draft.prompt}
            onChange={(e) => update('prompt', e.target.value)}
            onBlur={onPromptBlur}
            placeholder={copy.promptFirstPlaceholder}
          />
          <p className="automation-create-home-hint">{copy.createHomeHint}</p>
          <div className="automation-detect-model compact">
            <label htmlFor="automation-detect-model">{copy.detectModel}</label>
            <select
              id="automation-detect-model"
              value={detectModelId}
              onChange={(event) => setDetectModelId(event.target.value)}
              disabled={busy || detecting || modelOptions.length === 0}
            >
              {modelOptions.length === 0 ? (
                <option value="">{copy.detectModelPlaceholder}</option>
              ) : null}
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            {detectNotice ? <p className="automation-page-lede">{detectNotice}</p> : null}
          </div>
        </section>
      ) : (
        <FormSection title={copy.task} description={copy.promptFirstDetail}>
          <Field label={copy.instructions}>
            <textarea
              rows={8}
              value={draft.prompt}
              onChange={(e) => update('prompt', e.target.value)}
              onBlur={onPromptBlur}
              placeholder={copy.promptFirstPlaceholder}
            />
          </Field>
        </FormSection>
      )}

      {detected || editing ? (
        <FormSection title={copy.generatedPlan} description={copy.generatedPlanDetail}>
          <Field label={copy.name}>
            <input
              value={draft.name}
              onChange={(e) => {
                setNameTouched(true);
                update('name', e.target.value);
              }}
              placeholder={copy.namePlaceholder}
            />
          </Field>
          <Field label={copy.frequency}>
            <select
              value={draft.scheduleKind}
              onChange={(e) => {
                setScheduleTouched(true);
                update('scheduleKind', e.target.value as AutomationScheduleKind);
              }}
            >
              {(['once','hourly','daily','weekdays','weekly','monthly','custom_cron'] as const).map((kind) => (
                <option key={kind} value={kind}>{scheduleKindLabel(copy, kind)}</option>
              ))}
            </select>
          </Field>
          <div className="automation-bound-timezone">
            <span>{copy.timezone}</span>
            <strong>{draft.timezone}</strong>
            <small>{copy.timezoneBoundDetail}</small>
          </div>
          {draft.scheduleKind === 'once' ? (
            <Field label={copy.dateTime}>
              <input
                type="datetime-local"
                value={draft.onceAt}
                onChange={(e) => {
                  setScheduleTouched(true);
                  update('onceAt', e.target.value);
                }}
              />
            </Field>
          ) : null}
          {draft.scheduleKind === 'hourly' ? (
            <Field label={copy.everyHours}>
              <input
                type="number"
                min="1"
                value={draft.everyHours}
                onChange={(e) => {
                  setScheduleTouched(true);
                  update('everyHours', Number(e.target.value));
                }}
              />
            </Field>
          ) : null}
          {['daily','weekdays','weekly','monthly'].includes(draft.scheduleKind) ? (
            <div className="automation-form-grid compact">
              <Field label={copy.hour}>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={draft.hour}
                  onChange={(e) => {
                    setScheduleTouched(true);
                    update('hour', Number(e.target.value));
                  }}
                />
              </Field>
              <Field label={copy.minute}>
                <input
                  type="number"
                  min="0"
                  max="59"
                  value={draft.minute}
                  onChange={(e) => {
                    setScheduleTouched(true);
                    update('minute', Number(e.target.value));
                  }}
                />
              </Field>
            </div>
          ) : null}
          {draft.scheduleKind === 'monthly' ? (
            <Field label={copy.dayOfMonth}>
              <input
                type="number"
                min="1"
                max="31"
                value={draft.dayOfMonth}
                onChange={(e) => {
                  setScheduleTouched(true);
                  update('dayOfMonth', Number(e.target.value));
                }}
              />
            </Field>
          ) : null}
          {draft.scheduleKind === 'custom_cron' ? (
            <Field label={copy.fiveFieldCron}>
              <input
                value={draft.cron}
                onChange={(e) => {
                  setScheduleTouched(true);
                  update('cron', e.target.value);
                }}
              />
            </Field>
          ) : null}
          <div className="automation-next-preview">
            <span>{copy.preview}</span>
            <div>
              {preview.length
                ? preview.map((item) => <strong key={item}>{item}</strong>)
                : <strong>{copy.noPreview}</strong>}
            </div>
          </div>
        </FormSection>
      ) : null}

{(editing || detected) ? (
        <div className={`automation-advanced${advancedOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="automation-advanced-summary"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <span>{copy.advancedSettings}</span>
            <span className="automation-advanced-chevron" aria-hidden="true"><Icon name="chevronDown" /></span>
          </button>
          <div className="automation-advanced-body" aria-hidden={!advancedOpen}>
            <div className="automation-advanced-body-inner">
              <div className="automation-choice-grid">
                <Choice selected={draft.access === 'observe'} title={copy.observe} detail={copy.observeDetail} onClick={() => update('access', 'observe')} />
                <Choice selected={draft.access === 'work_in_workspace'} title={copy.workInWorkspace} detail={copy.workInWorkspaceDetail} onClick={() => update('access', 'work_in_workspace')} />
              </div>
              <Field label={copy.timeout}>
                <input type="number" min="1" value={draft.timeoutMinutes} onChange={(e) => update('timeoutMinutes', Number(e.target.value))} />
              </Field>
              <div className="automation-setting-row" onClick={() => update('notifySuccess', !draft.notifySuccess)}>
                <div className="automation-setting-copy">
                  <strong id="automation-notify-success-label">{copy.notifyOnSuccess}</strong>
                  <small>{copy.notifyOnSuccessDetail}</small>
                </div>
                <Switch
                  checked={draft.notifySuccess}
                  onCheckedChange={(checked) => update('notifySuccess', checked)}
                  onClick={(event) => event.stopPropagation()}
                  aria-labelledby="automation-notify-success-label"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>

    <div className="automation-form-actions single">
      <button type="button" className="automation-button secondary" onClick={onCancel}>{copy.cancel}</button>
      <button type="button" className="automation-button primary" disabled={!valid || busy || detecting} onClick={onPrimary}>
        {primaryLabel}
      </button>
    </div>
    {confirmOpen ? (
      <Overlay
        onClose={() => setConfirmOpen(false)}
        ariaLabel={copy.confirmCreateTitle}
        backdropClassName="automation-confirm-overlay"
        panelClassName="automation-confirm-card"
      >
        {({ requestClose }) => (
          <>
            <div>
              <h2>{copy.confirmCreateTitle}</h2>
              <p className="automation-confirm-lede">{copy.confirmCreateDetail}</p>
            </div>
            <div className="automation-confirm-rows">
              <div className="automation-confirm-row"><span>{copy.name}</span><strong>{draft.name || '—'}</strong></div>
              <div className="automation-confirm-row"><span>{copy.scheduleLabel}</span><strong>{scheduleLabel(confirmSchedule as AutomationSchedule, locale)}</strong></div>
              <div className="automation-confirm-row"><span>{copy.workspace}</span><strong>{draft.workspacePath || '—'}</strong></div>
              <div className="automation-confirm-row"><span>{copy.accessLabel}</span><strong>{draft.access === 'work_in_workspace' ? copy.workInWorkspace : copy.observe}</strong></div>
              <div className="automation-confirm-row"><span>{copy.instructions}</span><strong>{draft.prompt || '—'}</strong></div>
            </div>
            <div className="automation-confirm-actions">
              <button type="button" className="automation-button secondary" disabled={busy || detecting} onClick={requestClose}>{copy.backToEdit}</button>
              <button
                type="button"
                className="automation-button primary"
                disabled={busy || detecting || !draft.name.trim() || !draft.prompt.trim()}
                onClick={() => {
                  requestClose();
                  onSave(draft);
                }}
              >
                {copy.confirmAndEnable}
              </button>
            </div>
          </>
        )}
      </Overlay>
    ) : null}
  </section>;
}

function AutomationDetail({ copy, locale, summary, runs, tab, setTab, busy, onBack, onEdit, onRun, onStatus, onOpenRun }: {
  copy: AutomationCopy; locale: AutomationLocale; summary: AutomationSummary; runs: readonly AutomationRun[]; tab: DetailTab; setTab: (tab: DetailTab) => void; busy: boolean;
  onBack: () => void; onEdit: () => void; onRun: () => void; onStatus: (status: 'active' | 'paused') => void; onOpenRun: (run: AutomationRun) => void;
}) {
  const definition = summary.definition;
  return <section className="automation-center motion-enter-rise" data-automation-view="detail"><PageBack onClick={onBack} label={copy.automations} />
    <header className="automation-detail-header"><div><div className="automation-detail-title"><span className={`automation-status-dot ${summary.needsAttention ? 'attention' : definition.status}`} /><h1>{definition.name}</h1><span className="automation-pill">{definition.status === 'active' ? copy.activeState : copy.pausedState}</span></div><p>{definitionSubtitle(definition, locale)}</p></div>
      <div className="automation-header-actions"><button className="automation-button secondary" onClick={onEdit}>{copy.edit}</button><button className="automation-button secondary" disabled={busy} onClick={() => onStatus(definition.status === 'paused' ? 'active' : 'paused')}>{definition.status === 'paused' ? copy.resume : copy.pause}</button><button className="automation-button primary" disabled={busy} onClick={onRun}><Icon name="run" />{copy.runNow}</button></div>
    </header>
    <div className="automation-tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>{copy.overview}</button><button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>{copy.runs} <span>{runs.length}</span></button></div>
    {tab === 'overview' ? <div className="automation-overview-grid"><div className="automation-panel wide"><h2>{copy.instructions}</h2><pre>{definition.prompt}</pre></div>
      <div className="automation-panel"><h2>{copy.schedule}</h2><Review label={copy.rule} value={scheduleLabel(definition.schedule, locale)} /><Review label={copy.timezone} value={definition.schedule.timezone} /><Review label={copy.nextRun} value={formatDateTime(definition.nextRunAt, locale)} /><Review label={copy.missedRuns} value={copy.runLatest} /><Review label={copy.overlap} value={copy.skip} /></div>
      <div className="automation-panel"><h2>{copy.access}</h2><Review label={copy.preset} value={definition.grant.preset === 'observe' ? copy.observe : copy.workInWorkspace} /><Review label={copy.workspace} value={definition.workspacePath} /><Review label={copy.execution} value={definition.grant.preset === 'observe' ? `${copy.currentWorkspace} · ${copy.observeDetail}` : copy.isolatedWorktree} /></div>
      <div className="automation-panel"><h2>{copy.health}</h2><Review label={copy.lastRun} value={formatDateTime(definition.lastRunAt, locale)} /><Review label={copy.failures} value={String(definition.consecutiveFailures)} /><Review label={copy.created} value={formatDateTime(definition.createdAt, locale)} /></div>
    </div> : <RunsTable copy={copy} locale={locale} runs={runs} onOpen={onOpenRun} />}
  </section>;
}

function RunsTable({ copy, locale, runs, onOpen }: { copy: AutomationCopy; locale: AutomationLocale; runs: readonly AutomationRun[]; onOpen: (run: AutomationRun) => void }) {
  if (!runs.length) return <div className="automation-empty compact modern"><h2>{copy.noRuns}</h2><p>{copy.runNowOrWait}</p></div>;
  return <div className="automation-runs"><div className="automation-run-head"><span>{copy.status}</span><span>{copy.triggered}</span><span>{copy.started}</span><span>{copy.duration}</span><span>{copy.result}</span><span /></div>{runs.map((run) => {
    const duration = run.startedAt && run.finishedAt ? copy.seconds(Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))) : '—';
    return <button key={run.runId} className="automation-run-row" onClick={() => onOpen(run)}><span className={`automation-pill ${runNeedsAttention(run) ? 'attention' : run.status}`}>{runStatusLabel(run.status, locale)}</span><span>{run.triggerSource}</span><span>{formatDateTime(run.startedAt ?? run.createdAt, locale)}</span><span>{duration}</span><span className="automation-run-summary">{run.receipt?.summary ?? run.failureReason ?? run.blockedReason ?? '—'}</span><span className="automation-chevron" aria-hidden="true"><Icon name="chevronRight" /></span></button>;
  })}</div>;
}

function RunReceipt({ copy, locale, run, busy, onBack, onRetry, onCancel, onConversation }: {
  copy: AutomationCopy; locale: AutomationLocale; run: AutomationRun; busy: boolean; onBack: () => void; onRetry: () => void; onCancel: () => void; onConversation?: (id: number) => void;
}) {
  const receipt = run.receipt;
  return <section className="automation-center motion-enter-rise" data-automation-view="run"><PageBack onClick={onBack} label={copy.runs} />
    <header className="automation-detail-header"><div><p className="automation-eyebrow">{copy.immutableReceipt}</p><div className="automation-detail-title"><h1>{run.snapshot.name}</h1><span className={`automation-pill ${runNeedsAttention(run) ? 'attention' : run.status}`}>{runStatusLabel(run.status, locale)}</span></div><p>{copy.run} {run.runId.slice(0, 12)} · {formatDateTime(run.createdAt, locale)}</p></div>
      <div className="automation-header-actions">{!terminalRun(run.status) ? <button className="automation-button secondary" disabled={busy} onClick={onCancel}>{copy.cancel}</button> : null}<button className="automation-button secondary" disabled={busy} onClick={onRetry}>{copy.runAgain}</button>{run.conversationId && onConversation ? <button className="automation-button primary" onClick={() => onConversation(run.conversationId!)}>{copy.openConversation}</button> : null}</div>
    </header>
    {runNeedsAttention(run) ? <div className="automation-alert attention"><strong>{copy.needsAttention}</strong><span>{receipt?.error ?? run.failureReason ?? run.blockedReason ?? copy.openToContinue}</span></div> : null}
    <div className="automation-receipt-grid"><div className="automation-panel wide"><h2>{copy.summary}</h2><p className="automation-receipt-summary">{receipt?.summary ?? receipt?.error ?? run.failureReason ?? copy.noSummary}</p></div>
      <div className="automation-panel"><h2>{copy.runFacts}</h2><Review label={copy.trigger} value={run.triggerSource} /><Review label={copy.scheduled} value={formatDateTime(run.scheduledAt, locale)} /><Review label={copy.started} value={formatDateTime(run.startedAt, locale)} /><Review label={copy.finished} value={formatDateTime(run.finishedAt, locale)} /><Review label={copy.definitionVersion} value={String(run.snapshot.definitionVersion)} /></div>
      <div className="automation-panel"><h2>{copy.usage}</h2><Review label={copy.inputTokens} value={String(receipt?.inputTokens ?? '—')} /><Review label={copy.outputTokens} value={String(receipt?.outputTokens ?? '—')} /><Review label={copy.cost} value={receipt?.costUsd == null ? '—' : `${receipt.costUsd.toFixed(4)}`} /><Review label={copy.duration} value={receipt?.durationMs == null ? '—' : copy.seconds(Math.round(receipt.durationMs / 1000))} /></div>
      <div className="automation-panel wide"><h2>{copy.changes}</h2>{receipt?.changes ? <><Review label={copy.branch} value={receipt.changes.branch ?? '—'} /><Review label={copy.worktree} value={receipt.changes.worktreePath ?? '—'} /><Review label={copy.files} value={receipt.changes.changedFiles.length ? receipt.changes.changedFiles.join(', ') : copy.noFilesChanged} /><Review label={copy.diff} value={`+${receipt.changes.additions ?? 0} −${receipt.changes.deletions ?? 0}`} /><Review label={copy.retention} value={receipt.changes.retained ? copy.retainedReview : copy.cleanedUp} /></> : <p>{copy.noWorkspaceChanges}</p>}</div>
      <div className="automation-panel wide"><h2>{copy.verification}</h2>{receipt?.verifications.length ? receipt.verifications.map((verification) => <div className="automation-verification" key={`${verification.command}-${verification.status}`}><span className={`automation-pill ${verification.status}`}>{verification.status}</span><code>{verification.command}</code><span>{verification.summary}</span></div>) : <p>{copy.noVerification}</p>}</div>
      <div className="automation-panel wide"><h2>{copy.evidence}</h2>{receipt?.evidenceRefs.length ? <ul className="automation-evidence-list">{receipt.evidenceRefs.map((ref) => <li key={ref}><code>{ref}</code></li>)}</ul> : <p>{copy.noEvidence}</p>}</div>
    </div>
  </section>;
}

function PageBack({ onClick, label }: { onClick: () => void; label: string }) { return <button className="automation-back" onClick={onClick}><Icon name="back" />{label}</button>; }
function FormSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="automation-form-section">
      <header>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="automation-form-section-body">{children}</div>
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="automation-field"><span>{label}</span>{children}</label>; }
function Choice({ selected, title, detail, onClick }: { selected: boolean; title: string; detail: string; onClick: () => void }) { return <button type="button" className={`automation-choice ${selected ? 'selected' : ''}`} onClick={onClick}><span className="automation-radio" /><strong>{title}</strong><small>{detail}</small></button>; }
function Review({ label, value }: { label: string; value: string }) { return <div className="automation-review-row"><span>{label}</span><strong>{value}</strong></div>; }
