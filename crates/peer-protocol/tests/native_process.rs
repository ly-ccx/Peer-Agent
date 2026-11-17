use peer_protocol::native_processes_in_work;
use serde_json::Value;

#[test]
fn canonical_native_child_shapes_match_the_actual_typescript_guard() {
    let contract: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/native-process.json"
    ))
    .unwrap();
    assert_eq!(contract["semanticFloor"], 13);
    for case in contract["cases"].as_array().unwrap() {
        let before = case["input"].clone();
        let result = native_processes_in_work(&case["input"]);
        if case["expected"]["ok"] == true {
            assert_eq!(
                result.unwrap().len() as u64,
                case["expected"]["count"],
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(
                result.unwrap_err(),
                case["expected"]["code"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        assert_eq!(before, case["input"], "validation mutated original facts");
    }
}
