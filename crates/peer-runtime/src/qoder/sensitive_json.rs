use crate::model::ModelError;
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::Value;
use zeroize::Zeroize;

/// Application-owned JSON strings, including unknown credential fields, are
/// erased together. Never derive Debug or serialize this owner to diagnostics.
pub(super) struct SensitiveJson(pub Value);
impl SensitiveJson {
    pub fn parse(bytes: &[u8], limit: usize) -> Result<Self, ModelError> {
        decode_json_bounded(
            bytes,
            JsonLimits {
                bytes: limit,
                nodes: 16384,
                depth: 32,
                string_bytes: limit,
            },
        )
        .map(|v| Self(v.value))
        .map_err(|_| ModelError::new("qoder_auth_invalid"))
    }
}
impl Drop for SensitiveJson {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}
fn wipe(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => {
            for (mut key, mut value) in std::mem::take(o) {
                key.zeroize();
                wipe(&mut value);
            }
        }
        _ => {}
    }
}
