import { createContext, useContext, useId, useRef, useState } from 'react';
import { isReactiveAssign, useStateField, type ComponentRenderProps } from '@openuidev/react-lang';
import { INTERACTIVE_RESULT_LIMITS as L, type InteractiveMaterialProvenance } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { Checkbox } from '../../ui/boolean-controls/Checkbox';
import type { InteractiveSession, InteractiveSessionSnapshot } from './interactiveSession';

export const InteractiveRenderContext = createContext<{ session: InteractiveSession; state: InteractiveSessionSnapshot;
  showResults: boolean; isZh: boolean; provenance: readonly InteractiveMaterialProvenance[] } | null>(null);
function useInteractiveRender() { const value = useContext(InteractiveRenderContext); if (!value) throw Error('interactive_view_unavailable'); return value; }
type P<T> = ComponentRenderProps<T>;
type Group = { children: unknown[] };
function Col({ props, renderNode }: P<Group>) { return <div className="interactive-col">{props.children.map((child, index) => <div key={index}>{renderNode(child)}</div>)}</div>; }
function Row({ props, renderNode }: P<Group>) { return <div className="interactive-row">{props.children.map((child, index) => <div key={index}>{renderNode(child)}</div>)}</div>; }
function Card({ props, renderNode }: P<Group & { title: string }>) { const ctx = useInteractiveRender(); return <section className="interactive-card"><h3 hidden={!ctx.showResults}>{props.title}</h3>{props.children.map((child, index) => <div key={index}>{renderNode(child)}</div>)}</section>; }
function Title({ props }: P<{ text: string }>) { return <h2 hidden={!useInteractiveRender().showResults} className="interactive-title">{props.text}</h2>; }
function Text({ props }: P<{ text: string }>) { return <p hidden={!useInteractiveRender().showResults} className="interactive-text">{props.text}</p>; }
function Caption({ props }: P<{ text: string }>) { return <p hidden={!useInteractiveRender().showResults} className="interactive-caption">{props.text}</p>; }
function Divider() { return <hr className="interactive-divider" />; }
function Metric({ props }: P<{ label: string; value: string | number; unit?: string }>) { return <dl hidden={!useInteractiveRender().showResults} className="interactive-metric"><dt>{props.label}</dt><dd>{String(props.value)}{props.unit ? <span> {props.unit}</span> : null}</dd></dl>; }

type Field = { id: string; label: string; value: unknown };
function useField(props: Field) {
  const ctx = useInteractiveRender(), field = useStateField<unknown>(props.id, props.value), id = useId();
  if (!isReactiveAssign(props.value) || !Object.hasOwn(ctx.session.content.stateSchema, props.value.target)) throw Error('invalid_state_binding');
  const key = props.value.target;
  const disabled = !ctx.state.writer || ['readonly', 'writer_lost', 'closing', 'closed'].includes(ctx.state.phase);
  const sync = () => { const state = ctx.session.snapshot(); if (!state.calculationError) field.setValue(state.sdkValues[key]); };
  return { ...ctx, id, key, disabled, sync };
}
function TextField({ props, numeric = false }: { props: Field & { min?: number; max?: number; step?: number }; numeric?: boolean }) {
  const f = useField(props), composing = useRef(false);
  const raw = f.state.inputDrafts[f.key] ?? String(f.state.values[f.key]);
  const update = (value: string, active: boolean) => { f.session.editText(f.key, value, active); f.sync(); };
  return <div className="interactive-field"><label htmlFor={f.id}>{props.label}</label><input id={f.id} type="text" inputMode={numeric ? 'decimal' : undefined}
    value={raw} maxLength={L.textChars} disabled={f.disabled} aria-describedby={numeric ? `${f.id}-range` : undefined}
    onCompositionStart={() => { composing.current = true; update(raw, true); }}
    onCompositionEnd={event => { composing.current = false; update(event.currentTarget.value, false); }}
    onChange={event => update(event.currentTarget.value, composing.current || Boolean((event.nativeEvent as InputEvent).isComposing))}
    onBlur={() => { void f.session.flush(); }} />
    {numeric ? <span id={`${f.id}-range`} className="interactive-caption">{f.isZh ? '范围' : 'Range'}: {props.min} – {props.max}</span> : null}</div>;
}
function Input({ props }: P<Field>) { return <TextField props={props} />; }
function NumberInput({ props }: P<Field & { min: number; max: number; step: number }>) { return <TextField props={props} numeric />; }
function Select({ props }: P<Field & { options: { value: string; label: string }[] }>) {
  const f = useField(props);
  return <div className="interactive-field"><label htmlFor={f.id}>{props.label}</label><span className="interactive-select"><select id={f.id} disabled={f.disabled}
    value={String(f.state.values[f.key])} onChange={event => { f.session.editValue(f.key, event.currentTarget.value); f.sync(); }} onBlur={() => { void f.session.flush(); }}>
    {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><PeerIcon name="chevronDown" size={16} /></span></div>;
}
function BooleanInput({ props }: P<Field>) {
  const f = useField(props);
  return <label className="interactive-check" htmlFor={f.id}><Checkbox id={f.id} disabled={f.disabled} checked={Boolean(f.state.values[f.key])}
    onChange={event => { f.session.editValue(f.key, event.currentTarget.checked); f.sync(); }} onBlur={() => { void f.session.flush(); }} />{props.label}</label>;
}
function Slider({ props }: P<Field & { min: number; max: number; step: number }>) {
  const f = useField(props);
  return <div className="interactive-field"><label htmlFor={f.id}>{props.label}: {String(f.state.values[f.key])}</label><input id={f.id} type="range" min={props.min} max={props.max} step={props.step}
    disabled={f.disabled} value={Number(f.state.values[f.key])} onChange={event => { f.session.editValue(f.key, Number(event.currentTarget.value)); f.sync(); }} onBlur={() => { void f.session.flush(); }} /></div>;
}
function Button({ props }: P<{ label: string; action: unknown }>) { const ctx = useInteractiveRender(); return <button type="button" className="ui-button" disabled={!ctx.state.writer || ctx.state.composing || ['writer_lost', 'closing', 'closed'].includes(ctx.state.phase)} onClick={() => ctx.session.applyAction(props.action)}>{props.label}</button>; }

type DataRow = Record<string, unknown>;
type TableProps = { label: string; columns: { key: string; label: string }[]; rows: DataRow[]; rowKey: string };
function cell(value: unknown) { if (value === undefined || value === null) return ''; return typeof value === 'object' ? JSON.stringify(value) : String(value); }
function DataTable({ label, columns, rows, rowKey }: TableProps) {
  const { isZh } = useInteractiveRender(), [requestedPage, setPage] = useState(0);
  const size = Math.min(L.tablePageRows, Math.floor(L.tablePageCells / columns.length)), pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(requestedPage, pages - 1);
  return <section className="interactive-table"><div className="interactive-table-scroll" tabIndex={0} role="region" aria-label={label}><table><caption>{label}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
    <tbody>{rows.slice(page * size, (page + 1) * size).map(row => <tr key={JSON.stringify([typeof row[rowKey], row[rowKey]])}>{columns.map(column => <td key={column.key}>{cell(row[column.key])}</td>)}</tr>)}</tbody></table></div>
    {!rows.length ? <p className="interactive-caption">{isZh ? '当前条件下没有数据。' : 'No data for these conditions.'}</p> : null}
    {pages > 1 ? <nav className="interactive-pagination" aria-label={isZh ? '表格分页' : 'Table pagination'}><button type="button" className="ui-button is-compact" disabled={!page} onClick={() => setPage(page - 1)}>{isZh ? '上一页' : 'Previous'}</button>
      <span>{page + 1} / {pages} · {rows.length} {isZh ? '行' : 'rows'}</span><button type="button" className="ui-button is-compact" disabled={page === pages - 1} onClick={() => setPage(page + 1)}>{isZh ? '下一页' : 'Next'}</button></nav> : null}</section>;
}
function Table({ props }: P<TableProps>) { const ctx = useInteractiveRender(); return <div hidden={!ctx.showResults}><DataTable {...props} /></div>; }
type ChartProps = { label: string; kind: 'bar' | 'line'; xKey: string; series: { key: string; label: string }[]; rows: DataRow[] };
function Chart({ props: p }: P<ChartProps>) {
  const ctx = useInteractiveRender(), id = useId();
  const values = p.rows.flatMap(row => p.series.map(series => Number(row[series.key]))), min = Math.min(0, ...values), max = Math.max(0, ...values);
  const scale = Math.max(1, ...values.map(Math.abs)), low = min / scale, range = (max / scale - low) || 1;
  const x = (index: number) => 40 + (index + 0.5) * 640 / Math.max(1, p.rows.length), y = (value: number) => 200 - (value / scale - low) / range * 176;
  return <section hidden={!ctx.showResults} className="interactive-chart"><p className="interactive-caption">{ctx.isZh ? '数值范围' : 'Value range'}: {min} – {max}</p><svg viewBox="0 0 720 240" role="img" aria-labelledby={id}><title id={id}>{p.label}</title><line className="interactive-chart-axis" x1={40} x2={680} y1={y(0)} y2={y(0)} />
    {p.series.map((series, s) => p.kind === 'line' ? <polyline key={series.key} className={`interactive-series interactive-series-${s}`} fill="none" points={p.rows.map((row, i) => `${x(i)},${y(Number(row[series.key]))}`).join(' ')} />
      : <g key={series.key} className={`interactive-series interactive-series-${s}`}>{p.rows.map((row, i) => { const value = Number(row[series.key]), width = 640 / Math.max(1, p.rows.length) / p.series.length;
        return <rect key={JSON.stringify([typeof row[p.xKey], row[p.xKey]])} x={x(i) - width * p.series.length / 2 + width * s} y={Math.min(y(0), y(value))} width={Math.max(0.2, width * 0.8)} height={Math.abs(y(value) - y(0))} />; })}</g>)}
    </svg><div className="interactive-chart-labels">{[...new Set([0, Math.floor((p.rows.length - 1) / 2), p.rows.length - 1])].filter(i => p.rows[i]).map(i => <span key={i}>{cell(p.rows[i][p.xKey])}</span>)}</div>
    <ul className="interactive-chart-legend">{p.series.map((series, index) => <li key={series.key} className={`interactive-series-${index}`}>{series.label}</li>)}</ul>
    <DataTable label={p.label} columns={[{ key: p.xKey, label: p.xKey }, ...p.series.map(series => ({ key: series.key, label: series.label }))]} rows={p.rows} rowKey={p.xKey} /></section>;
}
function SourceReference({ props }: P<{ bindingId: string; label: string }>) {
  const ctx = useInteractiveRender(), source = ctx.provenance.find(item => item.bindingId === props.bindingId);
  if (!ctx.showResults || !source) return null;
  const kind = source.source.kind === 'model-data' ? (ctx.isZh ? '模型构造的数据' : 'Model-provided data') : source.source.kind === 'user-material' ? (ctx.isZh ? '用户提供的材料' : 'User-provided material') : (ctx.isZh ? '工具实际返回的观测' : 'Observed tool result');
  return <aside className="interactive-source"><strong>{props.label}</strong><span>{kind}</span>{source.truncated ? <span>{ctx.isZh ? '来源已截断' : 'Source truncated'}</span> : null}{source.redacted ? <span>{ctx.isZh ? '来源已脱敏' : 'Source redacted'}</span> : null}</aside>;
}
export const peerInteractiveComponents = { Col, Row, Card, Title, Text, Caption, Divider, Metric, Input, NumberInput, Select, Checkbox: BooleanInput, Slider, Button, Table, Chart, SourceReference };
