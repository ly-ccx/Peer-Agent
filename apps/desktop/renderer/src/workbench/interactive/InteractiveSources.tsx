import type { InteractiveMaterialProvenance, InteractiveSourceIssue } from '@peer-agent/protocol';
import { memo } from 'react';
import { MotionDetails } from '../../app/components/MotionDetails';
import { PeerIcon } from '../../ui/icons';

const sourceIssueLabels = {
  attachment_removed: ['附件已从来源消息移除。', 'The attachment was removed from its source message.'],
  source_changed: ['来源后来已变更。', 'The source has changed since publication.'],
  source_unavailable: ['无法核对来源当前状态。', 'The current source status could not be checked.'],
} satisfies Record<InteractiveSourceIssue['status'], readonly [string, string]>;

export function interactiveSourceKind(source: InteractiveMaterialProvenance['source'], isZh: boolean) {
  if (source.kind === 'model-data') return isZh ? '模型构造的数据' : 'Model-provided data';
  if (source.kind === 'user-material') return isZh ? '用户提供的材料' : 'User-provided material';
  return isZh ? '工具实际返回的观测' : 'Observed tool result';
}

export const InteractiveSources = memo(function InteractiveSources({ provenance, issues, isZh }: { readonly provenance: readonly InteractiveMaterialProvenance[];
  readonly issues?: readonly InteractiveSourceIssue[]; readonly isZh: boolean }) {
  if (!provenance.length) return null;
  const observedTime = new Intl.DateTimeFormat(isZh ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'long' });
  return <>
    {issues?.length ? <div className="interactive-notice">
      <p>{isZh ? '打开时核对到以下来源状态。此结果继续使用已保存的快照。' : 'Source status at opening. This result still uses the saved snapshot.'}</p>
      <ul>{issues.map(({ bindingId, status }) => <li key={bindingId}><strong>{bindingId}</strong> {sourceIssueLabels[status][isZh ? 0 : 1]}</li>)}</ul>
    </div> : null}
    <MotionDetails className="interactive-source-details">
      <summary><PeerIcon name="chevronRight" size={12} />{isZh ? '查看已保存的来源' : 'View saved sources'}</summary>
      <ul>{provenance.map(({ bindingId, source, observedAt, selector, truncated, redacted }) => <li key={bindingId}>
        <div className="interactive-source"><strong>{bindingId}</strong><span>{interactiveSourceKind(source, isZh)}</span>
          {Number.isFinite(Date.parse(observedAt)) ? <time dateTime={observedAt}>{observedTime.format(new Date(observedAt))}</time> : null}
          {truncated ? <span>{isZh ? '来源已截断' : 'Source truncated'}</span> : null}
          {redacted ? <span>{isZh ? '来源已脱敏' : 'Source redacted'}</span> : null}
        </div>
        {selector ? <div className="interactive-source">
          {selector.path?.length ? <span>{isZh ? '路径' : 'Path'} <code>{JSON.stringify(selector.path)}</code></span> : null}
          {selector.fields?.length ? <span>{isZh ? '字段' : 'Fields'} <code>{JSON.stringify(selector.fields)}</code></span> : null}
          {selector.start !== undefined ? <span>{isZh ? '行偏移' : 'Row offset'} {selector.start}</span> : null}
          {selector.limit !== undefined ? <span>{isZh ? '最多行数' : 'Row limit'} {selector.limit}</span> : null}
        </div> : null}
      </li>)}</ul>
    </MotionDetails>
  </>;
});
