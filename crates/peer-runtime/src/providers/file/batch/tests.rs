use super::*;
fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../../packages/protocol/contracts/native-cli/batch-search.json"
    ))
    .unwrap()
}
#[test]
fn original_lane_validation_and_cap_before_dedupe_semantics_match() {
    let c = contract();
    assert_eq!(c["native"]["workers"], WORKERS);
    assert_eq!(c["native"]["resultBytes"], RESULT_BYTES);
    for case in c["cases"].as_array().unwrap() {
        let actual = lanes(&case["input"]);
        if case["output"].is_null() {
            assert_eq!(actual.err().unwrap().0, case["error"].as_str().unwrap());
        } else {
            let actual = actual.unwrap();
            let expected = case["output"]["lanes"].as_array().unwrap();
            assert_eq!(actual.len(), expected.len());
            for (a, b) in actual.iter().zip(expected) {
                assert_eq!(a.id, b["id"]);
                assert_eq!(a.label, b["label"]);
                assert_eq!(a.args["query"], b["query"]);
            }
            assert_eq!(concurrency(&case["input"]), case["output"]["concurrency"]);
        }
    }
    let lanes = vec![
        json!({"id":"first","matches":(0..500).map(|i|json!({"path":format!("z-{i}"),"line":1,"text":"x"})).collect::<Vec<_>>()}),
        json!({"id":"later","matches":[{"path":"z-0","line":1,"text":"x"},{"path":"a","line":1,"text":"x"}]}),
    ];
    let (matches, truncated) = aggregate(&lanes, true).unwrap();
    assert_eq!(matches.len(), 500);
    assert_eq!(truncated, c["cap"]["truncated"]);
    assert_eq!(matches[0], c["cap"]["first"]);
    assert_eq!(matches.last().unwrap(), &c["cap"]["last"]);
}
#[test]
fn aggregate_resource_pressure_is_explicit_instead_of_partial_success() {
    let v = json!({"id":"lane","label":"large","query":"q","status":"completed","matchCount":500,"truncated":false,"matches":(0..500).map(|i|json!({"path":"x","line":i+1,"text":"x".repeat(10000)})).collect::<Vec<_>>()});
    assert_eq!(
        output(&[v], 4, true).unwrap_err(),
        HostError("batch_result_limit")
    );
}
