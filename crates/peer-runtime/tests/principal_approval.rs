use peer_runtime::{
    one_time_approval::{ApprovalBinding, ApprovalBookError, OneTimeApprovalBook},
    principal::{
        HostDelegationPrincipalFacts, HostPlanPrincipalFacts, PrincipalError, PrincipalFactsSource,
        PrincipalQuery, resolve_permission_principal,
    },
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/runtime-v1.json"
    ))
    .unwrap()
}
struct HostSource(BTreeMap<String, HostPlanPrincipalFacts>);
impl PrincipalFactsSource for HostSource {
    fn plan(&self, id: &str) -> Result<Option<&HostPlanPrincipalFacts>, PrincipalError> {
        Ok(self.0.get(id))
    }
    fn active_plan_by_conversation(
        &self,
        id: &str,
    ) -> Result<Option<&HostPlanPrincipalFacts>, PrincipalError> {
        Ok(self.0.values().find(|p| p.conversation_id == id))
    }
}
#[test]
fn principal_resolution_matches_real_typescript_over_host_plan_facts() {
    for case in contract()["principalCases"].as_array().unwrap() {
        let source = HostSource(
            case["hostFacts"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(id, fact)| {
                    (
                        id.clone(),
                        HostPlanPrincipalFacts {
                            conversation_id: fact["conversationId"].as_str().unwrap().to_owned(),
                            inheritance_stopped: fact["inheritanceStopped"].as_bool().unwrap(),
                            delegation: fact["delegation"].as_object().map(|d| {
                                HostDelegationPrincipalFacts {
                                    workspace_id: d["workspaceId"].as_str().unwrap().to_owned(),
                                    session_id: d["sessionId"].as_str().unwrap().to_owned(),
                                    parent_conversation_id: d["parentConversationId"]
                                        .as_str()
                                        .map(str::to_owned),
                                }
                            }),
                        },
                    )
                })
                .collect(),
        );
        let input = &case["query"];
        let result = resolve_permission_principal(
            PrincipalQuery {
                workspace_id: input["workspaceId"].as_str(),
                conversation_id: input["conversationId"].as_str(),
                plan_id: input["planId"].as_str(),
                session_id: input["sessionId"].as_str(),
            },
            &source,
        )
        .unwrap();
        let result = result
            .map(|p| json!({"workspaceId":p.workspace_id,"conversationId":p.conversation_id}))
            .unwrap_or(Value::Null);
        assert_eq!(result, case["expected"]);
    }
}
#[test]
fn missing_canonical_source_never_falls_back_to_claimed_ancestry() {
    struct Unavailable;
    impl PrincipalFactsSource for Unavailable {
        fn plan(&self, _: &str) -> Result<Option<&HostPlanPrincipalFacts>, PrincipalError> {
            Err(PrincipalError::FactsUnavailable)
        }
        fn active_plan_by_conversation(
            &self,
            _: &str,
        ) -> Result<Option<&HostPlanPrincipalFacts>, PrincipalError> {
            Err(PrincipalError::FactsUnavailable)
        }
    }
    assert_eq!(
        resolve_permission_principal(
            PrincipalQuery {
                workspace_id: Some("w"),
                conversation_id: Some("worker"),
                plan_id: Some("p"),
                session_id: Some("s")
            },
            &Unavailable
        ),
        Err(PrincipalError::FactsUnavailable)
    );
}
fn binding(input: &Value) -> Result<ApprovalBinding, ApprovalBookError> {
    ApprovalBinding::new(
        input["capabilityId"].as_str().unwrap_or(""),
        input["argsDigest"].as_str().unwrap_or(""),
        input["sessionId"].as_str(),
        input["workspaceId"].as_str(),
        input["policyRevision"].as_str(),
    )
}
#[test]
fn exact_one_use_expiry_and_policy_revision_match_real_typescript_book() {
    let mut book = OneTimeApprovalBook::default();
    for step in contract()["approvalSteps"].as_array().unwrap() {
        let input = &step["input"];
        let at = input["at"].as_i64().unwrap();
        let result = if step["op"] == "remember" {
            binding(input)
                .and_then(|key| book.remember(key, at))
                .map(|r| serde_json::to_value(r).unwrap())
                .unwrap_or(Value::Null)
        } else {
            json!(binding(input).is_ok_and(|key| book.consume(&key, at)))
        };
        assert_eq!(result, step["expected"]);
    }
}
fn key(session: &str, workspace: &str) -> ApprovalBinding {
    ApprovalBinding::new(
        "local.file.read",
        &"a".repeat(64),
        Some(session),
        Some(workspace),
        Some("bot:w:bot:1"),
    )
    .unwrap()
}
#[test]
fn approval_scope_is_structured_and_budget_recovers_after_consumption_or_expiry() {
    let mut book = OneTimeApprovalBook::default();
    let first = key("a::b", "c");
    book.remember(first.clone(), 0).unwrap();
    assert!(!book.consume(&key("a", "b::c"), 1));
    assert!(book.consume(&first, 1));
    assert!(!book.consume(&first, 1));
    for n in 0..1024 {
        book.remember(key(&format!("s-{n}"), "w"), 0).unwrap();
    }
    assert!(matches!(
        book.remember(key("overflow", "w"), 1),
        Err(ApprovalBookError::LimitExceeded)
    ));
    assert!(book.consume(&key("s-0", "w"), 1));
    book.remember(key("after-consume", "w"), 1).unwrap();
    book.remember(key("after-expiry", "w"), 1_800_001).unwrap();
    assert!(!book.consume(&key("after-consume", "w"), 1_800_001));
    assert!(book.consume(&key("after-expiry", "w"), 1_800_002));
    let mut book = OneTimeApprovalBook::default();
    let prefix = "w".repeat(500);
    let session = "s".repeat(512);
    let mut admitted = 0;
    for n in 0..1024 {
        match book.remember(key(&session, &format!("{prefix}{n}")), 0) {
            Ok(_) => admitted += 1,
            Err(ApprovalBookError::LimitExceeded) => break,
            Err(e) => panic!("unexpected {e:?}"),
        }
    }
    assert!(
        admitted > 0 && admitted < 1024,
        "byte budget bounds the book before the entry budget"
    );
}
