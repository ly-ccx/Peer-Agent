import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Overlay } from '../renderer/src/app/components/Overlay';
import { BackgroundRuntimePanel } from '../renderer/src/workbench/BackgroundRuntimePanel';
import { useBackgroundRunStops } from '../renderer/src/workbench/useBackgroundRunStops';

function Fixture() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [clicks, setClicks] = useState(0);
  const [longText, setLongText] = useState(false);
  const [manyRuns, setManyRuns] = useState(false);
  const snapshot = useMemo(() => {
    const runs = [{ taskId: 'visual-only', command: 'node preview-server.mjs', description: '网站预览服务', cwd: '/test/site', conversationId: 'source', runInBackground: true, status: 'running', stdout: 'Preview output', stderr: '' }];
    if (longText) {
      runs[0].description = '长名称无空格'.repeat(60);
      runs[0].stdout = 'LONG_OUTPUT'.repeat(2000);
    }
    if (manyRuns) {
      for (let index = 0; index < 30; index += 1) runs.push({ ...runs[0], taskId: `run-${index}`, description: `运行 ${index}` });
    }
    return runs;
  }, [longText, manyRuns]);
  const reload = useCallback(async () => {}, []);
  const stops = useBackgroundRunStops(snapshot, reload, true);
  return <main style={{ padding: 24 }}>
    <h1>后台运行界面验收</h1>
    <button id="outside" onClick={() => setClicks(clicks + 1)}>背景操作 {clicks}</button>
    <button id="modal-trigger" onClick={() => setModal(true)}>旧模态</button>
    <button id="long-text" onClick={() => setLongText(true)}>长文本</button>
    <button id="many-runs" onClick={() => setManyRuns(!manyRuns)}>长列表</button>
    <footer style={{ position: 'fixed', bottom: 24, left: 24 }}>
      <button id="entry" ref={anchor} onClick={() => setOpen(!open)}>后台运行 · 1</button>
    </footer>
    {open && anchor.current && <BackgroundRuntimePanel id="test-panel" anchor={anchor.current} snapshot={snapshot} error={null} reload={reload} stops={stops}
      sources={[{ id: 'source', title: '网站改版' }]} isZh onClose={() => setOpen(false)} />}
    {modal && <Overlay ariaLabel="旧模态" onClose={() => setModal(false)}><button>模态内容</button></Overlay>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
