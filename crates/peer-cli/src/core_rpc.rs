//! Local Rust Core stdio JSON-RPC host entrypoint (`peer core --stdio`).

use peer_core_rpc::{CoreServerConfig, serve_stdio};
use peer_protocol::CliExit;
use std::io;

pub fn run() -> io::Result<CliExit> {
    let data_home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let config = CoreServerConfig::new(crate::VERSION.trim(), data_home);
    let outcome = crate::cancellation::run(|cancel| async move {
        let server_cancel = cancel.clone();
        let result = serve_stdio(config, server_cancel).await;
        (result, cancel.is_cancelled())
    })?;
    match outcome {
        (Ok(()), _) => Ok(CliExit::Ok),
        (Err(error), true) if error.kind() == io::ErrorKind::Interrupted => Ok(CliExit::Cancelled),
        (Err(error), _) => Err(error),
    }
}
