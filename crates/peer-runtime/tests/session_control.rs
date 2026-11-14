use peer_protocol::javascript_json_digest;
use peer_runtime::session_control::{ControlError, reduce_session_control};
use serde_json::{Value, json};

#[test]
fn control_replay_matches_real_typescript_and_failures_preserve_state() {
    let contract: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/control-v1.json"
    ))
    .unwrap();
    for case in contract["digestCases"].as_array().unwrap() {
        assert_eq!(
            javascript_json_digest(&case["input"]).unwrap(),
            case["expected"]
        );
    }
    for case in contract["cases"].as_array().unwrap() {
        let state = &case["state"];
        let before = state.clone();
        let actual = match reduce_session_control(state, &case["entry"]) {
            Ok(state) => json!({"ok":true,"state":state}),
            Err(error) => json!({"ok":false,"code":error.code()}),
        };
        assert_eq!(actual, case["expected"], "case {}", case["name"]);
        assert_eq!(
            state, &before,
            "rejected transition must not alter source facts"
        );
    }
}

#[test]
fn excessive_control_projection_is_blocked_without_erasing_history() {
    let state =
        json!({"sessionControls":{},"sessionControlHeads":{},"history":"x".repeat(4*1024*1024+1)});
    assert_eq!(
        reduce_session_control(&state, &json!({})),
        Err(ControlError::ResourceLimit)
    );
    assert_eq!(
        state["history"].as_str().unwrap().len(),
        4 * 1024 * 1024 + 1
    );
}

#[test]
fn json_integer_spelling_does_not_change_an_immutable_host_pid() {
    let contract: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/control-v1.json"
    ))
    .unwrap();
    let case = contract["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "draining")
        .unwrap();
    let mut state = case["state"].clone();
    state["sessionControls"]["a"]["hostPid"] = Value::from(101.0);
    assert_eq!(
        reduce_session_control(&state, &case["entry"]).unwrap(),
        case["expected"]["state"]
    );
}
