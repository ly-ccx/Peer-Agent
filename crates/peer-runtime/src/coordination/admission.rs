//! Deterministic admission over already-admitted Host facts. These pure results
//! are candidates for canonical journal CAS, never execution/permission grants.
use super::{intent as intent_kernel, unique, value::*};
use peer_protocol::{javascript_json_digest, javascript_json_string};
use serde_json::{Value, json};
const ACTIONS: &[&str] = &[
    "parallel", "augment", "revise", "query", "answer", "cancel", "replace", "handoff", "resume",
];
fn fail(code: &str) -> Value {
    json!({"ok":false,"error":code})
}
fn bounded(state: &Value, input: &Value, host: &Value) -> bool {
    [state, input, host]
        .into_iter()
        .all(|v| javascript_json_string(v).is_ok())
}
fn hash(v: &Value) -> Option<String> {
    javascript_json_digest(v).ok()
}
fn id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty())
}
fn field_or<'a>(v: &'a Value, key: &str, default: &'a Value) -> &'a Value {
    v.get(key).filter(|v| truth(v)).unwrap_or(default)
}
mod decision;
mod intent;
pub use decision::admit_coordination_decision;
pub use intent::{admit_intent_assessment, admit_intent_closure};
