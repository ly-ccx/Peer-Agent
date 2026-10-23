import { projectWebClient } from './project-web-client.mjs';
import { createRemoteHistory } from './project-web-state.mjs';
export const projectPage=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Peer · 我的机器人</title><link rel="stylesheet" href="/assets/remote.css"><link rel="stylesheet" href="/assets/projects.css"></head>
<body><main class="project-shell">
<header class="project-masthead"><div><p class="eyebrow">PEER · 远程</p><h1>我的机器人</h1></div><a href="/devices" class="nav-link">设备与配对</a></header>
<form id="project-login" action="/auth/login" method="post" hidden><button class="btn-primary">登录 Peer</button></form>
<div class="project-toolbar"><p id="project-status" role="status">正在连接你的电脑…</p><button id="project-refresh" type="button">刷新</button><button id="project-logout" type="button" hidden>退出</button></div>
<section id="project-devices" class="device-summary" aria-label="电脑连接状态"></section>
<div class="project-layout"><section id="project-list" aria-label="机器人列表"></section>
<section id="project-chat" hidden aria-labelledby="chat-title">
<header class="chat-heading"><button id="project-back" type="button" aria-label="返回机器人列表">返回</button><h2 id="chat-title" tabindex="-1"></h2><button id="chat-refresh" type="button">更新对话</button></header>
<p id="chat-status" class="panel-note" role="status"></p><button id="chat-older" type="button" hidden>查看更早消息</button>
<button id="chat-latest" type="button">回到已加载的最新消息</button><div id="project-messages" class="project-messages" role="log" aria-live="off" tabindex="0" aria-label="机器人对话"></div>
<section id="project-tasks" class="project-tasks" aria-label="任务"></section>
<section id="project-task-detail" class="panel" hidden aria-label="任务详情"><button id="task-close" type="button">关闭详情</button><h3 id="detail-title"></h3><p id="detail-status" role="status"></p><button id="task-retry" type="button" hidden>重新读取任务</button><p id="detail-summary"></p></section>
<form id="project-input" class="project-composer"><label for="project-text">发消息给机器人</label><textarea id="project-text" rows="3" placeholder="交代任务，或问问进展…"></textarea><div class="composer-bottom"><span id="input-status" role="status">最多 4000 字，无附件</span><button id="project-send" class="btn-primary" type="submit">发送</button></div></form>
</section></div><p class="footnote">执行与授权由你的电脑处理。待批准事项请回到电脑确认；电脑离线时不接收消息。</p>
</main><script src="/assets/projects.js" defer></script></body></html>`;

export const projectStyles=`
.project-shell{max-width:1080px;margin:0 auto;padding:32px 24px;display:grid;gap:20px}
.project-masthead,.project-toolbar,.chat-heading,.composer-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.eyebrow{margin:0 0 6px;color:var(--ink-soft);font-size:var(--ui-font-meta);letter-spacing:.12em}.nav-link{color:var(--ink-soft);font-size:var(--ui-font-control);text-decoration:none}
.nav-link:focus-visible{outline:var(--ui-focus-width) solid var(--ui-focus-color);outline-offset:var(--ui-focus-offset)}.project-toolbar{flex-wrap:wrap}.project-toolbar p{flex:1;margin:0;color:var(--ink-soft);font-size:var(--ui-font-control)}
.project-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;align-items:start}.device-summary{display:flex;flex-wrap:wrap;gap:8px}.device-summary p{font-size:var(--ui-font-meta);color:var(--ink-soft);margin:0}
#project-list{display:grid;gap:6px}.project-row{display:flex;gap:12px;align-items:center;width:100%;padding:14px;text-align:left;border-color:transparent;background:transparent;border-radius:var(--ui-radius-row)}.project-row[aria-pressed=true]{background:var(--sheet);border-color:var(--hairline)}
.project-avatar{width:42px;height:42px;flex:none}.project-row-copy{min-width:0;flex:1;display:grid;gap:3px}.project-row-copy strong{overflow-wrap:anywhere;font-size:var(--ui-font-body)}.project-row-copy span{color:var(--ink-soft);font-size:var(--ui-font-meta);overflow-wrap:anywhere}.project-row-count{font-size:var(--ui-font-meta);color:var(--ink-soft)}
#project-chat{min-width:0}.chat-heading{padding-bottom:16px;border-bottom:1px solid var(--hairline)}.chat-heading h2{font-size:18px;flex:1;margin:0;overflow-wrap:anywhere}.chat-heading button{min-block-size:var(--ui-control-height-compact);padding:6px 9px;font-size:var(--ui-font-meta)}.project-messages{display:grid;gap:14px;min-height:180px;padding:20px 0;max-height:55vh;overflow:auto;overflow-anchor:none;overscroll-behavior:contain}.project-messages:focus-visible{outline:var(--ui-focus-width) solid var(--ui-focus-color);outline-offset:var(--ui-focus-offset)}
.project-message{padding:14px 16px;background:var(--sheet);border:1px solid var(--hairline-soft);border-radius:var(--ui-radius-message);white-space:pre-wrap;overflow-wrap:anywhere}.project-message.user_input{margin-left:32px;background:var(--base)}.project-message p{margin:6px 0 0}.message-meta{font-size:var(--ui-font-meta);color:var(--ink-soft)}.approval-note{font-size:var(--ui-font-meta);color:var(--state-warn)}.message-task{padding:4px 8px;margin-top:8px;font-size:var(--ui-font-meta)}.project-tasks{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:16px}.project-tasks button{font-size:var(--ui-font-meta);text-align:left}.project-composer{display:grid;gap:10px;border:1px solid var(--hairline);background:var(--sheet);border-radius:var(--ui-radius-composer);padding:14px}
.project-composer label{font-size:var(--ui-font-meta);color:var(--ink-soft)}textarea{resize:none;min-height:78px;font:inherit;background:transparent;border:0;color:var(--ink);width:100%;line-height:1.6}textarea:focus-visible{outline:var(--ui-focus-width) solid var(--ui-focus-color);outline-offset:var(--ui-focus-offset)}.composer-bottom span{font-size:var(--ui-font-meta);color:var(--ink-soft);flex:1}#project-task-detail{margin-bottom:16px}#detail-summary{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--ui-font-control)}#project-back{display:none}
@media(max-width:700px){.project-shell{padding:24px 16px;gap:16px}.project-layout{grid-template-columns:1fr;gap:0}.project-shell[data-chat=true] #project-list{display:none}.project-shell[data-chat=true] .project-masthead{display:none}#project-back{display:block}.chat-heading{gap:8px}.project-messages{max-height:52vh}.project-row{border-bottom:1px solid var(--hairline-soft);border-radius:0}.project-toolbar button{padding:6px 10px}.composer-bottom{align-items:flex-end}}
@media(pointer:coarse){.chat-heading button,.project-toolbar button{min-block-size:2.75rem}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto;transition:none}}
`;

export const projectScript = '(' + projectWebClient.toString() + ')(' + createRemoteHistory.toString() + ');';
