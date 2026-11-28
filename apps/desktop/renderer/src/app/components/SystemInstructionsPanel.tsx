import './settings-section-header.css';
import './personalization.css';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotCommunicationStyle } from '@peer-agent/protocol';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { clientApi } from '../../clientApi';
import { PeerIcon, type PeerIconName } from '../../ui/icons';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import { useEditableResource } from '../../ui/forms/useEditableResource';
import { useGuardedNavigation, useUnsavedChanges } from '../../ui/forms/UnsavedChanges';

const STYLE_KEYS: readonly BotCommunicationStyle[] = ['natural', 'concise', 'detailed', 'technical'];

interface StyleOptionSpec {
  readonly id: BotCommunicationStyle;
  readonly icon: PeerIconName;
  readonly titleZh: string;
  readonly titleEn: string;
  readonly descZh: string;
  readonly descEn: string;
  readonly sampleZh: string;
  readonly sampleEn: string;
}

const STYLE_OPTIONS: readonly StyleOptionSpec[] = [
  {
    id: 'natural',
    icon: 'userRound',
    titleZh: '自然搭档',
    titleEn: 'Natural partner',
    descZh: '像并肩做项目的真人同事，先给结论，再按需展开细节。',
    descEn: 'Grounded teammate tone: lead with the takeaway and expand only as helpful.',
    sampleZh: '刚翻完改动，核心是两处问题，我先帮你把第一处修好了…',
    sampleEn: 'Checked the changes — two root causes popped up. I fixed the first one and…',
  },
  {
    id: 'concise',
    icon: 'bolt',
    titleZh: '干练直给',
    titleEn: 'Direct & concise',
    descZh: '高信息密度短句，直奔结论与下一步，去掉铺垫和寒暄。',
    descEn: 'Tight, high-signal bullets: conclusions and next steps with zero filler.',
    sampleZh: '已修完。改了 2 个文件，单测 12/12 通过。下一步需要你确认…',
    sampleEn: 'Done. 2 files updated, 12/12 tests passing. Next decision needed…',
  },
  {
    id: 'detailed',
    icon: 'fileText',
    titleZh: '温和详尽',
    titleEn: 'Warm & thorough',
    descZh: '耐心讲清背景、原因与权衡，用大白话把来龙去脉说透。',
    descEn: 'Patient, clear explanations covering context, trade-offs, and impact.',
    sampleZh: '这里会卡住是因为连接断了但读端没收到信号，所以我从两端分别做了保护…',
    sampleEn: 'This stalled because the socket closed silently on one side, so I added guards on both ends…',
  },
  {
    id: 'technical',
    icon: 'terminal',
    titleZh: '专业深度',
    titleEn: 'Technical peer',
    descZh: '保留文件路径、架构权衡与验证细节，同时屏蔽内部协议黑话。',
    descEn: 'Senior engineering precision with paths and trade-offs, minus internal jargon.',
    sampleZh: '根因在 transport.rs 写失败未关闭读半部，已补 select! 退出分支与回归测试。',
    sampleEn: 'Root cause was transport.rs leaving the read half open; added select! teardown and regression tests.',
  },
];

interface PresetRule {
  readonly id: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly lineZh: string;
  readonly lineEn: string;
}

const PRESET_RULES: readonly PresetRule[] = [
  {
    id: 'conclusion-first',
    labelZh: '先给结论再展开',
    labelEn: 'Conclusion first',
    lineZh: '回答和汇报进展时先给核心结论，再按需补充细节。',
    lineEn: 'Lead every reply with the core conclusion before expanding details.',
  },
  {
    id: 'plain-language',
    labelZh: '少用术语说人话',
    labelEn: 'Plain everyday language',
    lineZh: '尽量用通俗易懂的日常语言解释问题，避免堆砌生僻术语。',
    lineEn: 'Explain things in plain everyday language instead of dense jargon.',
  },
  {
    id: 'explain-impact',
    labelZh: '改动前先讲影响范围',
    labelEn: 'State impact before changes',
    lineZh: '做较大改动前先说明改动思路、影响范围与潜在风险。',
    lineEn: 'Before substantial edits, briefly explain the plan, scope, and risks.',
  },
  {
    id: 'no-fluff',
    labelZh: '去掉客套寒暄',
    labelEn: 'No filler or pleasantries',
    lineZh: '保持简洁直接，不要客套寒暄或重复我刚说过的话。',
    lineEn: 'Keep replies direct without pleasantries or restating my prompt.',
  },
  {
    id: 'tradeoffs',
    labelZh: '主动给出取舍建议',
    labelEn: 'Highlight trade-offs',
    lineZh: '遇到多种可行做法时，主动说明各自取舍并给出推荐项。',
    lineEn: 'When multiple approaches exist, outline key trade-offs and recommend one.',
  },
];

function isCommunicationStyle(value: unknown): value is BotCommunicationStyle {
  return typeof value === 'string' && (STYLE_KEYS as readonly string[]).includes(value);
}

function readSystemInstructions(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.systemInstructions === 'string' ? settings.systemInstructions : '';
}

function readGlobalCommunicationStyle(settings: Record<string, unknown> | null | undefined): BotCommunicationStyle {
  const projectAgent = settings?.projectAgent as { communicationStyle?: unknown } | undefined;
  return isCommunicationStyle(projectAgent?.communicationStyle) ? projectAgent.communicationStyle : 'natural';
}

function togglePresetLine(draft: string, line: string): string {
  const lines = draft.split('\n');
  const existingIndex = lines.findIndex((entry) => entry.trim() === line.trim());
  if (existingIndex >= 0) {
    lines.splice(existingIndex, 1);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const trimmed = draft.trimEnd();
  return trimmed ? `${trimmed}\n${line}` : line;
}

function hasPresetLine(draft: string, line: string): boolean {
  return draft.split('\n').some((entry) => entry.trim() === line.trim());
}

/** Personalization settings: global default Bot communication style + cross-workspace instructions. */
export function SystemInstructionsPanel({ i18n, onBack, onSystemInstructionsChanged }: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
  readonly onSystemInstructionsChanged?: (value: string) => void;
}) {
  const isZh = i18n.locale.startsWith('zh');
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  const textareaId = useId();
  const statusId = `${textareaId}-status`;
  const navigate = useGuardedNavigation();

  const [globalStyle, setGlobalStyle] = useState<BotCommunicationStyle>(() =>
    readGlobalCommunicationStyle(clientApi.initialSettings),
  );
  const [styleState, setStyleState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pendingStyle, setPendingStyle] = useState<BotCommunicationStyle | null>(null);

  useEffect(() => {
    let cancelled = false;
    void clientApi.getSettings().then((settings) => {
      if (cancelled) return;
      setGlobalStyle(readGlobalCommunicationStyle(settings));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const saveStyle = async (next: BotCommunicationStyle) => {
    if (styleState === 'saving' || next === globalStyle) return;
    const previous = globalStyle;
    setGlobalStyle(next);
    setPendingStyle(next);
    setStyleState('saving');
    try {
      const saved = await clientApi.updateSettings({ projectAgent: { communicationStyle: next } });
      setGlobalStyle(readGlobalCommunicationStyle(saved));
      setPendingStyle(null);
      setStyleState('saved');
    } catch {
      setGlobalStyle(previous);
      setStyleState('error');
    }
  };

  const handleStyleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % STYLE_OPTIONS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + STYLE_OPTIONS.length) % STYLE_OPTIONS.length;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    const target = STYLE_OPTIONS[nextIndex]!;
    void saveStyle(target.id);
    const group = event.currentTarget.closest('[role="radiogroup"]');
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  };

  const form = useEditableResource('settings.instructions', readSystemInstructions(clientApi.initialSettings), {
    read: async () => {
      const saved = readSystemInstructions(await clientApi.getSettings());
      onSystemInstructionsChanged?.(saved);
      return saved;
    },
    write: async (draft) => {
      const saved = readSystemInstructions(await clientApi.updateSettings({ systemInstructions: draft }));
      onSystemInstructionsChanged?.(saved);
      return saved;
    },
  });

  useUnsavedChanges({ dirty: form.dirty, busy: form.saving, save: form.save, discard: form.reset });

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (form.loaded && form.dirty && !form.saving) void form.save();
    }
  };

  const trimmedLength = form.draft.trim().length;
  const hasError = form.saveError || form.readError;

  return (
    <div className="system-instructions-panel personalization-panel">
      {onBack ? (
        <header className="llm-settings-header">
          <button type="button" className="ui-button is-icon" onClick={() => navigate(onBack)} aria-label={i18n.t('forms.back')}>
            <PeerIcon name="back" size={18} />
          </button>
          <strong>{isZh ? '个性化' : 'Personalization'}</strong>
        </header>
      ) : (
        <header className="frost-page-heading">
          <h1>{isZh ? '个性化' : 'Personalization'}</h1>
          <p>
            {isZh
              ? '定义机器人默认如何与你交流，以及跨项目生效的个人习惯与约束。'
              : 'Choose how bots talk with you by default and add preferences applied across workspaces.'}
          </p>
        </header>
      )}

      <SettingsGroup
        className="personalization-group"
        title={isZh ? '默认沟通风格' : 'Default communication style'}
        description={
          isZh
            ? '所有设置为「跟随全局默认」的机器人都会沿用这里的语气与详略；你仍可在单个机器人抽屉里单独覆盖。'
            : 'Applied to every bot set to "Follow global default". You can still override individual bots in their drawer.'
        }
      >
        <div
          className="personalization-style-grid"
          role="radiogroup"
          aria-label={isZh ? '默认沟通风格' : 'Default communication style'}
        >
          {STYLE_OPTIONS.map((option, index) => {
            const selected = globalStyle === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                disabled={styleState === 'saving'}
                className="personalization-style-card"
                onClick={() => { void saveStyle(option.id); }}
                onKeyDown={(event) => handleStyleKeyDown(event, index)}
              >
                <div className="personalization-style-head">
                  <div className="personalization-style-title-wrap">
                    <span className="personalization-style-icon" aria-hidden="true">
                      <PeerIcon name={option.icon} size={15} />
                    </span>
                    <span className="personalization-style-title">
                      {isZh ? option.titleZh : option.titleEn}
                    </span>
                  </div>
                  {selected ? (
                    <span className="personalization-style-badge">
                      <PeerIcon name="check" size={11} />
                      <span>{isZh ? '默认' : 'Default'}</span>
                    </span>
                  ) : null}
                </div>
                <p className="personalization-style-desc">{isZh ? option.descZh : option.descEn}</p>
                <p className="personalization-style-sample">
                  {isZh ? option.sampleZh : option.sampleEn}
                </p>
              </button>
            );
          })}
        </div>
        <div className="personalization-style-foot">
          <p>
            {isZh
              ? '无论选择哪一档，机器人都以真人搭档视角汇报，不暴露内部系统术语。'
              : 'Every style keeps internal runtime and protocol jargon out of replies.'}
          </p>
          {styleState === 'saving' ? (
            <span className="personalization-inline-status" role="status">
              <PeerIcon name="loader" size={13} />
              <span>{i18n.t('forms.saving')}</span>
            </span>
          ) : styleState === 'saved' ? (
            <span className="personalization-inline-status is-ok" role="status">
              <PeerIcon name="check" size={13} />
              <span>{i18n.t('forms.saved')}</span>
            </span>
          ) : styleState === 'error' ? (
            <span className="personalization-inline-status is-error" role="alert">
              <span>{i18n.t('forms.saveFailed')}</span>
              {pendingStyle ? (
                <button type="button" className="ui-button is-compact" onClick={() => { void saveStyle(pendingStyle); }}>
                  {i18n.t('forms.retry')}
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup
        className="personalization-group"
        title={isZh ? '全局偏好与约束' : 'Global preferences & instructions'}
        description={
          isZh
            ? '自动注入所有主机器人与普通对话的后续回复；保存不会改写正在生成的回答。'
            : 'Injected into future replies across all project bots and chats; saving does not rewrite a running reply.'
        }
      >
        <div className="personalization-editor-stack" aria-busy={form.loading || form.saving}>
          <div className="personalization-presets-block">
            <span className="personalization-presets-label">
              {isZh ? '快速添加常用偏好' : 'Quick presets'}
            </span>
            <div className="personalization-presets">
              {PRESET_RULES.map((rule) => {
                const line = isZh ? rule.lineZh : rule.lineEn;
                const active = hasPresetLine(form.draft, line);
                return (
                  <button
                    key={rule.id}
                    type="button"
                    className="personalization-preset-chip"
                    aria-pressed={active}
                    disabled={!form.loaded || form.saving}
                    onClick={() => form.edit(togglePresetLine(form.draft, line))}
                  >
                    <PeerIcon name={active ? 'check' : 'plus'} size={12} />
                    <span>{isZh ? rule.labelZh : rule.labelEn}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="personalization-textarea-wrap">
            <textarea
              id={textareaId}
              className="personalization-textarea"
              rows={7}
              value={form.draft}
              disabled={!form.loaded || form.saving}
              aria-label={isZh ? '全局偏好与约束' : 'Global preferences and instructions'}
              aria-describedby={statusId}
              aria-invalid={form.saveError || undefined}
              placeholder={
                isZh
                  ? '例如：我是产品负责人，汇报技术改动时优先讲清用户可见变化和风险；给出代码修改时只展示最关键的几行，不要把大段原始终端日志直接贴进对话。'
                  : 'Example: I focus on product impact—summarize user-visible changes and risks first, and keep raw logs out of replies unless I ask.'
              }
              onChange={(event) => form.edit(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
            />
          </div>

          <div className="personalization-footer">
            <div id={statusId} className="personalization-status-row" role={hasError ? 'alert' : 'status'}>
              {form.saveError ? (
                <>
                  <span className="personalization-status-text is-error">{i18n.t('forms.saveFailed')}</span>
                  <button type="button" className="ui-button is-compact" disabled={form.saving} onClick={() => { void form.save(); }}>
                    {i18n.t('forms.retry')}
                  </button>
                </>
              ) : form.readError ? (
                <>
                  <span className="personalization-status-text is-error">{i18n.t('forms.loadFailed')}</span>
                  <button type="button" className="ui-button is-compact" disabled={form.loading} onClick={() => { void form.reload(); }}>
                    {i18n.t('forms.retry')}
                  </button>
                </>
              ) : form.saving ? (
                <span className="personalization-status-text">
                  <PeerIcon name="loader" size={13} />
                  <span>{i18n.t('forms.saving')}</span>
                </span>
              ) : form.loading ? (
                <span className="personalization-status-text">{i18n.t('forms.loading')}</span>
              ) : form.dirty ? (
                <>
                  <span className="personalization-status-text is-dirty">{i18n.t('forms.unsaved')}</span>
                  <kbd className="personalization-shortcut">{isMac ? '⌘S' : 'Ctrl+S'}</kbd>
                </>
              ) : form.committed ? (
                <span className="personalization-status-text is-ok">
                  <PeerIcon name="check" size={13} />
                  <span>{isZh ? '已保存，后续对话生效' : 'Saved for future replies'}</span>
                </span>
              ) : (
                <span className="personalization-status-text">
                  {isZh ? '已同步至所有主机器人与普通对话' : 'Synced to all project bots and chats'}
                </span>
              )}
              <span className="personalization-meta-sep" aria-hidden="true">|</span>
              <span className="personalization-count">
                {isZh ? `${trimmedLength} 字` : `${trimmedLength} chars`}
              </span>
            </div>

            <div className="personalization-actions">
              <button
                type="button"
                className="ui-button"
                disabled={!form.dirty || form.saving}
                onClick={form.reset}
              >
                {isZh ? '还原' : 'Reset'}
              </button>
              <button
                type="button"
                className="ui-button is-primary"
                disabled={!form.loaded || !form.dirty || form.saving}
                onClick={() => { void form.save(); }}
              >
                {i18n.t(form.saving ? 'forms.saving' : 'forms.save')}
              </button>
            </div>
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}
