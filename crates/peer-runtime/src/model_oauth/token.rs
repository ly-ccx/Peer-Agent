use super::*;
pub(crate) struct Token(Value);
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
    pub(crate) fn parse(raw: &str) -> Result<Self, ModelError> {
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
    pub(crate) fn text(&self, field: &str) -> Option<&str> {
        self.0[field].as_str().filter(|v| !v.is_empty())
    }
    pub(crate) fn has(&self, field: &str) -> bool {
        self.0.get(field).is_some()
    }
    pub(crate) fn number(&self, field: &str) -> Option<u64> {
        self.0[field].as_u64()
    }
    pub(super) fn account(&self) -> Option<String> {
        self.text("accountId").map(str::to_owned)
    }
    pub(crate) fn validate_provider(&self, auth: &str) -> Result<(), ModelError> {
        if let Some(value) = self.0.get("provider") {
            let valid = match auth {
                "oauth_google" => value == "google",
                "oauth_grok" => value == "grok",
                _ => value == "openai" || value == "chatgpt",
            };
            if !valid {
                return Err(ModelError::new("model_oauth_provider_mismatch"));
            }
        }
        if auth == "oauth_grok" {
            let descriptor = provider(auth).unwrap();
            for (field, expected) in [
                ("issuer", descriptor["issuer"].as_str().unwrap()),
                ("clientId", descriptor["clientId"].as_str().unwrap()),
            ] {
                if self
                    .0
                    .get(field)
                    .is_some_and(|v| v.as_str() != Some(expected))
                {
                    return Err(ModelError::new("model_oauth_provider_mismatch"));
                }
            }
            if !self
                .text("scope")
                .is_some_and(|s| s.split_whitespace().any(|s| s == "api:access"))
            {
                return Err(ModelError::new("grok_oauth_scope_upgrade_required"));
            }
        }
        Ok(())
    }
    pub(crate) fn ensure_ready(&self) -> Result<(), ModelError> {
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
    pub(crate) fn current(&self, now: u64) -> bool {
        self.text("access").is_some()
            && self.0["expires"]
                .as_u64()
                .is_some_and(|expires| expires > now.saturating_add(60_000))
    }
    pub(crate) fn expires(&self) -> Option<u64> {
        self.0["expires"].as_u64()
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
        if response.0.get("token_type").is_some_and(|value| {
            !value
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case("bearer"))
        }) {
            return Err(ModelError::new("model_oauth_token_type_unsupported"));
        }
        let access = response
            .text("access_token")
            .ok_or(ModelError::new("model_oauth_refresh_invalid"))?;
        if access.trim().is_empty()
            || reqwest::header::HeaderValue::from_str(&format!("Bearer {access}")).is_err()
        {
            return Err(ModelError::new("model_oauth_refresh_invalid"));
        }
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
        if auth == "oauth_grok" {
            if response
                .0
                .get("scope")
                .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
            {
                return Err(ModelError::new("grok_oauth_scope_upgrade_required"));
            }
            if let Some(scope) = response.text("scope") {
                if let Some(old) = self.text("scope") {
                    let old: std::collections::BTreeSet<_> = old.split_whitespace().collect();
                    let next: std::collections::BTreeSet<_> = scope.split_whitespace().collect();
                    if old != next {
                        return Err(ModelError::new("model_oauth_scope_changed"));
                    }
                }
                self.replace("scope", json!(scope));
            }
            self.replace("issuer", provider(auth).unwrap()["issuer"].clone());
            self.replace("clientId", provider(auth).unwrap()["clientId"].clone());
            self.replace("provider", json!("grok"));
            self.validate_provider(auth)?;
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
    pub(crate) fn with_profile(&mut self, profile: &Token) {
        for (source, target) in [("email", "email"), ("sub", "userId")] {
            if let Some(text) = profile
                .text(source)
                .filter(|s| s.len() <= 512 && !s.chars().any(char::is_control))
            {
                self.replace(target, json!(text));
            }
        }
    }
    pub(crate) fn serialize(&self) -> Result<zeroize::Zeroizing<String>, ModelError> {
        let bytes = zeroize::Zeroizing::new(
            serde_json::to_string(&self.0)
                .map_err(|_| ModelError::new("model_oauth_token_invalid"))?,
        );
        if bytes.len() > 65536 {
            return Err(ModelError::new("model_oauth_token_limit"));
        }
        Ok(bytes)
    }
    pub(crate) fn login(response: &Token, auth: &str, now: u64) -> Result<Self, ModelError> {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        let mut token = Self(json!({}));
        if auth == "oauth_grok" && response.0.get("scope").is_none() {
            token.replace("scope", provider(auth).unwrap()["login"]["scope"].clone());
        }
        token.updated(response, auth, now)?;
        if token.account().is_none()
            && let Some(payload) = response.text("id_token").and_then(|s| s.split('.').nth(1))
        {
            if payload.len() > 22000 {
                return Err(ModelError::new("model_oauth_identity_limit"));
            }
            if let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload) {
                let bytes = zeroize::Zeroizing::new(bytes);
                if let Ok(raw) = std::str::from_utf8(&bytes)
                    && let Ok(claims) = Token::parse(raw)
                {
                    let account = if auth == "oauth_google" {
                        claims.text("email").or_else(|| claims.text("sub"))
                    } else {
                        claims.0["https://api.openai.com/auth"]["chatgpt_account_id"]
                            .as_str()
                            .or_else(|| {
                                claims.0["https://api.openai.com/auth"]["organization_id"].as_str()
                            })
                    };
                    if let Some(account) = account.filter(|s| !s.is_empty()) {
                        token.replace("accountId", json!(account));
                    }
                }
            }
        }
        if auth == "oauth_chatgpt" && token.account().is_none() {
            return Err(ModelError::new("model_oauth_account_required"));
        }
        if let Some(account) = token.account()
            && (account.len() > 512 || reqwest::header::HeaderValue::from_str(&account).is_err())
        {
            return Err(ModelError::new("model_oauth_account_invalid"));
        }
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_explicit_token_type_or_header_value_cannot_be_committed_as_login() {
        for token_type in [
            json!(null),
            json!(false),
            json!(7),
            json!({}),
            json!([]),
            json!(""),
        ] {
            let response=Token::parse(&json!({"access_token":"valid","expires_in":3600,"account_id":"account","token_type":token_type}).to_string()).unwrap();
            assert_eq!(
                Token::login(&response, "oauth_chatgpt", 1)
                    .err()
                    .unwrap()
                    .code,
                "model_oauth_token_type_unsupported"
            );
        }
        for access in [" ", "bad\r\nheader"] {
            let response=Token::parse(&json!({"access_token":access,"expires_in":3600,"account_id":"account","token_type":"Bearer"}).to_string()).unwrap();
            assert!(Token::login(&response, "oauth_chatgpt", 1).is_err());
        }
    }
    #[test]
    fn native_login_tokens_match_the_actual_ts_browser_exchange_flows() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-oauth.json"
        ))
        .unwrap();
        for case in data["loginCases"].as_array().unwrap() {
            let response = Token::parse(&case["response"].to_string()).unwrap();
            let token = Token::login(
                &response,
                case["authMethod"].as_str().unwrap(),
                data["now"].as_u64().unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&token.serialize().unwrap()).unwrap(),
                case["expected"]
            );
        }
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(
                b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            )),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
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
