import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as presentation from './backgroundTaskPresentation.ts';
import * as runtime from './backgroundRuntimeState.ts';

const compiled = ts.transpileModule(readFileSync(new URL('./BackgroundRunDetails.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const jsx = (type: any, props: any) => ({ type, props });
function nodes(root: any): any[] {
  if (!root || typeof root !== 'object') return [];
  return Array.isArray(root) ? root.flatMap(nodes) : [root, ...nodes(root.props?.children)];
}
function text(root: any): string {
  if (root == null || typeof root === 'boolean') return '';
  if (Array.isArray(root)) return root.map(text).join('');
  return typeof root === 'object' ? text(root.props?.children) : String(root);
}
for (const isZh of [true, false]) for (const output of [false, true]) {
  for (const phase of ['idle', 'confirm', 'requesting', 'unconfirmed', 'rejected']) {
    test(`details ${isZh ? 'zh' : 'en'}/${output ? 'output' : 'empty'}/${phase}`, () => {
      const effects: (() => void)[] = [];
      const exports: any = {};
      const modules: any = {
        react: { useRef: () => ({ current: null }), useState: (v: any) => [v, () => {}], useEffect: (fn: () => void) => effects.push(fn) },
        'react/jsx-runtime': { jsx, jsxs: jsx },
        '../ui/icons': { PeerIcon: 'svg-icon' },
        './backgroundTaskPresentation': presentation,
        './backgroundRuntimeState': runtime,
      };
      vm.runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
      let confirms = 0, stops = 0, cancels = 0, focused = false;
      const tree = exports.BackgroundRunDetails({
        task: { taskId: 'run', command: 'printf hello', status: 'running', cwd: '/work', runInBackground: true,
          stdout: output ? 'hello' : '', stderr: '', conversationId: 'conversation' },
        sources: [], isZh, request: phase === 'idle' ? null : { phase, error: 'denied' },
        onConfirm: () => confirms++, onStop: () => stops++, onCancel: () => cancels++,
      });
      const all = nodes(tree);
      assert.equal(all.filter(n => n.type === 'details').length, 2);
      assert.ok(all.filter(n => n.type === 'details').every(n => !n.props.open));
      assert.equal(all.filter(n => n.type === 'svg-icon').length, 5);
      assert.ok(!all.some(n => n.props?.className === 'background-run-listeners'));
      assert.equal(text(all.find(n => n.props?.className === 'background-run-command')), `${isZh ? '执行命令' : 'Command'}printf hello`);
      assert.equal(text(all.find(n => n.props?.className === 'background-run-output')), output ? 'stdout\nhello' : isZh ? '尚无输出' : 'No output yet');
      const buttons = all.filter(n => n.type === 'button');
      if (phase === 'confirm') {
        const cancel = buttons.find(n => text(n) === (isZh ? '取消' : 'Cancel'));
        cancel.props.ref.current = { focus: () => { focused = true; } };
        effects.forEach(fn => fn());
        assert.equal(focused, true);
        cancel.props.onClick(); assert.equal(cancels, 1); assert.equal(stops, 0);
        buttons.find(n => text(n) === (isZh ? '停止运行' : 'Stop run')).props.onClick();
        assert.equal(stops, 1); assert.equal(confirms, 0);
      } else {
        const stop = buttons.find(n => text(n) === (isZh ? '停止…' : 'Stop…'));
        assert.equal(stop.props.disabled, phase === 'requesting' || phase === 'unconfirmed');
        if (!stop.props.disabled) stop.props.onClick();
        assert.equal(stops, 0);
        assert.equal(confirms, stop.props.disabled ? 0 : 1);
        if (phase === 'rejected') assert.ok(all.some(n => n.props?.role === 'alert' && text(n) === 'denied'));
      }
    });
  }
}
