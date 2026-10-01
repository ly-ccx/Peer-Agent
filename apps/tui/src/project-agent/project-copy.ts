import type {TuiLocale} from '../tui-language.ts';
const english = {
  bots:'Bots', conversation:'Conversation', tasks:'Tasks', memory:'Memory', objectives:'Objectives', cards:'Needs you',
  bind:'Bind this directory to a bot?', yes:'Yes, create a bot', no:'No, open classic chat', empty:'Nothing here yet',
  host:'Running here', client:'Client · messages are queued to the host', desktop:'Handle this action on the desktop',
  composer:'Message this bot, or /help', received:'Received', replied:'Reply to', marks:'Result', you:'You', bot:'Bot',
  select:'Up/down to select · Enter to open · Esc to return', cardKeys:'Tab to select cards · arrows to choose · Enter to act',
  help:' /bots /tasks /task N /memory /objectives /cards /takeover /classic /older /latest\n /approve N /deny N /answer N text /action N option',
  invalid:'Invalid command or expired card. Use /help.', error:'Action failed', done:'Done', takeover:'Takeover requested',
  leaving:'Stopping the host. Tasks can continue on the next host.', earlier:'Earlier messages', latest:'Latest messages',
  allow:'Allow once',allow_task:'Allow this task',approve:'Approve',reject:'Deny',continue:'Continue',answer:'Answer',confirm:'Confirm result',
  accept_readme:'Allow README creation',retry:'Retry',choose_memory:'Keep this memory',familiarize:'Familiarize with project',familiarizeQuestion:'Shall I familiarize myself with this project?',
  running:'Running',waiting_user:'Waiting for you',waiting_approval:'Waiting for approval',accepted:'Accepted',
  result_ready:'Ready to confirm',queued:'Queued',paused:'Paused',completed:'Completed',failed:'Failed',cancelled:'Cancelled',
  active:'Active',forgotten:'Forgotten',conflicted:'Conflicted',stated:'Stated',verified:'Verified',inferred:'Inferred',
};
const chinese: Record<keyof typeof english,string> = {
  bots:'机器人',conversation:'对话',tasks:'任务',memory:'记忆',objectives:'目标',cards:'待处理',
  bind:'把这个目录绑定为机器人？',yes:'是，创建机器人',no:'否，进入经典对话',empty:'这里暂时没有内容',
  host:'由本终端运行',client:'客户端 · 消息将交由宿主处理',desktop:'请在桌面处理这个操作',
  composer:'跟机器人说话，或输入 /help',received:'已收到',replied:'回复',marks:'结果',you:'你',bot:'机器人',
  select:'上下键选择 · 回车打开 · Esc 返回',cardKeys:'Tab 选择卡片 · 方向键切换选项 · 回车执行',
  help:' /bots /tasks /task N /memory /objectives /cards /takeover /classic /older /latest\n /approve N /deny N /answer N 内容 /action N 选项',
  invalid:'命令无效或卡片已过期。输入 /help 查看用法。',error:'操作失败',done:'已完成',takeover:'已请求接管',
  leaving:'正在停止宿主。任务会在下一个宿主上继续。',earlier:'较早的消息',latest:'最新消息',
  allow:'允许一次',allow_task:'允许此任务',approve:'批准',reject:'拒绝',continue:'继续',answer:'回答',confirm:'确认结果',
  accept_readme:'允许创建 README',retry:'重试',choose_memory:'保留这条记忆',familiarize:'先熟悉一下项目',familiarizeQuestion:'要我先熟悉一下这个项目吗？',
  running:'进行中',waiting_user:'等你回答',waiting_approval:'待批准',accepted:'已签收',result_ready:'待签收',queued:'排队中',
  paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已取消',active:'有效',forgotten:'已撤回',conflicted:'有冲突',
  stated:'用户声明',verified:'已验证',inferred:'推断',
};
export function projectCopy(locale:TuiLocale,key:keyof typeof english) { return (locale==='en-US'?english:chinese)[key]; }
export function projectStatus(locale:TuiLocale,value:string) {return value in english ? projectCopy(locale,value as keyof typeof english):value;}
export function actionLabel(locale:TuiLocale,action:any) {return action.payload?.text || projectStatus(locale,action.id);}
