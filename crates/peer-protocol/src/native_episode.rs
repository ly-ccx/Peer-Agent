use crate::{
    SessionExecutionIdentity, javascript_json_string, normalize_session_execution_identity,
};
use serde_json::Value;
/// Shape admission only. OS observations and canonical provenance belong to Host.
pub fn normalize_native_episode_recorder(
    v: &Value,
    execution: &SessionExecutionIdentity,
) -> Option<Value> {
    javascript_json_string(v).ok()?;
    if v["schemaVersion"] != 1
        || v["runtime"] != "peer-native"
        || normalize_session_execution_identity(&v["execution"]).as_ref() != Some(execution)
    {
        return None;
    }
    let recorder = &v["recorder"];
    if recorder["pid"]
        .as_u64()
        .is_none_or(|p| p == 0 || p > i32::MAX as u64)
        || ["bootId", "pidStart", "hostId", "acquiredAt"]
            .iter()
            .any(|k| {
                recorder[k]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 8192)
            })
    {
        return None;
    }
    Some(v.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn recorder_shape_binds_original_execution_and_rejects_incomplete_or_future_contracts() {
        let execution = normalize_session_execution_identity(
            &json!({"planId":"p","sessionId":"s","executionEpoch":"e"}),
        )
        .unwrap();
        let source = json!({"schemaVersion":1,"runtime":"peer-native","execution":execution,"recorder":{"bootId":"boot","pid":10,"pidStart":"start","hostId":"host","acquiredAt":"2026-11-14T04:00:00.000Z"},"future":{"keep":true}});
        assert_eq!(
            normalize_native_episode_recorder(&source, &execution),
            Some(source.clone())
        );
        for (key, value) in [
            ("runtime", json!("node")),
            ("schemaVersion", json!(2)),
            (
                "execution",
                json!({"planId":"other","sessionId":"s","executionEpoch":"e"}),
            ),
            ("recorder", json!({"pid":10})),
        ] {
            let mut invalid = source.clone();
            invalid[key] = value;
            assert!(normalize_native_episode_recorder(&invalid, &execution).is_none());
        }
    }
}
