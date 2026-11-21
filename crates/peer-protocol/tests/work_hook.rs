use peer_protocol::{WORK_HOOK_SEMANTIC_FLOOR, native_work_has_hook_facts};
use serde_json::Value;

#[test]
fn delegated_hook_facts_match_typescript_and_keep_the_original_work() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/work-hook.json"
    ))
    .unwrap();
    assert_eq!(fixture["semanticFloor"], WORK_HOOK_SEMANTIC_FLOOR);
    for case in fixture["cases"].as_array().unwrap() {
        let before = case["work"].clone();
        let actual = native_work_has_hook_facts(&case["work"]);
        let expected = case["expected"]
            .as_bool()
            .ok_or("native_work_hooks_invalid");
        assert_eq!(actual, expected, "{}", case["name"]);
        assert_eq!(case["work"], before, "{}", case["name"]);
    }
}
