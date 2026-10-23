import { createI18n } from '@peer-agent/i18n';
import { useMemo } from 'react';
import { UnsavedChangesProvider } from '../../ui/forms/UnsavedChanges';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { CapabilityWorkbench } from '../../capabilities/components/CapabilityWorkbench';
import { clientApi } from '../../clientApi';

/** Catalog reads do not gate the independently available installed Skills/MCP controls. */
export function CapabilitiesPanel() {
  const i18n = useMemo(() => createI18n('zh-CN'), []);
  const reader = useResourceRead('capability-catalog', () => clientApi.listCapabilities());
  return <UnsavedChangesProvider i18n={i18n}><div className="capability-surface">
    {reader.loading || reader.error ? <div className="ui-form-feedback" role={reader.error ? 'alert' : 'status'} aria-busy={reader.loading}>
      <p>{reader.loading ? '正在读取能力清单…' : '能力清单暂未读到最新内容，技能和连接入口仍可使用。'}</p>
      {reader.error ? <button type="button" className="ui-button is-compact" onClick={() => void reader.reload()}>重新读取</button> : null}
    </div> : null}
    <CapabilityWorkbench capabilities={reader.value ?? []} />
  </div></UnsavedChangesProvider>;
}
