use peer_protocol::normalize_conversation_execution;
use serde_json::Value;
#[test]
fn ordinary_identity_lifecycle_and_unknown_schema_match_the_actual_typescript_decoder() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/conversation-execution.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let result = normalize_conversation_execution(&case["input"]);
        assert_eq!(
            result.is_ok(),
            case["valid"] == true,
            "{}: {result:?}",
            case["name"]
        );
        if let Ok(run) = result {
            assert_eq!(
                run.permits_new_run(),
                case["permits"] == true,
                "{}",
                case["name"]
            );
        }
    }
}
