use super::*;
impl GoalStore {
    /// Cold, bounded Context Source input; never raw checkpoint restoration.
    /// Large plans fail explicitly rather than silently omitting Goal facts.
    pub fn read_context(&self, id: &str, expected: &str) -> Result<Value, GoalError> {
        if !valid_id(id, false) {
            return Err(GoalError::Invalid);
        }
        if self.revision(id)? != expected {
            return Err(GoalError::Changed);
        }
        let bytes = files::read(&self.directory.join(format!("{id}.json")), 512 * 1024)?
            .ok_or(StoreError::NotFound)?;
        let value = peer_protocol::decode_json_bounded(
            &bytes,
            JsonLimits {
                bytes: 512 * 1024,
                nodes: 32768,
                depth: 64,
                string_bytes: 512 * 1024,
            },
        )
        .map_err(|_| GoalError::Limit)?
        .value;
        if value["planId"] != id || self.revision(id)? != expected {
            return Err(GoalError::Changed);
        }
        Ok(value)
    }
}
