use serde_json::{Value, json};
pub(super) fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(super) fn num(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n))
        .map(|n| n as u64)
}
pub(super) fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(super) fn contains(v: &Value, item: &Value) -> bool {
    list(v).contains(item)
}
pub(super) fn merge(base: &Value, patch: &Value) -> Value {
    let mut out = if base.is_object() {
        base.clone()
    } else {
        json!({})
    };
    if let Some(fields) = patch.as_object() {
        for (k, v) in fields {
            out[k] = v.clone()
        }
    }
    out
}
pub(super) fn remove(v: &mut Value, key: &str) {
    if let Some(m) = v.as_object_mut() {
        m.shift_remove(key);
    }
}
pub(super) fn text(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| {
        !peer_protocol::javascript_trim(s).is_empty() && s.encode_utf16().count() <= max
    })
}
pub(super) fn sorted_digest(v: &Value) -> Result<String, &'static str> {
    peer_protocol::javascript_json_string(v).map_err(|_| "coordination_state_limit")?;
    fn sort(v: &Value) -> Value {
        match v {
            Value::Object(fields) => {
                let mut entries: Vec<_> = fields.iter().collect();
                entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                let mut m = serde_json::Map::new();
                for (k, v) in entries {
                    m.insert(k.clone(), sort(v));
                }
                Value::Object(m)
            }
            Value::Array(items) => Value::Array(items.iter().map(sort).collect()),
            _ => v.clone(),
        }
    }
    peer_protocol::javascript_json_digest(&sort(v)).map_err(|_| "coordination_state_limit")
}
pub(super) fn digest_matches(d: &Value, v: &Value) -> bool {
    d.as_str().is_some_and(|d| {
        sorted_digest(v).is_ok_and(|s| s == d)
            || peer_protocol::javascript_json_digest(v).is_ok_and(|s| s == d)
    })
}
pub(super) fn allowed(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str())))
}

pub(super) fn values(v: &Value) -> Vec<&Value> {
    peer_protocol::javascript_object_keys(v)
        .unwrap_or_default()
        .into_iter()
        .map(|key| &v[key])
        .collect()
}
