use super::*;
pub(super) struct Token(Value);
impl Drop for Token {
    fn drop(&mut self) {
        crate::credentials::scrub(&mut self.0);
    }
}
impl Token {
    fn replace(&mut self, field: &str, value: Value) {
        if let Some(old) = self.0.get_mut(field) {
            crate::credentials::scrub(old);
        }
        self.0[field] = value;
    }
    pub(super) fn parse(raw: &str) -> Result<Self, ModelError> {
        let value = peer_protocol::decode_json_bounded(
            raw.as_bytes(),
            peer_protocol::JsonLimits {
                bytes: 65536,
                nodes: 1024,
                depth: 12,
                string_bytes: 65536,
            },
        )
        .map_err(|_| ModelError::new("model_oauth_token_invalid"))?
        .value;
        let token = Self(value);
        if !token.0.is_object() {
            return Err(ModelError::new("model_oauth_token_invalid"));
        }
        Ok(token)
    }
    pub(super) fn text(&self, field: &str) -> Option<&str> {
        self.0[field].as_str().filter(|v| !v.is_empty())
    }
    pub(super) fn account(&self) -> Option<String> {
        self.text("accountId").map(str::to_owned)
    }
    pub(super) fn validate_provider(&self, auth: &str) -> Result<(), ModelError> {
        if let Some(value) = self.0.get("provider") {
            let valid = if auth == "oauth_google" {
                value == "google"
            } else {
                value == "openai" || value == "chatgpt"
            };
            if !valid {
                return Err(ModelError::new("model_oauth_provider_mismatch"));
            }
        }
        Ok(())
    }
    pub(super) fn ensure_ready(&self) -> Result<(), ModelError> {
        if let Some(marker) = self.0.get("peerModelRefresh") {
            let valid = marker["schemaVersion"] == 1
                && marker["authMethod"]
                    .as_str()
                    .is_some_and(|v| provider(v).is_some())
                && marker["phase"] == "in_flight"
                && marker["createdAt"].as_u64().is_some_and(|v| v > 0)
                && marker["attemptId"].as_str().is_some_and(|v| {
                    uuid::Uuid::parse_str(v).is_ok_and(|id| {
                        id.get_version_num() == 4
                            && id.get_variant() == uuid::Variant::RFC4122
                            && id.to_string() == v
                    })
                });
            return Err(ModelError::new(if valid {
                "model_oauth_refresh_pending"
            } else {
                "model_oauth_refresh_state_invalid"
            }));
        }
        Ok(())
    }
    pub(super) fn reservation(
        &self,
        auth: &str,
        now: u64,
    ) -> Result<zeroize::Zeroizing<String>, ModelError> {
        self.ensure_ready()?;
        let mut pending = Self(self.0.clone());
        pending.0["peerModelRefresh"] = json!({"schemaVersion":1,"attemptId":uuid::Uuid::new_v4().to_string(),"authMethod":auth,"phase":"in_flight","createdAt":now});
        pending.serialize()
    }
    pub(super) fn project(&self) -> Option<String> {
        self.text("projectId")
            .or_else(|| self.text("project_id"))
            .map(str::to_owned)
    }
    pub(super) fn current(&self, now: u64) -> bool {
        self.text("access").is_some()
            && self.0["expires"]
                .as_u64()
                .is_some_and(|expires| expires > now.saturating_add(60_000))
    }
    pub(super) fn access(&self) -> Result<Secret, ModelError> {
        Secret::from_string(
            self.text("access")
                .ok_or(ModelError::new("model_oauth_token_invalid"))?
                .into(),
        )
        .map_err(|_| ModelError::new("model_oauth_token_invalid"))
    }
    pub(super) fn refresh_form(
        &self,
        provider: &Value,
    ) -> Result<zeroize::Zeroizing<String>, ModelError> {
        let refresh = self
            .text("refresh")
            .ok_or(ModelError::new("model_oauth_refresh_token_missing"))?;
        let mut form = reqwest::Url::parse("https://unused.invalid").unwrap();
        {
            let mut query = form.query_pairs_mut();
            query
                .append_pair("grant_type", "refresh_token")
                .append_pair("client_id", provider["clientId"].as_str().unwrap())
                .append_pair("refresh_token", refresh);
            if let Some(secret) = provider["clientSecret"].as_str() {
                query.append_pair("client_secret", secret);
            }
        }
        Ok(zeroize::Zeroizing::new(form.query().unwrap().into()))
    }
    pub(super) fn updated(
        &mut self,
        response: &Token,
        auth: &str,
        now: u64,
    ) -> Result<(), ModelError> {
        if response
            .text("token_type")
            .is_some_and(|v| !v.eq_ignore_ascii_case("bearer"))
        {
            return Err(ModelError::new("model_oauth_token_type_unsupported"));
        }
        let access = response
            .text("access_token")
            .ok_or(ModelError::new("model_oauth_refresh_invalid"))?;
        let seconds = match response.0.get("expires_in") {
            None => 3600.,
            Some(Value::Number(v)) => v.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(v)) => v.parse().unwrap_or(f64::NAN),
            _ => f64::NAN,
        };
        if !seconds.is_finite() || seconds <= 0. || seconds > 31_536_000. {
            return Err(ModelError::new("model_oauth_expiry_invalid"));
        }
        let expires = now
            .checked_add((seconds * 1000.).floor() as u64)
            .ok_or(ModelError::new("model_oauth_expiry_invalid"))?;
        if let Some(account) = response.text("account_id") {
            if self.text("accountId").is_some_and(|old| old != account) {
                return Err(ModelError::new("model_oauth_account_changed"));
            }
            self.replace("accountId", json!(account));
        }
        self.replace("access", json!(access));
        if let Some(refresh) = response.text("refresh_token") {
            self.replace("refresh", json!(refresh));
        }
        self.replace("expires", json!(expires));
        if auth == "oauth_google" {
            self.replace("provider", json!("google"));
        }
        Ok(())
    }
    pub(super) fn serialize(&self) -> Result<zeroize::Zeroizing<String>, ModelError> {
        let bytes = zeroize::Zeroizing::new(
            serde_json::to_string(&self.0)
                .map_err(|_| ModelError::new("model_oauth_token_invalid"))?,
        );
        if bytes.len() > 65536 {
            return Err(ModelError::new("model_oauth_token_limit"));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_forms_and_known_fields_match_actual_ts_and_preserve_unknown_token_fields() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-oauth.json"
        ))
        .unwrap();
        for case in data["cases"].as_array().unwrap() {
            let auth = case["authMethod"].as_str().unwrap();
            let mut token = Token::parse(&case["tokens"].to_string()).unwrap();
            token.0["futureOpaque"] = json!({"keep":"uninterpreted"});
            let form = token.refresh_form(provider(auth).unwrap()).unwrap();
            let pairs: serde_json::Map<String, Value> =
                reqwest::Url::parse(&format!("https://unused.invalid/?{}", form.as_str()))
                    .unwrap()
                    .query_pairs()
                    .map(|(k, v)| (k.to_string(), json!(v)))
                    .collect();
            assert_eq!(Value::Object(pairs), case["request"]["form"]);
            token
                .updated(
                    &Token::parse(&case["response"].to_string()).unwrap(),
                    auth,
                    data["now"].as_u64().unwrap(),
                )
                .unwrap();
            for (k, v) in case["expected"].as_object().unwrap() {
                assert_eq!(&token.0[k], v, "{auth} {k}");
            }
            assert_eq!(token.0["futureOpaque"], json!({"keep":"uninterpreted"}));
        }
    }
    #[test]
    fn subscription_requests_catalog_and_typed_context_choices_match_actual_ts() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-oauth.json"
        ))
        .unwrap();
        for case in data["requests"].as_array().unwrap() {
            let i = &case["input"];
            let options = serde_json::from_value(i["options"].clone()).unwrap();
            let input = crate::model::wire::WireInput {
                model: i["model"].as_str().unwrap(),
                system: i["system"].as_str().unwrap(),
                stable_system: None,
                messages: i["messages"].as_array().unwrap(),
                tools: i["tools"].as_array().map(Vec::as_slice),
                options: &options,
            };
            assert_eq!(
                crate::model::wire::encode_runtime(crate::model::wire::Wire::Responses, &input)
                    .unwrap(),
                case["expected"]["body"],
                "{}",
                case["effort"]
            );
        }
        for case in data["contextCases"].as_array().unwrap() {
            assert_eq!(
                context_window(
                    "oauth_chatgpt",
                    case["model"].as_str().unwrap(),
                    &case["values"]
                )
                .unwrap(),
                case["expected"].as_u64()
            );
        }
        for rejected in ["gpt-4o", "unknown", "gpt-5.5"] {
            assert!(context_window("oauth_chatgpt", rejected, &json!({})).is_err());
        }
        let values: Value = serde_json::from_str("{\"contextTier\":1e6}").unwrap();
        assert_eq!(
            context_window(
                "oauth_chatgpt",
                data["contextCases"][0]["model"].as_str().unwrap(),
                &values
            )
            .unwrap(),
            Some(1_000_000)
        );
    }
}
