import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Multi-file repair with executable contracts; only the real worker edits the broken implementations. */
export function seedExecutionWorkload(project) {
  writeFileSync(path.join(project, 'README.md'), `# Isolated multi-file repair acceptance
Repair src/sum.mjs, src/group-events.mjs and src/render-csv.mjs. Keep every test assertion intact.
sumNumbers: empty arrays return 0; finite numbers sum; non-number or nonfinite elements throw TypeError.
groupEvents: accepts an array of {category,value}; category must be a nonempty trimmed string and value a finite number. Reject invalid rows with TypeError. Aggregate count/total per trimmed category. Return categories sorted ascending by JavaScript string order. Do not mutate inputs or retain state across calls.
renderCsv: accepts groups {category,count,total}; category is a string, count a nonnegative integer, total finite. Reject invalid rows with TypeError. Sort by category without mutating input. Return header category,count,total followed by newline-terminated rows; double quotes inside quoted fields; quote fields with comma, quote or newline. Use String(total), without forced decimal rounding.
Run node --test against all contracts and report the actual summary. Completion criteria are the executable assertions in these existing test files plus the system's independent verification. Do not create unrelated requirements or ask for another approval.
`);
  writeFileSync(path.join(project, 'src/group-events.mjs'), "export function groupEvents(events) { return events.map(event => ({category:event.category,count:1,total:event.value})); }\n");
  writeFileSync(path.join(project, 'src/render-csv.mjs'), "export function renderCsv(groups) { return groups.map(g=>[g.category,g.count,g.total].join(',')).join('\\n'); }\n");
  writeFileSync(path.join(project, 'group-events.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import {groupEvents} from './src/group-events.mjs';
test('empty events',()=>assert.deepEqual(groupEvents([]),[]));
test('aggregate and sort categories',()=>assert.deepEqual(groupEvents([{category:'b',value:2},{category:'a',value:1},{category:'b',value:3}]),[{category:'a',count:1,total:1},{category:'b',count:2,total:5}]));
test('normalize category spaces',()=>assert.deepEqual(groupEvents([{category:' a ',value:2},{category:'a',value:-2}]),[{category:'a',count:2,total:0}]));
test('fractional and zero totals',()=>assert.deepEqual(groupEvents([{category:'a',value:1.5},{category:'a',value:0}]),[{category:'a',count:2,total:1.5}]));
test('prototype-looking keys',()=>assert.deepEqual(groupEvents([{category:'__proto__',value:2}]),[{category:'__proto__',count:1,total:2}]));
test('no cross-call state',()=>{groupEvents([{category:'a',value:1}]);assert.deepEqual(groupEvents([]),[])});
test('no input mutation',()=>{const input=Object.freeze([Object.freeze({category:' z ',value:1})]);assert.equal(groupEvents(input)[0].category,'z')});
test('invalid collections and rows',()=>{for(const input of [null,{},[null],[{}],[{category:' ',value:1}],[{category:1,value:1}],[{category:'a',value:NaN}],[{category:'a',value:Infinity}],[{category:'a',value:'1'}]])assert.throws(()=>groupEvents(input),TypeError)});
`);
  writeFileSync(path.join(project, 'render-csv.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import {renderCsv} from './src/render-csv.mjs';import {groupEvents} from './src/group-events.mjs';
test('empty CSV',()=>assert.equal(renderCsv([]),'category,count,total\\n'));
test('ordered CSV rows',()=>assert.equal(renderCsv([{category:'b',count:1,total:2},{category:'a',count:2,total:3}]),'category,count,total\\na,2,3\\nb,1,2\\n'));
test('CSV quotes and comma',()=>assert.equal(renderCsv([{category:'a,"b',count:1,total:1}]),'category,count,total\\n"a,""b",1,1\\n'));
test('CSV embedded newline',()=>assert.equal(renderCsv([{category:'a\\nb',count:1,total:1}]),'category,count,total\\n"a\\nb",1,1\\n'));
test('negative fractional total',()=>assert.equal(renderCsv([{category:'a',count:1,total:-1.5}]),'category,count,total\\na,1,-1.5\\n'));
test('CSV does not sort input in place',()=>{const input=Object.freeze([Object.freeze({category:'z',count:1,total:1}),Object.freeze({category:'a',count:1,total:1})]);renderCsv(input);assert.equal(input[0].category,'z')});
test('invalid CSV inputs',()=>{for(const input of [null,{},[{}],[{category:'a',count:-1,total:1}],[{category:'a',count:1.5,total:1}],[{category:'a',count:1,total:NaN}],[{category:2,count:1,total:1}]])assert.throws(()=>renderCsv(input),TypeError)});
test('end-to-end aggregation',()=>assert.equal(renderCsv(groupEvents([{category:'b',value:2},{category:' a ',value:1.5},{category:'a',value:3}])),'category,count,total\\na,2,4.5\\nb,1,2\\n'));
test('large deterministic input',()=>{const rows=Array.from({length:20000},(_,i)=>({category:'c'+i%10,value:1}));const summary=groupEvents(rows);assert.equal(summary.length,10);assert.ok(summary.every(row=>row.count===2000&&row.total===2000));assert.equal(renderCsv(summary).split('\\n').length,12)});
`);
}
