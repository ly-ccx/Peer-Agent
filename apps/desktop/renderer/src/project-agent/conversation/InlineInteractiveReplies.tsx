import { useEffect, useMemo, useState } from 'react';
import type { EvidenceDelivery, InteractiveResultReference } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { InteractiveResource } from '../../workbench/interactive/InteractiveResource';
import './InlineInteractiveReplies.css';

const INTERACTIVE_REF_PREFIX = 'interactive-result://';
const MAX_INLINE_AUTO_EXPANDED = 2;

type InteractiveDelivery = Extract<EvidenceDelivery, { readonly kind: 'interactive' }>;

interface ResolvedInlineItem {
  readonly kind: 'interactive';
  readonly delivery: InteractiveDelivery;
  readonly createdAtMs: number;
}

interface ResolvedOriginOnlyItem {
  readonly kind: 'origin_only';
  readonly evidenceRef: string;
  readonly summary: string;
}

type InlineEntry = ResolvedInlineItem | ResolvedOriginOnlyItem;

function parseTimeMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Renders host-verified interactive deliveries from `message.meta.evidenceRefs` directly
 * inline inside a Bot reply bubble (ADR 118, 2026-11-25 amendment).
 *
 * Security invariant: ONLY consumes canonical `interactive-result://` entries confirmed by
 * `clientApi.projectAgentReadEvidence` for the current workspace owner; prose URIs or raw
 * OpenUI code blocks in message text never reach this component.
 */
export function InlineInteractiveReplies({
  workspaceId,
  evidenceRefs,
  isZh,
}: {
  readonly workspaceId: string;
  readonly evidenceRefs: readonly string[];
  readonly isZh: boolean;
}) {
  const workspace = useResourceWorkspace();
  const interactiveRefs = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of evidenceRefs) {
      if (typeof raw === 'string' && raw.startsWith(INTERACTIVE_REF_PREFIX) && !seen.has(raw)) {
        seen.add(raw);
        out.push(raw);
      }
    }
    return out;
  }, [evidenceRefs]);
  const refsKey = interactiveRefs.join('\n');
  const [items, setItems] = useState<readonly InlineEntry[]>([]);
  const [collapsedById, setCollapsedById] = useState<Readonly<Record<string, boolean>>>({});

  useEffect(() => {
    if (!workspaceId || interactiveRefs.length === 0) {
      setItems([]);
      return undefined;
    }
    let cancelled = false;
    void Promise.all(
      interactiveRefs.map(async (evidenceRef) => {
        try {
          const result = await clientApi.projectAgentReadEvidence({
            evidenceRef,
            context: { workspaceId },
          });
          return { evidenceRef, result };
        } catch {
          return { evidenceRef, result: null };
        }
      }),
    ).then((responses) => {
      if (cancelled) return;
      const byResultId = new Map<string, ResolvedInlineItem>();
      const order: string[] = [];
      const fallbacks: ResolvedOriginOnlyItem[] = [];
      for (const { evidenceRef, result } of responses) {
        if (!result || result.deliveryStatus === 'scope_denied') continue;
        if (result.deliveryStatus === 'available' && Array.isArray(result.deliveries)) {
          const createdAtMs = parseTimeMs(result.source?.createdAt);
          for (const delivery of result.deliveries) {
            if (delivery.kind !== 'interactive') continue;
            const resultId = delivery.interactiveReference.resultId;
            const existing = byResultId.get(resultId);
            if (!existing) {
              order.push(resultId);
              byResultId.set(resultId, { kind: 'interactive', delivery, createdAtMs });
            } else if (createdAtMs > existing.createdAtMs) {
              byResultId.set(resultId, { kind: 'interactive', delivery, createdAtMs });
            }
          }
          continue;
        }
        if (result.ok && result.interactiveAvailability === 'origin_only' && result.summary) {
          fallbacks.push({ kind: 'origin_only', evidenceRef, summary: result.summary });
        }
      }
      const next: InlineEntry[] = [
        ...order.map((id) => byResultId.get(id)!),
        ...fallbacks,
      ];
      setItems(next);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refsKey]);

  if (interactiveRefs.length === 0 || items.length === 0) return null;

  const openInPanel = (reference: InteractiveResultReference, title?: string) => {
    if (!workspace?.ready) return false;
    workspace.openInteractive(reference, title);
    return true;
  };

  return (
    <div className="bot-inline-interactive-list">
      {items.map((item, index) => {
        if (item.kind === 'origin_only') {
          return (
            <section key={item.evidenceRef} className="bot-inline-interactive is-fallback">
              <header className="bot-inline-interactive-header">
                <div className="bot-inline-interactive-heading">
                  <PeerIcon name="blocks" size={14} />
                  <span className="bot-inline-interactive-title">
                    {isZh ? '交互结果摘要（原设备）' : 'Interactive summary (origin device)'}
                  </span>
                </div>
              </header>
              <div className="bot-inline-interactive-body">
                <p className="bot-inline-interactive-fallback-text">{item.summary}</p>
              </div>
            </section>
          );
        }
        const { delivery } = item;
        const resultId = delivery.interactiveReference.resultId;
        const defaultCollapsed = index >= MAX_INLINE_AUTO_EXPANDED;
        const collapsed = collapsedById[resultId] ?? defaultCollapsed;
        const toggleCollapse = () => {
          setCollapsedById((prev) => ({ ...prev, [resultId]: !collapsed }));
        };
        return (
          <section
            key={delivery.artifactRef}
            className={`bot-inline-interactive${collapsed ? ' is-collapsed' : ''}`}
            data-interactive-result-id={resultId}
            aria-label={delivery.label}
          >
            <header className="bot-inline-interactive-header">
              <div className="bot-inline-interactive-heading">
                <PeerIcon name="blocks" size={14} />
                <span className="bot-inline-interactive-title">{delivery.label}</span>
              </div>
              <div className="bot-inline-interactive-actions">
                <button
                  type="button"
                  className="ui-button is-compact bot-inline-interactive-toggle"
                  aria-expanded={!collapsed}
                  onClick={toggleCollapse}
                >
                  <PeerIcon name={collapsed ? 'chevronDown' : 'chevronUp'} size={13} />
                  {collapsed ? (isZh ? '展开' : 'Expand') : (isZh ? '收起' : 'Collapse')}
                </button>
                {workspace ? (
                  <button
                    type="button"
                    className="ui-button is-compact bot-inline-interactive-expand"
                    disabled={!workspace.ready}
                    onClick={() => workspace.openDelivery(delivery)}
                  >
                    <PeerIcon name="panelRight" size={13} />
                    {isZh ? '在右侧展开' : 'Open in panel'}
                  </button>
                ) : null}
              </div>
            </header>
            {!collapsed ? (
              <div className="bot-inline-interactive-body">
                <InteractiveResource
                  reference={delivery.interactiveReference}
                  api={window.peerAgent?.interactiveResults}
                  active
                  inline
                  isZh={isZh}
                  onOpenReference={(ref) => openInPanel(ref, delivery.label)}
                />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
