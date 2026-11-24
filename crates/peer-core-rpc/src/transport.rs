use crate::protocol::MAX_FRAME_BYTES;
use peer_runtime::CancellationToken;
use serde_json::Value;
use std::{io, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::mpsc,
    task::JoinHandle,
};

const WRITER_CHANNEL_CAPACITY: usize = 512;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct BoundedLineReader<R> {
    inner: BufReader<R>,
}

impl<R: AsyncRead + Unpin> BoundedLineReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            inner: BufReader::with_capacity(8192, reader),
        }
    }

    /// Reads one `\n`-terminated frame up to `MAX_FRAME_BYTES` (excluding `\n`).
    /// Returns `Ok(None)` on clean EOF at a frame boundary or cancellation.
    pub(crate) async fn next_line(
        &mut self,
        shutdown: &CancellationToken,
    ) -> io::Result<Option<Vec<u8>>> {
        let mut line = Vec::new();
        loop {
            if shutdown.is_cancelled() {
                return Ok(None);
            }
            let buf = tokio::select! {
                biased;
                _ = shutdown.cancelled() => return Ok(None),
                chunk = self.inner.fill_buf() => chunk?,
            };
            if buf.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Incomplete JSON-RPC input frame",
                ));
            }
            if let Some(newline_pos) = buf.iter().position(|b| *b == b'\n') {
                if line.len() + newline_pos > MAX_FRAME_BYTES {
                    let consume_len = newline_pos + 1;
                    self.inner.consume(consume_len);
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "JSON-RPC input frame too large",
                    ));
                }
                line.extend_from_slice(&buf[..newline_pos]);
                self.inner.consume(newline_pos + 1);
                if line.ends_with(b"\r") {
                    line.pop();
                }
                return Ok(Some(line));
            }
            let chunk_len = buf.len();
            if line.len() + chunk_len > MAX_FRAME_BYTES {
                self.inner.consume(chunk_len);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "JSON-RPC input frame too large",
                ));
            }
            line.extend_from_slice(buf);
            self.inner.consume(chunk_len);
        }
    }
}

enum WriterMsg {
    Frame(Vec<u8>),
    Close,
}

#[derive(Clone)]
pub(crate) struct FrameWriter {
    tx: mpsc::Sender<WriterMsg>,
}

pub(crate) struct FrameWriterHandle {
    writer: FrameWriter,
    task: JoinHandle<io::Result<()>>,
}

impl FrameWriterHandle {
    pub(crate) fn spawn<W: AsyncWrite + Unpin + Send + 'static>(mut writer: W) -> Self {
        let (tx, mut rx) = mpsc::channel::<WriterMsg>(WRITER_CHANNEL_CAPACITY);
        let task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    WriterMsg::Frame(frame) => {
                        let write_res = tokio::time::timeout(WRITE_TIMEOUT, async {
                            writer.write_all(&frame).await?;
                            writer.flush().await
                        })
                        .await
                        .unwrap_or_else(|_| {
                            Err(io::Error::new(io::ErrorKind::TimedOut, "write timeout"))
                        });
                        if let Err(err) = write_res {
                            let _ = writer.shutdown().await;
                            return Err(err);
                        }
                    }
                    WriterMsg::Close => break,
                }
            }
            tokio::time::timeout(WRITE_TIMEOUT, writer.flush())
                .await
                .unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "flush timeout")))
        });
        Self {
            writer: FrameWriter { tx },
            task,
        }
    }

    pub(crate) fn writer(&self) -> FrameWriter {
        self.writer.clone()
    }

    pub(crate) async fn finish(self) -> io::Result<()> {
        let _ = tokio::time::timeout(WRITE_TIMEOUT, self.writer.tx.send(WriterMsg::Close)).await;
        drop(self.writer);
        match self.task.await {
            Ok(result) => result,
            Err(join_err) => Err(io::Error::other(format!("writer task failed: {join_err}"))),
        }
    }
}

pub(crate) fn encode_frame(message: &Value) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(message)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "JSON-RPC output frame too large",
        ));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

impl FrameWriter {
    pub(crate) async fn closed(&self) {
        self.tx.closed().await;
    }

    pub(crate) async fn send_preencoded(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.tx
            .send(WriterMsg::Frame(bytes))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "JSON-RPC output closed"))
    }

    pub(crate) async fn send_value(&self, message: &Value) -> io::Result<()> {
        let bytes = encode_frame(message)?;
        self.send_preencoded(bytes).await
    }
}
