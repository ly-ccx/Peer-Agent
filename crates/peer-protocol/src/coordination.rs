//! Canonical coordination reducer seam. Storage owns durable ordering/hash
//! validation; Runtime owns event semantics. A cache cannot implement this port.
use serde_json::Value;
pub trait CoordinationReducer {
    /// Unknown semantics must return an error, never preserve an empty state.
    fn reduce(&self, state: &Value, entry: &Value) -> Result<Value, &'static str>;
}
