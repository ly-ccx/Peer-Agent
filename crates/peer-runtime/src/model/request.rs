use super::*;
impl NativeModel {
    pub(super) fn freeze(&self, body: Value) -> Result<PreparedRequest<'_>, ModelError> {
        wire::check_limit(&body)?;
        let bytes =
            serde_json::to_vec(&body).map_err(|_| ModelError::new("model_request_invalid"))?;
        let fingerprint = format!("{:x}", Sha256::digest(&bytes));
        Ok(PreparedRequest {
            owner: self,
            body,
            bytes: bytes.into(),
            fingerprint,
        })
    }
}
