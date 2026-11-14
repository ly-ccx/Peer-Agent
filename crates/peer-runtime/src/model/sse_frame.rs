//! One bounded SSE framing implementation for every model wire.
use super::ModelError;
#[derive(Default)]
pub(super) struct Frames {
    line: Vec<u8>,
    event: Vec<u8>,
    bytes: usize,
}
impl Frames {
    pub fn complete(&self) -> bool {
        self.line.is_empty() && self.event.is_empty()
    }
    pub fn push(
        &mut self,
        chunk: &[u8],
        mut emit: impl FnMut(&[u8]) -> Result<bool, ModelError>,
    ) -> Result<bool, ModelError> {
        self.bytes = self
            .bytes
            .checked_add(chunk.len())
            .ok_or(ModelError("model_response_limit"))?;
        if self.bytes > 8 * 1024 * 1024 {
            return Err(ModelError("model_response_limit"));
        }
        for b in chunk {
            if *b != b'\n' {
                if self.line.len() >= 1024 * 1024 {
                    return Err(ModelError("model_event_limit"));
                }
                self.line.push(*b);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            if self.line.is_empty() {
                if !self.event.is_empty() {
                    let terminal = emit(&self.event)?;
                    self.event.clear();
                    if terminal {
                        return Ok(true);
                    }
                }
                continue;
            }
            if let Some(data) = self.line.strip_prefix(b"data:") {
                let data = data.strip_prefix(b" ").unwrap_or(data);
                if self.event.len() + data.len() + 1 > 1024 * 1024 {
                    return Err(ModelError("model_event_limit"));
                }
                if !self.event.is_empty() {
                    self.event.push(b'\n');
                }
                self.event.extend_from_slice(data);
            }
            self.line.clear();
        }
        Ok(false)
    }
}
