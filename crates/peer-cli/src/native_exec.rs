use peer_protocol::CliExit;
use peer_runtime::{
    CancellationToken,
    session_host::{LocalPermissionDecision, PermissionInput},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    io::{self, IsTerminal, Write},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
struct TerminalPermission;
impl PermissionInput for TerminalPermission {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async move {
            if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
                return LocalPermissionDecision::Deny;
            }
            let details = json!({"arguments":prompt["arguments"],"scopes":prompt["scopes"]});
            let _ = writeln!(
                io::stderr(),
                "需要一次本地授权：{}\n操作与范围：{}\n只允许本次调用？[y/N]；Ctrl-C 暂停本轮执行。",
                peer_tui::terminal_text(prompt["tool"].as_str().unwrap_or("tool")),
                peer_tui::terminal_text(&details.to_string())
            );
            let input = io::stdin();
            let mut bytes = Vec::new();
            loop {
                let mut b = [0u8; 1];
                let wait = tokio::select! {biased;_=cancel.cancelled()=>return LocalPermissionDecision::Cancel,_=tokio::time::sleep(Duration::from_millis(20))=>true};
                let mut poll = [rustix::event::PollFd::new(
                    &input,
                    rustix::event::PollFlags::IN,
                )];
                if !wait
                    || rustix::event::poll(
                        &mut poll,
                        Some(&rustix::event::Timespec {
                            tv_sec: 0,
                            tv_nsec: 0,
                        }),
                    )
                    .ok()
                        != Some(1)
                {
                    continue;
                }
                let r = rustix::io::read(&input, &mut b);
                if r.ok() != Some(1) || bytes.len() >= 1024 {
                    return LocalPermissionDecision::Deny;
                }
                if b[0] == b'\n' {
                    break;
                }
                bytes.push(b[0]);
            }
            if matches!(
                std::str::from_utf8(&bytes).unwrap_or("").trim(),
                "y" | "yes"
            ) {
                LocalPermissionDecision::Approve
            } else {
                LocalPermissionDecision::Deny
            }
        })
    }
}
pub fn run(plan: &str, max_turns: usize, recover: bool) -> io::Result<CliExit> {
    let home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let flag = Arc::new(AtomicBool::new(false));
    let mut signals = Vec::new();
    for signal in [
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ] {
        signals.push(signal_hook::flag::register(signal, flag.clone())?)
    }
    let result = runtime.block_on(async {
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let watcher = tokio::spawn(async move {
            loop {
                if flag.load(Ordering::Relaxed) {
                    stop.cancel();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await
            }
        });
        let result = if recover{peer_runtime::native_exec::recover_plan(&home,plan,&cancel).await.map(|facts|(json!({"status":"recovery_observed","facts":facts}),CliExit::Ok))}else{peer_runtime::native_exec::execute_plan(
            &home,
            plan,
            &mut TerminalPermission,
            max_turns,
            &cancel,
        )
        .await.map(|outcome|{let code=if outcome.status=="max_turns"{CliExit::MaxTurns}else{CliExit::Ok};(json!({"status":outcome.status,"content":outcome.content,"toolCalls":outcome.tool_calls,"goalAcceptance":"pending","stop":outcome.stop}),code)})};
        watcher.abort();
        let _ = watcher.await;
        result
    });
    runtime.shutdown_timeout(Duration::from_secs(2));
    for s in signals {
        signal_hook::low_level::unregister(s);
    }
    match result {
        Ok((outcome, code)) => {
            writeln!(io::stdout(), "{}", outcome)?;
            Ok(code)
        }
        Err(e) => {
            writeln!(
                io::stderr(),
                "peer-native: {} (plan={})",
                e.0,
                peer_tui::terminal_text(plan)
            )?;
            let hint = match e.0 {
                "native_capability_inventory_unsupported" | "native_nested_context_unsupported" => {
                    Some("原生候选尚未接通所需的上下文或能力配置来源；配置已保留，此次未调用模型。")
                }
                "native_project_instruction_source_unsupported"
                | "native_project_context_source_unsupported"
                | "native_execution_context_unsupported"
                | "native_continuity_context_unsupported" => {
                    Some("原生候选尚未接通所需的上下文来源；原始内容已保留，此次未调用模型。")
                }
                "native_model_channel_unsupported" => Some(
                    "原生候选尚未支持该渠道、思考强度或请求参数组合；配置已保留，未向模型发送请求。",
                ),
                "HOST_LEASE_CONTENDED" => {
                    Some("项目由另一宿主持有执行权；请沿现有宿主接管流程交接后继续。")
                }
                "execution_outcome_unknown" => {
                    Some("未知效果仍受保护；recover --plan 可记录对账事实，原工具不会重放。")
                }
                "native_execution_stop_unproven" => Some(
                    "尚不能证明原执行及其句柄已结束；需沿现有任务详情的停稳/人工对账流程处理，保护记录保持原样。",
                ),
                "native_execution_requires_fresh_admission"
                | "native_execution_recovery_required" => {
                    Some("此入口只接受新的执行绑定；先核对既有任务的停稳、恢复和准入事实。")
                }
                "execution_resource_busy" => {
                    Some("目标资源正被其他任务或未知效果保护；请先核对对应任务。")
                }
                _ => None,
            };
            if let Some(hint) = hint {
                writeln!(io::stderr(), "{hint}")?;
            }
            Ok(if e.0 == "CANCELLED" {
                CliExit::Cancelled
            } else {
                CliExit::Runtime
            })
        }
    }
}
