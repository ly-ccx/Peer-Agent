use peer_protocol::{
    EvidenceRefError, JsonDecodeError, JsonLimits, PermissionOperation, collect_tool_evidence_refs,
    decode_json_bounded, normalize_execution_resource_scope, normalize_session_execution_identity,
    permission_operation_key,
};
use serde_json::{Value, json};

fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/runtime-v1.json"
    ))
    .unwrap()
}
#[test]
fn identity_and_resource_shapes_match_real_typescript_normalizers() {
    let contract = contract();
    for case in contract["identityCases"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(normalize_session_execution_identity(&case["input"])).unwrap(),
            case["expected"]
        );
    }
    for case in contract["resourceScopeCases"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(normalize_execution_resource_scope(&case["input"])).unwrap(),
            case["expected"]
        );
    }
}
#[test]
fn operation_identity_and_evidence_refs_match_real_typescript_modules() {
    let contract = contract();
    for case in contract["operationCases"].as_array().unwrap() {
        let input = &case["input"];
        assert_eq!(
            permission_operation_key(PermissionOperation {
                capability_id: input["capabilityId"].as_str().unwrap(),
                args: &input["args"],
                conversation_id: input["conversationId"].as_str(),
                workspace_path: input["workspacePath"].as_str(),
                session_id: input["sessionId"].as_str(),
                plan_id: input["planId"].as_str()
            })
            .unwrap(),
            case["expected"]
        );
    }
    for case in contract["evidenceCases"].as_array().unwrap() {
        let input = &case["input"];
        assert_eq!(
            json!(
                collect_tool_evidence_refs(input["toolCallId"].as_str(), &input["execution"])
                    .unwrap()
            ),
            case["expected"]
        );
    }
}
#[test]
fn ref_pressure_and_unrepresentable_unicode_fail_without_partial_facts() {
    assert_eq!(
        collect_tool_evidence_refs(
            None,
            &json!({"result":{"evidence":{"refs":["x".repeat(8193)]}}})
        ),
        Err(EvidenceRefError::LimitExceeded)
    );
    let refs: Vec<_> = (0..1025).map(|n| format!("artifact://{n}")).collect();
    assert_eq!(
        collect_tool_evidence_refs(None, &json!({"result":{"evidence":{"refs":refs}}})),
        Err(EvidenceRefError::LimitExceeded)
    );
    assert!(matches!(
        decode_json_bounded(
            br#"{"epoch":"\ud800"}"#,
            JsonLimits {
                bytes: 8192,
                nodes: 128,
                depth: 16,
                string_bytes: 8192
            }
        ),
        Err(JsonDecodeError::InvalidJson)
    ));
}
