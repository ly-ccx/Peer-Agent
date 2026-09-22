import { readFile, writeFile, mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const output = path.resolve('.peer-preview/task-information-acceptance');
const required = ['default', 'running', 'technical', 'stop-confirm', 'environment', 'narrow', 'ended'];
function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.subarray(12, 16).toString(), 'IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0);
  return { width, height };
}
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  for (const id of required) {
    const scene = manifest.scenes.find((item) => item.id === id);
    assert.ok(scene, `required scene ${id}`);
    const size = pngSize(await readFile(path.join(output, scene.file)));
    assert.deepEqual(size, scene.dimensions);
    assert.ok(html.includes(scene.file), `page references ${scene.file}`);
  }
  const main = manifest.scenes.find((item) => item.id === 'default');
  assert.match(main.cardText, /来源与工具/);
  assert.match(main.cardText, /后台任务/);
  assert.match(main.cardText, /release-process|fixture/);
  console.log(JSON.stringify({ status: 'passed', scenes: required.length, main: main.file, output }));
} else {
  let source = process.argv[2];
  if (!source) {
    const candidates = [];
    for (const name of await readdir(os.tmpdir())) {
      if (!name.startsWith('peer-task-monitor-electron-')) continue;
      const directory = path.join(os.tmpdir(), name);
      try {
        const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
        await stat(path.join(directory, 'acceptance/manifest.json'));
        if (report.status === 'passed') candidates.push({ directory, time: (await stat(directory)).mtimeMs });
      } catch { /* Incomplete and failed captures are not deliverables. */ }
    }
    candidates.sort((a, b) => b.time - a.time);
    assert.ok(candidates.length, 'No successful acceptance capture yet');
    source = path.join(candidates[0].directory, 'acceptance');
  }
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  for (const scene of manifest.scenes) {
    const from = path.join(source, scene.file);
    scene.dimensions = pngSize(await readFile(from));
    scene.sourcePath = from;
    await copyFile(from, path.join(output, scene.file));
  }
  manifest.scenes.sort((a, b) => required.indexOf(a.id) - required.indexOf(b.id));
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const data = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  await writeFile(path.join(output, 'index.html'), `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>任务信息卡 · 实机验收</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f7;color:#20242c;font:15px/1.6 system-ui,sans-serif}header,main{max-width:1440px;margin:auto;padding:24px 32px}header{padding-bottom:12px}h1{font-size:26px;margin:0 0 8px}p{margin:6px 0;color:#626b79}.badge{display:inline-block;background:#e2eee7;color:#276546;border-radius:6px;padding:3px 9px;font-size:12px}.notice{padding:12px 16px;border:1px solid #dfd5b5;background:#fffbef;border-radius:10px;margin-top:14px}nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}button,a{font:inherit}button{cursor:pointer;border:1px solid #d4dbe4;border-radius:8px;padding:8px 14px;background:white;color:inherit}button[aria-pressed=true]{background:#26364f;color:white;border-color:#26364f}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:10px}h2{font-size:19px;margin:0}a{color:#245dae}figure{margin:14px 0;background:white;border:1px solid #dce1e8;border-radius:12px;padding:8px}figure img{display:block;width:100%;height:auto;cursor:zoom-in}small{color:#667080}dialog{width:96vw;height:94vh;max-width:none;max-height:none;border:0;border-radius:12px;padding:12px;background:#f6f7f9}dialog::backdrop{background:#18212dcc}.zoom-head{position:sticky;top:0;display:flex;justify-content:space-between;background:#f6f7f9;padding:6px;z-index:1}.zoom-scroll{height:calc(100% - 58px);overflow:auto}dialog img{display:block;max-width:none}details{margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}footer{padding:12px 0 32px;color:#727c8a}@media(max-width:700px){header,main{padding:18px}.toolbar{align-items:flex-start;flex-direction:column}}
</style>
<header><span class="badge">真实 Electron 界面截图 · 测试数据</span><h1>任务信息卡 · 实机验收</h1><p>查看当前实现，不是重新绘制的效果图。点击截图可按原始尺寸放大。</p><div class="notice">隔离测试实例：调用历史、文件与网页为测试资料；后台命令真实运行。当前主图没有任务产物，产出区如实显示空态，来源和运行区有内容。</div></header>
<main><nav aria-label="验收场景"></nav><div class="toolbar"><h2 id="scene-title"></h2><div><button id="zoom">放大原图</button> <a id="original" target="_blank" rel="noopener">打开原图 ↗</a></div></div><p id="description"></p><small id="metadata"></small><figure><img id="main-image" alt="任务信息卡实机截图"></figure><details><summary>截图来源与测试数据说明</summary><pre id="provenance"></pre><a href="manifest.json" target="_blank">完整截图清单（JSON）</a></details><footer>验收页只展示截图，不模拟产品交互。截图中的按钮需在实际应用中操作。</footer></main>
<dialog id="lightbox"><div class="zoom-head"><strong id="zoom-title"></strong><button id="close">关闭放大</button></div><div class="zoom-scroll"><img id="zoom-image" alt="原始尺寸实机截图"></div></dialog>
<script type="application/json" id="manifest">${data}</script>
<script>
const manifest=JSON.parse(document.querySelector('#manifest').textContent);
const nav=document.querySelector('nav'),image=document.querySelector('#main-image'),dialog=document.querySelector('dialog');let selected;
for(const scene of manifest.scenes){const button=document.createElement('button');button.textContent=scene.title;button.dataset.scene=scene.id;button.onclick=()=>show(scene);nav.append(button)}
function show(scene){selected=scene;for(const b of nav.children)b.setAttribute('aria-pressed',String(b.dataset.scene===scene.id));document.querySelector('#scene-title').textContent=scene.title;document.querySelector('#description').textContent=scene.description;document.querySelector('#metadata').textContent=scene.dimensions.width+' × '+scene.dimensions.height+' · '+manifest.capturedAt+' · 当前代码 / 真实 Electron';image.src=scene.file;image.alt=scene.title+'，真实 Electron 截图';document.querySelector('#original').href=scene.file;document.querySelector('#provenance').textContent=manifest.fixtureNotice+'\\n来源：'+scene.sourcePath+'\\n\\n卡片内文字记录：\\n'+scene.cardText;history.replaceState(null,'','#'+scene.id)}
function zoom(){document.querySelector('#zoom-image').src=selected.file;document.querySelector('#zoom-title').textContent=selected.title+' · 原始尺寸';dialog.showModal()}
image.onclick=zoom;document.querySelector('#zoom').onclick=zoom;document.querySelector('#close').onclick=()=>dialog.close();show(manifest.scenes.find(s=>s.id===location.hash.slice(1))||manifest.scenes[0]);
</script></html>`);
  console.log('GALLERY_CREATED', output);
}
