import { useId, useState } from 'react';
import type { LlmSubscriptionQuota } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { usageAuth, usageDimension, usageFailure, usageLegacyMetrics, usageMoney, usageNumber, usagePeriod, usageScope, usageSource, usageTime, usageWindow, usageWindows } from './accountUsagePresentation';
import '../../styles/account-usage.css';

export function AccountUsageDetails({ quota, loading, zh, onRefresh }: { quota?: LlmSubscriptionQuota; loading: boolean; zh: boolean; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const windows = usageWindows(quota);
  const legacy = usageLegacyMetrics(quota, zh);
  const local = quota?.localUsage;
  const badge = loading ? (zh ? '查询中' : 'Loading') : quota?.stale ? (zh ? '已过期' : 'Stale')
    : quota && !quota.success ? (zh ? '暂不可用' : 'Unavailable') : quota?.partial ? (zh ? '部分数据' : 'Partial data') : '';
  const compact = quota?.balances?.[0] ? usageMoney(quota.balances[0].total, quota.balances[0].currency, zh)
    : windows.length ? `${windows.length} ${zh ? '个额度窗口' : 'usage windows'}` : undefined;
  const localMetrics = local ? [
    { label: zh ? '请求' : 'Requests', value: local.requests },
    { label: zh ? '输入 tokens' : 'Input tokens', value: local.inputTokens },
    { label: zh ? '输出 tokens' : 'Output tokens', value: local.outputTokens },
    ...(local.cacheReadTokens !== undefined ? [{ label: zh ? '缓存读取' : 'Cache read', value: local.cacheReadTokens }] : []),
    ...(local.cacheWriteTokens !== undefined ? [{ label: zh ? '缓存写入' : 'Cache write', value: local.cacheWriteTokens }] : []),
  ] : [];
  return <section className="account-usage" data-stale={quota?.stale || undefined} onClick={(event) => event.stopPropagation()}>
    <div className="account-usage-toolbar">
      <button type="button" className="account-usage-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}>
        <PeerIcon name="chevronRight" size={14} className="account-usage-chevron" />
        <span className="account-usage-title">{zh ? '余额与用量' : 'Balance & usage'}</span>
        {badge && <span className="account-usage-badge">{badge}</span>}
        {!expanded && compact && <span className="account-usage-preview" title={compact}>{compact}</span>}
      </button>
      <button type="button" className="account-usage-refresh" disabled={loading} onClick={onRefresh} aria-label={loading ? (zh ? '正在查询余额与用量' : 'Querying balance and usage') : (zh ? '刷新余额与用量' : 'Refresh balance and usage')}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7A7 7 0 0 1 18 6l2 2M4 16l2 2a7 7 0 0 0 11.9-1" /></svg>
        <span>{loading ? (zh ? '查询中…' : 'Loading…') : quota ? (zh ? '刷新' : 'Refresh') : (zh ? '查询' : 'Query')}</span>
      </button>
    </div>
    <div id={panelId} className="account-usage-body" hidden={!expanded}>
      <div className="account-usage-status" role="status" aria-live="polite" aria-busy={loading}>
        {loading && <p>{zh ? '正在获取最新数据…' : 'Fetching the latest data…'}</p>}
        {quota?.stale && <p>{zh ? '以下为上次查询结果，数据已过期，请刷新。' : 'Showing the previous observation. Data is stale; refresh to update.'}</p>}
        {quota && !quota.success && <p>{usageFailure(quota.status, zh)}</p>}
        {!quota && !loading && <p>{zh ? '尚未查询。点击右上方“查询”获取厂商数据与本地统计。' : 'Not queried yet. Use Query above to load vendor data and local usage.'}</p>}
      </div>
      {quota && <section className="account-usage-vendor" aria-label={zh ? '厂商账户数据' : 'Vendor account data'}>
        <div className="account-usage-section-heading">
          <h4>{zh ? '厂商账户' : 'Vendor account'}{quota.planLabel && <span className="account-usage-plan">{quota.planLabel}</span>}</h4>
          {quota.fetchedAt && <time dateTime={quota.fetchedAt} title={usageTime(quota.fetchedAt, zh, true)}>{zh ? '更新于 ' : 'Updated '}{usageTime(quota.fetchedAt, zh)}</time>}
        </div>
        {!!quota.balances?.length && <div className="account-usage-balances">
          {quota.balances.map((balance, index) => <div className="account-usage-balance" key={`${balance.currency}-${index}`}>
            <span className="account-usage-label">{usageScope(balance.scope, zh)}{zh ? '余额' : ' balance'}<span className="account-usage-source">{usageSource(balance.source, zh)}</span></span>
            <strong title={`${balance.currency} ${balance.total}`}>{usageMoney(balance.total, balance.currency, zh)}</strong>
            <div className="account-usage-balance-parts">
              {balance.paid !== undefined && <span>{zh ? '充值' : 'Paid'} {usageMoney(balance.paid, balance.currency, zh)}</span>}
              {balance.granted !== undefined && <span>{zh ? '赠送' : 'Granted'} {usageMoney(balance.granted, balance.currency, zh)}</span>}
            </div>
          </div>)}
        </div>}
        {!!windows.length && <div className="account-usage-windows">
          {windows.map((window, index) => {
            const view = usageWindow(window, zh);
            const name = window.label || (zh ? '订阅额度' : 'Subscription allowance');
            return <div className="account-usage-window" data-tone={view.tone} key={`${window.id}-${index}`}>
              <div className="account-usage-window-top"><strong>{name}</strong><span className="account-usage-percent">{view.text}{view.percent !== undefined && <small>{zh ? ' 已用' : ' used'}</small>}{view.tone === 'high' && <small className="account-usage-limit-label">{zh ? '接近上限' : 'Near limit'}</small>}</span></div>
              {view.percent !== undefined && <div className="account-usage-track" role="progressbar" aria-label={`${name}${zh ? '已用额度' : ' used allowance'}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-valuetext={`${view.text} ${zh ? '已用' : 'used'}`}><span style={{ transform: `scaleX(${view.percent / 100})` }} /></div>}
              <div className="account-usage-window-meta">
                <span>{[usageScope(window.scope, zh), window.source ? usageSource(window.source, zh) : '', view.counts, view.remaining].filter(Boolean).join(' · ')}</span>
                {window.resetsAt && <time dateTime={window.resetsAt} title={usageTime(window.resetsAt, zh, true)}>{usageTime(window.resetsAt, zh)} {zh ? '重置' : 'reset'}</time>}
              </div>
            </div>;
          })}
        </div>}
        {!!legacy.length && <dl className="account-usage-metrics">{legacy.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
        {!!quota.spend?.length && <div className="account-usage-spend"><h5>{zh ? '消费' : 'Spend'}</h5><dl className="account-usage-metrics">{quota.spend.map((item, index) => <div key={`${item.scope}-${item.period}-${index}`}><dt>{usageScope(item.scope, zh)} · {usagePeriod(item.period, zh)}</dt><dd title={`${item.currency} ${item.amount}`}>{usageMoney(item.amount, item.currency, zh)}</dd></div>)}</dl></div>}
        {!!quota.unavailable?.length && <ul className="account-usage-notes">{quota.unavailable.map((item, index) => <li key={index}><span className="account-usage-note-label">{usageDimension(item.dimension, zh)}</span><span>{item.reason}{item.requiredAuth && <span className="account-usage-auth">{usageAuth(item.requiredAuth, zh)}</span>}</span></li>)}</ul>}
      </section>}
      {local && <section className="account-usage-local" aria-label={zh ? 'Peer Agent 本地统计' : 'Peer Agent local usage'}>
        <div className="account-usage-section-heading"><h4>Peer Agent <span>{zh ? '本地统计' : 'local usage'}</span><span className="account-usage-badge">{zh ? '非账户总账' : 'Not the account ledger'}</span></h4>{local.estimatedCostUsd !== undefined && <span className="account-usage-estimate" title={String(local.estimatedCostUsd)}>{zh ? '估算费用 ' : 'Estimated ' }<strong>{usageMoney(local.estimatedCostUsd, 'USD', zh)}</strong></span>}</div>
        <dl className="account-usage-metrics">{localMetrics.map((item) => <div key={item.label}><dt>{item.label}</dt><dd title={usageNumber(item.value, zh)}>{usageNumber(item.value, zh, item.value >= 10000)}</dd></div>)}</dl>
        {(local.from || local.to) && <p className="account-usage-range" title={`${usageTime(local.from, zh, true)} – ${usageTime(local.to, zh, true)}`}>{usageTime(local.from, zh)} — {usageTime(local.to, zh)}</p>}
        <p className="account-usage-footnote">{local.note}</p>
      </section>}
    </div>
  </section>;
}
