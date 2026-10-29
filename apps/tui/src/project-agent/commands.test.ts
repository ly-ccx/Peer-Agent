import {expect,test} from 'bun:test';
import {parseProjectCommand,createCardNumbers,cardAction,projectEntry,terminalText,replyEchoText} from './commands.ts';
test('project commands keep text and multiword answers and reject ambiguous numbers',()=>{
  expect(parseProjectCommand('/answer 2 please try again')).toEqual({kind:'card',operation:'answer',number:2,text:'please try again'});
  expect(parseProjectCommand('/task 3')).toEqual({kind:'task',number:3});
  for(const text of ['/approve 0','/deny -1','/task 2.5','/action 1','/answer 1','/takeover extra','/unknown'])expect(parseProjectCommand(text).kind).toBe('invalid');
  for(const view of ['bots','tasks','memory','objectives','cards','diagnostics'] as const)expect(parseProjectCommand('/'+view)).toEqual({kind:'view',view});
  for(const kind of ['takeover','classic','older','latest','help'] as const)expect(parseProjectCommand('/'+kind)).toEqual({kind});
  expect(parseProjectCommand('hello')).toEqual({kind:'text',text:'hello'});
});
test('card numbers stay attached to identity and vanished cards cannot execute',()=>{
  const map=createCardNumbers(), a={cardId:'a',actions:[{id:'allow',payload:{approvalId:'actual'}}]},b={cardId:'b',actions:[]};
  expect(map.project('w',[{cards:[a,b]}]).map(row=>row.number)).toEqual([1,2]);
  const current=map.project('w',[{cards:[b,{cardId:'c'}]}]);expect(current.map(row=>row.number)).toEqual([2,3]);
  expect(cardAction({kind:'card',operation:'approve',number:1,text:''},current)).toBeNull();
  expect(map.project('other',[{cards:[b]}])[0]?.number).toBe(1);
});
test('answers target actual current cards; resolved duplicates never offer actions',()=>{
  const cards=createCardNumbers().project('w',[{cards:[{cardId:'question',actions:[{id:'answer',payload:{answerTo:'question'}}]}]}]);
  expect(cardAction({kind:'card',operation:'answer',number:1,text:'yes'},cards)?.payload).toEqual({answerTo:'question',text:'yes'});
  expect(createCardNumbers().project('w',[{cards:[{cardId:'resolved',resolvedState:'resolved'}]}])).toEqual([]);
  expect(createCardNumbers().project('w',[{cards:[{cardId:'question',actions:[{id:'answer'}]}]},{cards:[{cardId:'question',resolvedState:'resolved'}]}])).toEqual([]);
});
test('startup honors classic, bots, existing bot and bind refusal routes',()=>{
  expect(projectEntry({classic:true},true)).toBe('classic');expect(projectEntry({bots:true},false)).toBe('bots');
  expect(projectEntry({},true)).toBe('conversation');expect(projectEntry({},false)).toBe('bind');
});
test('conversation text cannot write terminal titles or execute ANSI controls',()=>{
  expect(terminalText('hello\x1b]0;malicious\x07\x1b[31mworld\x1b[0m\x00')).toBe('helloworld');
  expect(terminalText('你好\nsecond\tline')).toBe('你好\nsecond\tline');
});
test('reply echo collapses the original message onto one line',()=>{
  // terminalText 有意保留换行；回显必须自己折叠，否则多行原话会撑成多行混进正文。
  expect(replyEchoText('第一行\n第二行\n第三行')).toBe('第一行 第二行 第三行');
  expect(replyEchoText('一\t二   三')).toBe('一 二 三');
  expect(replyEchoText('   \n\t ')).toBe('');
  expect(replyEchoText(undefined)).toBe('');
});
test('reply echo truncates by display columns with an ellipsis',()=>{
  // 60 列以内保持原样，不加省略号。
  expect(replyEchoText('短问题')).toBe('短问题');
  expect(replyEchoText('a'.repeat(56))).toBe('a'.repeat(56));
  // 超出列宽必须带省略号，且不切断半个字符。
  for(const echoed of [replyEchoText('a'.repeat(57)),replyEchoText('汉'.repeat(30)),replyEchoText('这是一段很长的用户原话'.repeat(10))]){
    expect(echoed.endsWith('…')).toBe(true);
    expect(echoed).not.toContain('\n');
  }
});
