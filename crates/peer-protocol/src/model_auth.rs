use serde::Serialize;
/// Human-facing account-management facts; never contains a device code or token.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAuthorizationPrompt {
    pub authorization_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelMetadataState {
    Synced,
    RebuildRequired,
    CommitUnknown,
}
pub fn model_oauth_hint_fields() -> &'static [String] {
    static FIELDS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    FIELDS.get_or_init(|| {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-binding.json"
        ))
        .expect("verified model binding contract");
        data["hintFields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    })
}
pub fn model_config_binding(value: &serde_json::Value) -> Result<String, crate::DigestError> {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        for field in model_oauth_hint_fields() {
            object.remove(field);
        }
    }
    crate::javascript_json_string(&value)
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelAccountState {
    NotLoggedIn,
    Authenticated,
    RefreshRequired,
    RecoveryRequired,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAccountStatus {
    pub channel_id: String,
    pub auth_method: String,
    pub status: ModelAccountState,
    pub expires: Option<u64>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operational_bindings_match_actual_typescript_serialization() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-binding.json"
        ))
        .unwrap();
        for case in data["cases"].as_array().unwrap() {
            assert_eq!(
                model_config_binding(&case["value"]).unwrap(),
                case["expected"].as_str().unwrap()
            );
        }
    }
    #[test]
    fn browser_and_device_prompts_match_the_machine_output_contract_without_secret_fields() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-oauth.json"
        ))
        .unwrap();
        let examples = [
            ModelAuthorizationPrompt {
                authorization_url: "https://auth.example/authorize".into(),
                user_code: None,
                expires_at: None,
            },
            ModelAuthorizationPrompt {
                authorization_url: "https://auth.x.ai/activate".into(),
                user_code: Some("TEST-CODE".into()),
                expires_at: Some("2026-11-17T00:15:00Z".into()),
            },
        ];
        assert_eq!(
            serde_json::to_value(examples).unwrap(),
            data["authorizationPrompts"]
        );
    }
    #[test]
    fn account_states_match_the_language_neutral_contract() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-oauth.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value([
                ModelAccountState::NotLoggedIn,
                ModelAccountState::Authenticated,
                ModelAccountState::RefreshRequired,
                ModelAccountState::RecoveryRequired
            ])
            .unwrap(),
            data["accountStates"]
        );
    }
}
