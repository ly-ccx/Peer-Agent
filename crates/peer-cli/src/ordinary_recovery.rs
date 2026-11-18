//! Local recovery control, with no model/tool admission or interactive terminal.
use peer_protocol::{CliExit, LocalAccessLevel};
use peer_runtime::conversation_host::{ConversationAccess, NativeConversationRuntime};
use serde_json::json;
use std::io::{self, Write};

pub fn run(session: &str) -> io::Result<CliExit> {
    let home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let result = crate::cancellation::run(|cancel| async move {
        let runtime = NativeConversationRuntime::new(
            &home,
            ConversationAccess::new(LocalAccessLevel::AskBeforeLocal),
        );
        runtime.recover(session, &cancel).await
    })?;
    match result {
        Ok(facts) => {
            let code = if facts.permits_new_run() {
                CliExit::Ok
            } else {
                CliExit::Runtime
            };
            writeln!(
                io::stdout(),
                "{}",
                json!({"status":"recovery_observed","facts":facts})
            )?;
            Ok(code)
        }
        Err(error) => {
            writeln!(
                io::stderr(),
                "peer recover: {} (session={})",
                error.0,
                peer_tui::terminal_text(session)
            )?;
            if error.0 == "STORE_LOCK_BUSY" {
                writeln!(
                    io::stderr(),
                    "恢复未取得排他权：另一个恢复者可能仍在运行，或 conversations/index.jsonl.lock、conversations/{safe}.jsonl.lock 存在未确认归属的目录锁。锁和执行事实已保留。先确认该数据根的全部写入宿主退出并保存诊断副本，再按离线维护流程核实孤锁；本命令不会自动清锁或重放工具。",
                    safe = peer_tui::terminal_text(session)
                )?;
            }
            Ok(if error.0 == "CANCELLED" {
                CliExit::Cancelled
            } else {
                CliExit::Runtime
            })
        }
    }
}
