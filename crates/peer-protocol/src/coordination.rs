//! Canonical coordination reducer seam. Storage owns durable ordering/hash
//! validation; Runtime owns event semantics. A cache cannot implement this port.
use serde_json::Value;
pub trait CoordinationReducer {
    /// Unknown semantics must return an error, never preserve an empty state.
    fn reduce(&self, state: &Value, entry: &Value) -> Result<Value, &'static str>;

    /// In-place transition for sequential journal replay. Defaults to `reduce`.
    fn reduce_in_place(&self, state: &mut Value, entry: &Value) -> Result<(), &'static str> {
        *state = self.reduce(state, entry)?;
        Ok(())
    }

    /// Final state-bound check invoked once after sequential replay completes.
    fn validate_state(&self, _state: &Value) -> Result<(), &'static str> {
        Ok(())
    }
}
