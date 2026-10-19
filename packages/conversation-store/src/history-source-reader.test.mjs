import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistorySourceReader } from './history-source-reader.mjs';

test('shared source capacity eviction changes cost only, and oversized inputs are not retained',()=>{
 let loads=0;const read=createHistorySourceReader({maxEntries:1,maxBytes:128,load:d=>{loads++;return {messages:[{id:d.conversationId,content:d.body||'value'}]}}});
 const d=id=>({conversationId:id,version:1}),get=(id,extra={})=>read({...d(id),...extra},{isCurrent:()=>true,immutableInput:true});
 const a=get('a');assert.ok(Object.isFrozen(a.messages[0]));get('a');assert.equal(loads,1);
 get('b');get('a');assert.equal(loads,3);
 get('large',{body:'x'.repeat(200)});get('large',{body:'x'.repeat(200)});assert.equal(loads,5);
 get('a');assert.equal(loads,5,'oversized source does not evict a retained source');
});
test('source publication rejects racing versions and stable errors rather than returning old input',()=>{
 let current=true,fail=false,loads=0;const read=createHistorySourceReader({load:()=>{loads++;if(fail)throw Error('corrupt');return {messages:[{content:'fact'}]}}});
 const desc={conversationId:'a',version:1},options={isCurrent:()=>current};
 current=false;assert.throws(()=>read(desc,options),{code:'BACKGROUND_VERSION_CHANGED'});
 current=true;assert.equal(read(desc,options).messages[0].content,'fact');assert.equal(loads,2);
 const first=read(desc,options);first.messages[0].content='caller';assert.equal(read(desc,options).messages[0].content,'fact');
 fail=true;assert.throws(()=>read({...desc,version:2},options),/corrupt/);
 current=false;assert.throws(()=>read({...desc,version:2},options),{code:'BACKGROUND_VERSION_CHANGED'});
 current=true;fail=false;assert.equal(read({...desc,version:3},options).messages[0].content,'fact');
});
