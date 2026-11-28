//! Bounded MCP transports. One SDK channel entry, one immutable RPC at a time.
use super::*;
use rmcp::{
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use std::{io, process::Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
mod http;
pub(super) struct RpcTransport {
    out: mpsc::Sender<Vec<u8>>,
    input: mpsc::Receiver<RxJsonRpcMessage<RoleClient>>,
    cancel: CancellationToken,
    state: Arc<McpState>,
}
impl RpcTransport {
    pub fn close_now(&self) {
        self.cancel.cancel();
    }
}
impl Transport<RoleClient> for RpcTransport {
    type Error = io::Error;
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl std::future::Future<Output = io::Result<()>> + Send + 'static {
        let out = self.out.clone();
        let cancel = self.cancel.clone();
        let state = self.state.clone();
        async move {
            let value = serde_json::to_value(item).map_err(|_| io::ErrorKind::InvalidData)?;
            let bytes = serde_json::to_vec(&value).map_err(|_| io::ErrorKind::InvalidData)?;
            if bytes.len() > LIMITS["maxRequestBytes"].as_u64().unwrap() as usize {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            state.begin(&value);
            tokio::select! {biased;_=cancel.cancelled()=>Err(io::ErrorKind::Interrupted.into()),v=out.send(bytes)=>v.map_err(|_|io::ErrorKind::BrokenPipe.into())}
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        tokio::select! {biased;_=self.cancel.cancelled()=>None,v=self.input.recv()=>v}
    }
    async fn close(&mut self) -> io::Result<()> {
        self.cancel.cancel();
        Ok(())
    }
}
type Opened = (
    RpcTransport,
    tokio::task::JoinHandle<()>,
    Option<Child>,
    Option<tokio::task::JoinHandle<()>>,
);
pub(super) async fn open(
    config: &Value,
    cancel: CancellationToken,
    state: Arc<McpState>,
) -> Result<Opened, &'static str> {
    let (tx, rx) = mpsc::channel(LIMITS["channelEntries"].as_u64().unwrap() as usize);
    let (incoming, input) = mpsc::channel(LIMITS["channelEntries"].as_u64().unwrap() as usize);
    let transport = RpcTransport {
        out: tx,
        input,
        cancel: cancel.clone(),
        state: state.clone(),
    };
    if config["transport"] != "stdio" {
        let worker = http::open(config, rx, incoming, cancel, state).await?;
        return Ok((transport, worker, None, None));
    }
    let executable = config["command"]
        .as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .ok_or("mcp_command_invalid")?;
    let mut command = tokio::process::Command::new(executable);
    if let Some(args) = config["args"].as_array() {
        for arg in args {
            command.arg(arg.as_str().ok_or("mcp_command_invalid")?);
        }
    }
    if let Some(cwd) = config["cwd"].as_str().filter(|s| !s.is_empty()) {
        command.current_dir(cwd);
    }
    if let Some(env) = config["env"].as_object() {
        for (k, v) in env {
            let v = v.as_str().ok_or("mcp_env_invalid")?;
            if k.is_empty() || k.contains(['=', '\0']) || v.contains('\0') {
                return Err("mcp_env_invalid");
            }
            command.env(k, v);
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::recorder::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| "mcp_spawn_failed")?;
    let output = child.stdout.take().unwrap();
    let input = child.stdin.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    // Logs are deliberately discarded and continuously drained; secret-bearing
    // server diagnostics never enter model output or Evidence.
    let err_cancel = cancel.clone();
    let stderr = tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            tokio::select! {biased;_=err_cancel.cancelled()=>break,v=stderr.read(&mut chunk)=>if !matches!(v,Ok(n)if n>0){break}}
        }
    });
    let worker = tokio::spawn(async move {
        let result = tokio::select! {biased;_=cancel.cancelled()=>Ok(()),v=stdio(output,input,rx,incoming,&state)=>v};
        if let Err(error) = result {
            state.fail(error)
        } else {
            state.fail("mcp_connection_closed")
        }
    });
    Ok((transport, worker, Some(child), Some(stderr)))
}
async fn stdio(
    mut output: impl tokio::io::AsyncRead + Unpin,
    mut input: impl tokio::io::AsyncWrite + Unpin,
    mut requests: mpsc::Receiver<Vec<u8>>,
    incoming: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
    state: &Arc<McpState>,
) -> Result<(), &'static str> {
    let read = async {
        let mut chunk = [0u8; 4096];
        let mut frame = Vec::new();
        loop {
            let n = output
                .read(&mut chunk)
                .await
                .map_err(|_| "mcp_read_failed")?;
            if n == 0 {
                return Err("mcp_connection_closed");
            }
            for b in &chunk[..n] {
                if *b == b'\n' {
                    if !frame.is_empty() {
                        let msg = state.incoming(&frame)?;
                        incoming
                            .send(msg)
                            .await
                            .map_err(|_| "mcp_connection_closed")?;
                    }
                    frame.clear();
                } else {
                    if frame.len() >= LIMITS["maxFrameBytes"].as_u64().unwrap() as usize {
                        return Err("mcp_message_limit");
                    }
                    frame.push(*b);
                }
            }
        }
    };
    let write = async {
        while let Some(mut bytes) = requests.recv().await {
            let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "mcp_request_invalid")?;
            if raw["method"] == "tools/call" {
                state.sent.store(true, Ordering::Release);
            }
            bytes.push(b'\n');
            input
                .write_all(&bytes)
                .await
                .map_err(|_| "mcp_write_failed")?;
            input.flush().await.map_err(|_| "mcp_write_failed")?;
        }
        Err("mcp_connection_closed")
    };
    tokio::select! {v=read=>v,v=write=>v}
}
