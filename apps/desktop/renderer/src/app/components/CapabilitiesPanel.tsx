import type { CapabilityManifest } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { CapabilityWorkbench } from '../../capabilities/components/CapabilityWorkbench';

/**
 * CapabilitiesPanel 是「技能 / 能力」设置分区的薄包装层：
 *   - 负责从 clientApi.listCapabilities() 取能力清单（manifest）；
 *   - 把结果交给自包含的 CapabilityWorkbench 渲染。
 *
 * 取数失败时静默兜底为空数组——CapabilityWorkbench 的 Skills/MCP 标签页
 * 会各自通过 SkillsPanel / McpSettingsPanel 实时拉取并管理自身数据（含上传/启停），
 * 因此空 capabilities 不影响技能安装入口的可用性。
 */
export function CapabilitiesPanel() {
  const [capabilities, setCapabilities] = useState<readonly CapabilityManifest[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await clientApi.listCapabilities();
        if (!cancelled) {
          setCapabilities(caps);
        }
      } catch {
        if (!cancelled) {
          setCapabilities([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <CapabilityWorkbench capabilities={capabilities} />;
}
