//! At most one bounded frozen nonidentity body and one active attempt. Nothing
//! rereads Context or appends a partial assistant/tool response during retry.
use super::*;
pub(crate) struct RetrySeed<'a> {
    owner: &'a NativeModel,
    body: Value,
}
impl<'a> PreparedRequest<'a> {
    pub(crate) fn retry_seed(&self) -> Option<RetrySeed<'a>> {
        (self.owner.wire == wire::Wire::Qoder).then(|| RetrySeed {
            owner: self.owner,
            body: self.body.clone(),
        })
    }
}
impl<'a> RetrySeed<'a> {
    pub(crate) fn prepare(&self) -> Result<PreparedRequest<'a>, ModelError> {
        let mut body = self.body.clone();
        wire::qoder::refresh_identity(&mut body, self.owner.generation.qoder_dialect, true);
        self.owner.freeze(body)
    }
}
impl NativeModel {
    pub(super) fn freeze(&self, body: Value) -> Result<PreparedRequest<'_>, ModelError> {
        wire::check_limit(&body)?;
        let bytes =
            serde_json::to_vec(&body).map_err(|_| ModelError::new("model_request_invalid"))?;
        let bytes = if self.wire == wire::Wire::Qoder
            && self.generation.qoder_dialect == wire::QoderDialect::Prepared
        {
            let raw = std::str::from_utf8(&bytes)
                .map_err(|_| ModelError::new("model_request_invalid"))?;
            let encoded = crate::qoder::encode_body(raw)
                .map_err(|_| ModelError::new("model_request_limit"))?;
            if encoded.expose().len() > 2 * 1024 * 1024 {
                return Err(ModelError::new("model_request_limit"));
            }
            encoded.expose().as_bytes().to_vec()
        } else {
            bytes
        };
        let fingerprint = format!("{:x}", Sha256::digest(&bytes));
        Ok(PreparedRequest {
            owner: self,
            body,
            bytes,
            fingerprint,
        })
    }
}
