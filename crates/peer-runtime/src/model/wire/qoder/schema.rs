use super::*;
fn schema(value: &Value, depth: usize) -> Value {
    if !value.is_object() {
        return json!({"type":"object"});
    }
    if depth > 8 {
        return json!({"type":"string"});
    }
    if value["type"].is_null() {
        let variant = ["oneOf", "anyOf", "allOf"]
            .iter()
            .find_map(|key| value[*key].as_array().and_then(|a| a.first()))
            .filter(|v| v.is_object());
        if let Some(variant) = variant {
            let mut merged = variant.clone();
            if let Some(description) = value.get("description").filter(|v| !v.is_null()) {
                merged["description"] = description.clone();
            }
            return schema(&merged, depth + 1);
        }
    }
    let kind = value["type"]
        .as_str()
        .or_else(|| {
            value["type"]
                .as_array()
                .and_then(|a| a.iter().filter_map(Value::as_str).find(|s| *s != "null"))
        })
        .unwrap_or(if value.get("properties").is_some_and(|v| !v.is_null()) {
            "object"
        } else if value.get("items").is_some_and(|v| !v.is_null()) {
            "array"
        } else {
            "string"
        });
    let mut out = json!({"type":kind});
    if let Some(d) = value["description"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        out["description"] = json!(d);
    }
    if let Some(values) = value["enum"].as_array() {
        let values: Vec<_> = values
            .iter()
            .filter(|v| match kind {
                "integer" => v.as_f64().is_some_and(|n| n.fract() == 0.0),
                "number" => v.is_number(),
                "boolean" => v.is_boolean(),
                _ => v.is_string(),
            })
            .cloned()
            .collect();
        if !values.is_empty() {
            out["enum"] = json!(values);
        }
    }
    if kind == "object" {
        let mut properties = serde_json::Map::new();
        for (key, value) in value["properties"].as_object().into_iter().flatten() {
            if !key.is_empty()
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            {
                properties.insert(key.clone(), schema(value, depth + 1));
            }
        }
        let required: Vec<_> = value["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v.as_str().is_some_and(|s| properties.contains_key(s)))
            .cloned()
            .collect();
        out["properties"] = json!(properties);
        if !required.is_empty() {
            out["required"] = json!(required);
        }
        out["additionalProperties"] = json!(value["additionalProperties"] == true);
    }
    if kind == "array" {
        out["items"] = schema(
            value.get("items").unwrap_or(&json!({"type":"string"})),
            depth + 1,
        );
    }
    out
}
pub(super) fn tools(tools: Option<&[Value]>) -> Vec<Value> {
    tools.into_iter().flatten().filter_map(|tool|{
        let function=tool.get("function").filter(|v|v.is_object()).unwrap_or(tool);
        let name=function["name"].as_str()?.trim();if name.is_empty(){return None;}
        let mut f=json!({"name":name,"parameters":schema(function.get("parameters").or_else(||function.get("input_schema")).unwrap_or(&json!({"type":"object"})),0)});
        if let Some(description)=function["description"].as_str(){f["description"]=json!(description);}
        Some(json!({"type":"function","function":f}))
    }).collect()
}
