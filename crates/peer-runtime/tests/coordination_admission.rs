use peer_runtime::coordination::{
    HistoryRecoveryFacts, history_checkpoint_bindings, plan_history_resumption,
};
use peer_runtime::coordination::{
    admit_coordination_decision, admit_intent_assessment, admit_intent_closure,
};
use serde_json::Value;
struct Facts<'a>(&'a Value);
impl HistoryRecoveryFacts for Facts<'_> {
    fn checkpoint(
        &self,
        _work: &str,
        reference: Option<&str>,
    ) -> Result<Option<Value>, &'static str> {
        Ok(reference
            .and_then(|r| self.0["checkpoints"].get(r))
            .cloned())
    }
    fn session_safe(&self, id: &str) -> bool {
        self.0["safeSessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == id)
    }
}
#[test]
fn resumption_plans_match_actual_ts_without_asserting_checkpoint_compatibility() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/history-resumption.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let result = plan_history_resumption(&case["state"], &case["inspection"], &Facts(case));
        if let Some(expected) = case["error"].as_str() {
            assert_eq!(result.unwrap_err(), expected, "{}", case["name"]);
        } else {
            assert_eq!(
                serde_json::to_value(result.unwrap()).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
        }
        assert_eq!(
            serde_json::to_value(
                history_checkpoint_bindings(&case["state"]["works"]["work"]).unwrap()
            )
            .unwrap(),
            case["bindings"],
            "{}",
            case["name"]
        );
    }
}
#[test]
fn pure_admission_matches_actual_ts_contracts() {
    let kernels: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/coordination-kernels.json"
    ))
    .unwrap();
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/coordination-admissions.json"
    ))
    .unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let state = &kernels["cases"][case["stateCase"].as_u64().unwrap() as usize]["previous"];
        let result = match case["method"].as_str().unwrap() {
            "decision" => admit_coordination_decision(state, &case["input"], &case["host"]),
            "assessment" => admit_intent_assessment(state, &case["input"], &case["host"]),
            "closure" => admit_intent_closure(state, &case["input"], &case["host"]),
            _ => panic!("unknown fixture"),
        };
        assert_eq!(
            peer_protocol::javascript_json_string(&result).unwrap(),
            peer_protocol::javascript_json_string(&case["expected"]).unwrap(),
            "{}",
            case["name"]
        );
    }
}
