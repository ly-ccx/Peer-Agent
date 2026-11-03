import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedJSON, canonicalJSON, catalogIdentity, createPeerLibrary, evaluate, prepareEvaluator, projectText, validateDraft, validateState } from './index.mjs';

const bindings = { rows: [{ name: 'A', cost: 25, group: 'one' }, { name: 'B', cost: 75, group: 'one' }] };
const program = '$budget = 1000\nroot = Col([Title("Comparison"), NumberInput("budget", "Budget", $budget, 0, 10000, 1), Metric("Remaining", $budget - @Total(@Data("rows"), "cost"), "USD"), Table("Options", [{key:"name",label:"Name"},{key:"cost",label:"Cost"}], @Data("rows"), "name")])';
const draft = (code = program) => ({ title: 'Comparison', textFallback: 'Model explanation; fixed inputs.', program: code });

test('permissive SDK parsing cannot silently discard expression tails or excessive grouping', async () => {
  for (const code of ['root=Metric("x",1) junk', '$x=1 2\nroot=Metric("x",$x)', 'root=Metric("x",1) null',
    'root=Metric("x",1)()', 'root=Metric("x",1),', 'root=' + '('.repeat(25) + 'Metric("x",1)' + ')'.repeat(25)]) {
    await assert.rejects(validateDraft(draft(code)), error => ['unconsumed_syntax', 'invalid_program', 'resource_limit'].includes(error.code));
  }
  const valid = await validateDraft(draft('root=(Metric(\'x\',((1e2)+(-2))))'));
  assert.equal(valid.tree.props.value, 98);
});

test('public OpenUI parser/evaluator computes the actual fixed data and changed state without I/O', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw Error('unexpected network'); };
  try {
    const content = await validateDraft(draft(), { bindings });
    assert.equal(content.tree.props.children[2].props.value, 900);
    const changed = await evaluate(content, { $budget: 2000 });
    assert.equal(changed.tree.props.children[2].props.value, 1900);
    assert.match(projectText(changed.tree).text, /Remaining: 1900 USD/);
    assert.equal(content.initialValues.$budget, 1000);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('catalog and state identities are stable across instances; unsupported catalogs fail closed', async () => {
  assert.equal(canonicalJSON(createPeerLibrary().toJSONSchema()), canonicalJSON(createPeerLibrary().toJSONSchema()));
  assert.match(await catalogIdentity(), /^sha256:[a-f0-9]{64}$/);
  const content = await validateDraft(draft(), { bindings });
  await assert.rejects(evaluate({ ...content, specHash: 'sha256:' + '0'.repeat(64) }), { code: 'incompatible_catalog' });
});

test('prepared UI evaluation is synchronous, isolated from caller mutation and strict before SDK state changes', async () => {
  const content = await validateDraft(draft('$x=2\nroot=Col([NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x)])'));
  const prepared = await prepareEvaluator(content);
  content.program = 'root=Text("changed")'; content.initialValues.$x = 9;
  assert.equal(prepared.evaluate({ $x: 5 }).tree.props.children[1].props.value, 2);
  assert.throws(() => prepared.evaluate({ $x: 0 }), { code: 'division_by_zero' });
  assert.equal(prepared.evaluate({ $x: 2 }).tree.props.children[1].props.value, 5);
  const forged = await validateDraft(draft('$x=2\nroot=NumberInput("x","x",$x,0,10,1)'));
  forged.stateSchema.$x.max = 100;
  forged.stateSchemaHash = await (await import('./engine.mjs')).digestJSON(forged.stateSchema);
  await assert.rejects(prepareEvaluator(forged), { code: 'incompatible_state_schema' });
});

test('local actions use only an admitted SDK plan and apply Set/Reset atomically under the state schema', async () => {
  const content = await validateDraft(draft('$x=2\nroot=Col([NumberInput("x","x",$x,0,10,1),Metric("x",$x),Button("Next",@Action([@Set($x,$x+1),@Set($x,$x*2)])),Button("Reset",@Reset($x))])'));
  const prepared = await prepareEvaluator(content), input = { $x: 2 };
  const [next, reset] = content.tree.props.children.slice(2).map(node => node.props.action);
  assert.equal(prepared.applyAction(next, input).values.$x, 6);
  assert.deepEqual(input, { $x: 2 });
  assert.equal(prepared.applyAction(reset, { $x: 7 }).values.$x, 2);
  assert.throws(() => prepared.applyAction(next, { $x: 8 }), { code: 'invalid_state' });
  assert.throws(() => prepared.applyAction({ steps: [{ type: 'open_url', url: 'https://example.com' }] }, input), { code: 'unsupported_action' });
  assert.throws(() => prepared.applyAction({ steps: [{ type: 'set', target: '$x', valueAST: { k: 'Num', v: 9 } }] }, input), { code: 'unsupported_action' });
});

test('nested action syntax cannot multiply the declared local action budget', async () => {
  const group = '@Action([' + Array.from({ length: 16 }, () => '@Set($x,2)').join(',') + '])';
  await assert.rejects(validateDraft(draft(`$x=1\nroot=Button("Many",@Action([${group},${group}]))`)), { code: 'unsupported_action' });
});

test('policy rejects all capability calls before parse/evaluation, including unused and skipped lines', async () => {
  for (const name of ['Query', 'Mutation', 'HtmlView', 'OpenUrl', 'Run', 'Now', 'Random', 'Shuffle', 'Each', 'Range', 'SearchImage']) {
    await assert.rejects(validateDraft(draft(`unused = ${name}("x")\nroot = Col([Text("safe")])`)), { code: 'unsupported_node' });
    await assert.rejects(validateDraft(draft(`${name}("x")\nroot = Col([Text("safe")])`)), { code: 'unsupported_node' });
  }
  await assert.rejects(validateDraft(draft('narration\nroot = Col([Text("safe")])')), { code: 'invalid_program' });
});

test('cycles, unresolved refs, reserved declarations and inherited member access are rejected', async () => {
  const invalid = [
    'a = b\nb = a\nroot = Col([a])',
    'root = Col([unknown])',
    'Data = Text("override")\nroot = Col([Data])',
    'x = {a:1}\nroot = Col([Metric("bad",x.constructor)])',
    'x = {a:1}\nroot = Col([Metric("bad",x["__proto__"])])',
    '$grant = true\nroot = Col([Text("safe")])',
  ];
  for (const code of invalid) await assert.rejects(validateDraft(draft(code)));
});

test('only literal registered immutable bindings and declared state keys are admitted', async () => {
  await assert.rejects(validateDraft(draft('root = Col([Metric("x",@Data("other"))])'), { bindings }), { code: 'invalid_binding' });
  await assert.rejects(validateDraft(draft('$name="rows"\nroot = Col([Metric("x",@Data($name))])'), { bindings }), { code: 'invalid_binding' });
  await assert.rejects(validateDraft(draft('root = Col([Metric("x",$missing)])')), { code: 'invalid_state' });
  await assert.rejects(validateDraft(draft('root = Col([Input("x","x","plain")])')), { code: 'invalid_state_binding' });
});

test('state preserves incomplete input drafts separately and rejects foreign keys, types and ranges', async () => {
  const content = await validateDraft(draft(), { bindings });
  assert.deepEqual(validateState({ $budget: 1000 }, content.stateSchema, { $budget: '-' }), { values: { $budget: 1000 }, inputDrafts: { $budget: '-' } });
  for (const state of [{ $budget: Infinity }, { $budget: '1' }, { $budget: 10001 }, { $budget: 0, $foreign: 1 }, {}]) {
    assert.throws(() => validateState(state, content.stateSchema));
  }
  assert.throws(() => validateState({ $budget: 0 }, content.stateSchema, { $foreign: 'x' }));
});

test('numeric overflow and invalid finite data cannot become a displayed value', async () => {
  await assert.rejects(validateDraft(draft('root = Col([Metric("x",1/0)])')), { code: 'division_by_zero' });
  await assert.rejects(validateDraft(draft('root = Col([Metric("x",1/"invalid")])')), { code: 'non_finite_value' });
  await assert.rejects(validateDraft(draft(), { bindings: { rows: [{ cost: Infinity }] } }), { code: 'non_finite_value' });
  await assert.rejects(validateDraft(draft('root = Col([Metric("x",1e999)])')), { code: 'non_finite_value' });
  const conditional = await validateDraft(draft('$x=0\nroot=Col([Metric("safe",$x == 0 ? 0 : 100 / $x)])'));
  assert.equal((await evaluate(conditional, { $x: 2 })).tree.props.children[0].props.value, 50);
  const changing = await validateDraft(draft('$x=1\nroot=Col([Metric("divide",100/$x)])'));
  await assert.rejects(evaluate(changing, { $x: 0 }), { code: 'division_by_zero' });
});

test('local Set/Reset action plans work, with no custom, URL or assistant actions', async () => {
  const content = await validateDraft(draft('$count=0\nroot = Col([Metric("Count",$count),Button("More",@Set($count,$count+1)),Button("Reset",@Reset($count))])'));
  assert.equal(content.tree.props.children[1].props.action.steps[0].type, 'set');
  for (const action of ['{type:"open_url",url:"https://example.com"}', '@ToAssistant("go")', '@Set($other,1)']) {
    await assert.rejects(validateDraft(draft(`$count=0\nroot = Col([Button("bad",${action})])`)));
  }
});

test('duplicate control IDs and malformed chart data fail instead of dropping content', async () => {
  await assert.rejects(validateDraft(draft('$x=1\nroot = Col([NumberInput("same","A",$x,0,5,1),NumberInput("same","B",$x,0,5,1)])')), { code: 'duplicate_component_id' });
  await assert.rejects(validateDraft(draft('root = Col([Chart("Bad","bar","name",[{key:"cost",label:"Cost"}],@Data("rows"),"cost")])'), { bindings: { rows: [{ name: 'A', cost: 'not a number' }] } }));
});

test('bounded grouping/filtering/formatting reuse the SDK function interface', async () => {
  const content = await validateDraft(draft('root = Col([Metric("Count",@RowCount(@RowsWhere(@Data("rows"),"cost","gt",30))),Metric("Total",@Decimal(@Total(@Data("rows"),"cost"),2))])'), { bindings });
  assert.equal(content.tree.props.children[0].props.value, 1);
  assert.equal(content.tree.props.children[1].props.value, '100.00');
});

test('reference expansion is rejected before SDK materialization can explode', async () => {
  const code = ['a0=Text("x")', ...Array.from({ length: 14 }, (_, i) => `a${i + 1}=Col([a${i},a${i}])`), 'root=Col([a14])'].join('\n');
  await assert.rejects(validateDraft(draft(code)), { code: 'resource_limit' });
});

test('large data and engine-shaped JSON are not admitted as trusted bindings', async () => {
  await assert.rejects(validateDraft(draft(), { bindings: { rows: Array.from({ length: 501 }, () => ({ cost: 1 })) } }), { code: 'resource_limit' });
  await assert.rejects(validateDraft(draft(), { bindings: { rows: [{ type: 'element', typeName: 'HtmlView', props: {} }] } }), { code: 'invalid_data_marker' });
  await assert.rejects(validateDraft(draft(), { bindings: { rows: [{ k: 'Comp', name: 'Query', args: [] }] } }), { code: 'invalid_data_marker' });
  await assert.rejects(validateDraft(draft('root=Col([Table("bad",[{key:"cost",label:"Cost"}],[{k:"Comp",name:"Query",args:[]}])])')), { code: 'reserved_key' });
  assert.throws(() => boundedJSON(Object.defineProperty({}, 'x', { enumerable: true, get() { throw Error('getter executed'); } })), { code: 'reserved_key' });
});

test('table text fallback marks its displayed range and never claims it is the full input', async () => {
  const content = await validateDraft(draft('root=Col([Table("Rows",[{key:"cost",label:"Cost"}],@Data("rows"),"cost")])'), { bindings: { rows: Array.from({ length: 120 }, (_, cost) => ({ cost })) } });
  assert.match(projectText(content.tree).text, /showing 100 of 120 rows/);
  assert.equal(projectText(content.tree, 20).truncated, true);
});

test('evaluation shares one work budget across pure functions and materialized rows, including changed-state branches', async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id, text: 'x'.repeat(4096) }));
  const table = 'Table("Rows",[{key:"id",label:"ID"}],@Data("rows"),"id")';
  const content = await validateDraft(draft(`$large=false\nroot=Col([$large?Col([${table},${table},${table}]):Text("small")])`), { bindings: { rows } });
  assert.equal(content.tree.props.children[0].typeName, 'Text');
  await assert.rejects(evaluate(content, { $large: true }), error => error.code === 'resource_limit' && error.details === 'evaluation_steps');
});
