use serde::Serialize;
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
