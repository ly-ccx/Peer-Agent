//! Bounded byte fences on both output streams and a separate control packet.
use super::{CONTROL, ERROR_FENCE, OUTPUT_FENCE};
use crate::providers::shell::CapturedStream;
use std::path::Path;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt};

pub(super) struct CommandFrame {
    pub(super) script: String,
    pub(super) marker: Vec<u8>,
}

impl CommandFrame {
    pub(super) fn new(command: &str, out: &Path, err: &Path) -> Result<Self, &'static str> {
        if command.is_empty() || command.len() > 16_384 || command.contains('\0') {
            return Err("invalid_command");
        }
        let out = quote(out.to_str().ok_or("shell_session_output_path_invalid")?);
        let err = quote(err.to_str().ok_or("shell_session_output_path_invalid")?);
        let isolated = needs_subshell_isolation(command);
        Ok(Self::encode(
            &format!("command eval {}", quote(command)),
            Some((out, err)),
            isolated,
        ))
    }

    pub(super) fn change_directory(cwd: &Path) -> Result<Self, &'static str> {
        let path = cwd
            .to_str()
            .filter(|path| !path.contains('\0'))
            .ok_or("invalid_cwd")?;
        Ok(Self::encode(
            &format!("command cd {}", quote(path)),
            None,
            false,
        ))
    }

    fn encode(expression: &str, pipes: Option<(String, String)>, isolated: bool) -> Self {
        let nonce = uuid::Uuid::new_v4().simple();
        let marker = format!("\x1epeer-{nonce}\x1f").into_bytes();
        let encoded = format!("\\036peer-{nonce}\\037");
        let status = format!("__peer_status_{nonce}");
        let command = if isolated {
            format!(
                "( {expression} ) </dev/null {CONTROL}>&- {OUTPUT_FENCE}>&- {ERROR_FENCE}>&-\n{status}=$?\n",
            )
        } else {
            format!(
                "{{ {expression}; }} </dev/null {CONTROL}>&- {OUTPUT_FENCE}>&- {ERROR_FENCE}>&-\n{status}=$?\nset +e +u\n",
            )
        };
        let body = if let Some((out, err)) = pipes {
            format!(
                "{{ {{\n{command}command printf '{encoded}' >&{OUTPUT_FENCE}\n\
                command printf '{encoded}' >&{ERROR_FENCE}\n\
                }} {OUTPUT_FENCE}>&1 {ERROR_FENCE}>&2; }} >{out} 2>{err}\n"
            )
        } else {
            command
        };
        let script = format!(
            "{body}command printf '{encoded}%03d\\n' \"${status}\" >&{CONTROL}\nunset {status}\n"
        );
        Self { script, marker }
    }
}

/// Returns `true` when an unquoted shell token could terminate or alter the
/// exit-on-error state of the persistent `/bin/sh` interpreter (e.g. `exit`,
/// `return`, `trap`, or `set -e` / `set -u` / `set -o`). Running those commands
/// in a subshell `( command eval ... )` preserves exact exit-code semantics
/// without closing the persistent shell session.
pub(super) fn needs_subshell_isolation(command: &str) -> bool {
    let bytes = command.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut prev_was_set = false;
    while i < len {
        match bytes[i] {
            b' ' | b'\t' | b'\r' => {
                i += 1;
            }
            b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'{' | b'}' => {
                prev_was_set = false;
                i += 1;
            }
            b'#' => {
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'\'' => {
                prev_was_set = false;
                i += 1;
                while i < len && bytes[i] != b'\'' {
                    i += 1;
                }
                if i < len {
                    i += 1;
                }
            }
            b'"' => {
                prev_was_set = false;
                i += 1;
                while i < len && bytes[i] != b'"' {
                    if bytes[i] == b'\\' && i + 1 < len {
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                if i < len {
                    i += 1;
                }
            }
            b'\\' => {
                prev_was_set = false;
                i = (i + 2).min(len);
            }
            _ => {
                let start = i;
                let mut has_quote = false;
                while i < len
                    && !matches!(
                        bytes[i],
                        b' ' | b'\t'
                            | b'\r'
                            | b'\n'
                            | b';'
                            | b'&'
                            | b'|'
                            | b'('
                            | b')'
                            | b'{'
                            | b'}'
                            | b'<'
                            | b'>'
                    )
                {
                    match bytes[i] {
                        b'\'' => {
                            has_quote = true;
                            i += 1;
                            while i < len && bytes[i] != b'\'' {
                                i += 1;
                            }
                            if i < len {
                                i += 1;
                            }
                        }
                        b'"' => {
                            has_quote = true;
                            i += 1;
                            while i < len && bytes[i] != b'"' {
                                if bytes[i] == b'\\' && i + 1 < len {
                                    i += 2;
                                } else {
                                    i += 1;
                                }
                            }
                            if i < len {
                                i += 1;
                            }
                        }
                        b'\\' => {
                            has_quote = true;
                            i = (i + 2).min(len);
                        }
                        _ => i += 1,
                    }
                }
                if i == start {
                    prev_was_set = false;
                    i += 1;
                    continue;
                }
                if has_quote {
                    prev_was_set = false;
                    continue;
                }
                let word = &command[start..i];
                if matches!(word, "exit" | "return" | "trap") {
                    return true;
                }
                if prev_was_set {
                    if let Some(flags) = word.strip_prefix('-')
                        && !flags.is_empty()
                        && flags != "-"
                        && flags.bytes().any(|b| matches!(b, b'e' | b'u' | b'o'))
                    {
                        return true;
                    }
                    if word == "+o" {
                        return true;
                    }
                }
                prev_was_set = word == "set";
            }
        }
    }
    false
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) async fn capture(
    stream: &mut (impl AsyncBufRead + Unpin),
    marker: &[u8],
    output: &mut CapturedStream,
) -> Result<(), &'static str> {
    let mut pending = Vec::with_capacity(8192 + marker.len());
    loop {
        // After the last FIFO writer closes, readiness alone may not wake
        // this reader. Only an actual empty read ends the incomplete frame.
        let Ok(block) = tokio::time::timeout(super::FIFO_READ_RECHECK, stream.fill_buf()).await
        else {
            continue;
        };
        let block = block.map_err(|_| "shell_output_failed")?;
        if block.is_empty() {
            output.append(&pending).await?;
            return Err("shell_session_frame_missing");
        }
        let count = block.len();
        let carried = pending.len();
        pending.extend_from_slice(block);
        if let Some(at) = pending
            .windows(marker.len())
            .position(|bytes| bytes == marker)
        {
            output.append(&pending[..at]).await?;
            stream.consume(at + marker.len() - carried);
            return Ok(());
        }
        let emit = pending.len().saturating_sub(marker.len() - 1);
        output.append(&pending[..emit]).await?;
        pending.copy_within(emit.., 0);
        pending.truncate(pending.len() - emit);
        stream.consume(count);
    }
}

pub(super) async fn exit_code(
    stream: &mut (impl AsyncRead + Unpin),
    marker: &[u8],
) -> Result<u8, &'static str> {
    let mut packet = vec![0; marker.len() + 4];
    stream
        .read_exact(&mut packet)
        .await
        .map_err(|_| "shell_session_control_closed")?;
    let (tag, code) = packet.split_at(marker.len());
    if tag != marker || code[3] != b'\n' || !code[..3].iter().all(u8::is_ascii_digit) {
        return Err("shell_session_control_invalid");
    }
    std::str::from_utf8(&code[..3])
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or("shell_session_control_invalid")
}
