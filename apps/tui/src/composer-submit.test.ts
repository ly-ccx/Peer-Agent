import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ChatSnapshot} from './chat-controller.ts';
import {chipifyImagePathsInText,extractImagePathTokens,registerImagePathKeys} from './composer-image-paths.ts';
import {createComposerSubmission} from './composer-submit.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function fixture() {
  let draft='请查看这张图片',cleared=0,restored=0;
  const calls:unknown[]=[];
  const notices:Array<string|null>=[];
  const input={value:draft,locale:'zh-CN' as const,imagePathRegistry:new Map<string,string>(),
    controller:{getSnapshot:():ChatSnapshot=>({status:'idle',mode:'chat',messages:[]}),
      send:async(...args:unknown[])=>{calls.push(args);return {status:'completed' as const,turns:1};}},
    isCurrentDraft:()=>draft===input.value,
    clearDraft:()=>{cleared++;draft='';},restoreDraft:()=>{restored++;if(!draft)draft=input.value;},
    onBeforeSend:()=>{},onCommandInput:()=>false,onNotice:(notice:string|null)=>{notices.push(notice);}};
  return {input,calls,notices,get draft(){return draft;},get cleared(){return cleared;},get restored(){return restored;},edit(text:string){draft=text;}};
}

test('attachment read failure preserves the draft and exposes an error',async()=>{
  const f=fixture(),submission=createComposerSubmission({loadAttachments:async()=>{throw new Error('read denied');}});
  await submission.submit(f.input);
  expect(f.draft).toBe(f.input.value);expect(f.cleared).toBe(0);expect(f.calls).toEqual([]);
  expect(f.notices.at(-1)).toContain('read denied');
  expect(f.notices.at(-1)).toContain('草稿已保留');
});

test('repeated Enter while images load starts one submission and clears only after preparation',async()=>{
  const f=fixture();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const image={url:'data:image/png;base64,fixture',mimeType:'image/png'};
  const submission=createComposerSubmission({loadAttachments:async()=>{await gate;return {text:f.input.value,images:[image],displayContent:f.input.value,missingPaths:[]};}});
  const first=submission.submit(f.input);
  await submission.submit(f.input);
  expect(f.cleared).toBe(0);expect(f.calls).toEqual([]);
  release();await first;
  expect(f.cleared).toBe(1);expect(f.calls).toEqual([[f.input.value,{images:[image]}]]);
});

test('editing while an image loads preserves the new draft and cancels the old submission',async()=>{
  const f=fixture();
  const submission=createComposerSubmission({loadAttachments:async()=>{
    f.edit('已经改成另一条消息');return {text:f.input.value,images:[],displayContent:f.input.value,missingPaths:[]};
  }});
  await submission.submit(f.input);
  expect(f.draft).toBe('已经改成另一条消息');expect(f.calls).toEqual([]);expect(f.cleared).toBe(0);
});

test('unreadable image never silently downgrades to a text-only message',async()=>{
  const f=fixture(),submission=createComposerSubmission({loadAttachments:async()=>({text:f.input.value,images:[],displayContent:f.input.value,missingPaths:['missing.png']})});
  await submission.submit(f.input);
  expect(f.calls).toEqual([]);expect(f.cleared).toBe(0);expect(f.notices.at(-1)).toContain('图片无法读取');
});

test('shell-escaped image path with spaces sends as an attachment',async()=>{
  const dir = await mkdtemp(path.join(tmpdir(), 'peer-submit-space-'));
  const spacedDir = path.join(dir, 'Application Support');
  const imagePath = path.join(spacedDir, 'shot-3a0ac4eb097.png');
  const escaped = imagePath.replaceAll(' ', '\\ ');
  const draft = `但是这样就跑到这个目录下面了 ${escaped}`;
  try {
    await mkdir(spacedDir, { recursive: true });
    await writeFile(imagePath, PNG);
    const registry = new Map<string, string>();
    registerImagePathKeys(registry, extractImagePathTokens(draft));
    const chipped = chipifyImagePathsInText(draft);
    const f = fixture();
    f.input.value = chipped;
    f.input.imagePathRegistry = registry;
    f.edit(chipped);
    const submission = createComposerSubmission();
    await submission.submit(f.input);
    expect(f.cleared).toBe(1);
    expect(f.restored).toBe(0);
    expect(f.calls).toHaveLength(1);
    const sent = f.calls[0] as [string, { images: Array<{ mimeType?: string }> } | undefined];
    expect(sent[0]).toBe('但是这样就跑到这个目录下面了');
    expect(sent[1]?.images).toHaveLength(1);
    expect(sent[1]?.images[0]?.mimeType).toBe('image/png');
    expect(f.notices.at(-1)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a skipped controller submission restores the original draft',async()=>{
  const f=fixture();
  const input={...f.input,controller:{...f.input.controller,send:async()=>({status:'skipped' as const,turns:0})}};
  const submission=createComposerSubmission({loadAttachments:async()=>({text:f.input.value,images:[],displayContent:f.input.value,missingPaths:[]})});
  await submission.submit(input);
  expect(f.restored).toBe(1);expect(f.draft).toBe(input.value);
});
