//! Current Goal execution projection seam. Store supplies verified source bytes;
//! Runtime normalizes facts. Neither decoding nor projection grants execution.
use serde_json::Value;
pub trait GoalFactProjector {
    fn execution_facts(
        &self,
        plan: &Value,
        runner_progress: Option<&Value>,
    ) -> Result<Value, &'static str>;
}
