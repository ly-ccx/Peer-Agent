//! Existing MCP registry -> Manifest adapter. This data cannot grant execution.
use serde_json::{Value, json};
use std::collections::HashSet;
fn text(v: &Value) -> Option<&str> {
    v.as_str()
}
fn nullish<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if a.is_null() { b } else { a }
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn alias(s: &str) -> String {
    s.encode_utf16()
        .map(|c| {
            if c <= 127 && ((c as u8).is_ascii_alphanumeric() || c == 95 || c == 45) {
                char::from(c as u8)
            } else {
                '_'
            }
        })
        .collect()
}
pub struct McpInventory {
    pub server_count: usize,
    pub manifests: Vec<Value>,
}
pub fn project_mcp_inventory(raw: &Value) -> Result<McpInventory, &'static str> {
    let error = "mcp_inventory_invalid";
    let servers = if let Some(rows) = raw.as_array() {
        rows
    } else {
        if raw["version"].as_f64() != Some(1.0) {
            return Err("mcp_inventory_version_unsupported");
        }
        raw["servers"].as_array().ok_or(error)?
    };
    if servers.len() > 128 {
        return Err("mcp_inventory_limit");
    }
    let mut manifests = Vec::new();
    let mut ids = HashSet::new();
    let mut aliases = HashSet::new();
    for server in servers {
        let id = text(nullish(&server["id"], &server["mcpId"]))
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or(error)?;
        if !ids.insert(id) {
            return Err(error);
        }
        let display = text(nullish(&server["displayName"], &server["name"])).unwrap_or(id);
        let transport = match text(&server["transport"]) {
            Some("stdio") => "stdio",
            Some("sse") => "sse",
            None | Some("streamable_http") => "streamable_http",
            _ => return Err("mcp_transport_unsupported"),
        };
        let auth = &server["auth"];
        let mode = text(&auth["mode"])
            .map(crate::javascript_trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("none");
        if !matches!(
            mode,
            "none" | "http_bearer" | "http_header" | "stdio_env" | "oauth2"
        ) {
            return Err("mcp_auth_unsupported");
        }
        let credential = text(&auth["credentialRef"])
            .map(crate::javascript_trim)
            .filter(|s| !s.is_empty());
        if mode != "none" && credential.is_none() {
            return Err(error);
        }
        if mode == "http_header"
            && text(&auth["headerName"])
                .map(crate::javascript_trim)
                .is_none_or(|s| {
                    s.is_empty()
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
                })
        {
            return Err(error);
        }
        if mode == "stdio_env"
            && text(&auth["envName"])
                .map(crate::javascript_trim)
                .is_none_or(|s| {
                    s.is_empty()
                        || !s.bytes().enumerate().all(|(i, b)| {
                            b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit()
                        })
                })
        {
            return Err(error);
        }
        let policy = &server["policy"];
        if server["enabled"] == false
            || policy["trusted"] == false
            || server["health"]["status"] == "failed"
        {
            continue;
        }
        let tools = server["tools"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if tools.len() > 256 {
            return Err("mcp_inventory_limit");
        }
        for tool in tools {
            let tool_name = nullish(&tool["name"], &tool["toolName"]);
            if !truth(tool_name) {
                continue;
            }
            let name = text(tool_name).filter(|s| s.len() <= 200).ok_or(error)?;
            let visible = nullish(&server["toolVisibility"][name], &policy["visibleByDefault"]);
            if !visible.is_null() && !truth(visible) {
                continue;
            }
            let alias = format!("mcp__{}__{}", alias(id), alias(name));
            if !aliases.insert(alias.clone()) {
                return Err("mcp_projection_alias_conflict");
            }
            let required = policy["requirePermission"] != false;
            let description = nullish(&tool["description"], &tool["toolDesc"]);
            let description = if description.is_null() {
                json!(format!("MCP tool {name} from {display}."))
            } else {
                description.clone()
            };
            let schema = if tool["inputSchema"].is_object() || tool["inputSchema"].is_array() {
                tool["inputSchema"].clone()
            } else {
                json!({"type":"object","additionalProperties":true})
            };
            let capability = format!("local.mcp.{id}.{name}");
            manifests.push(json!({"capabilityId":capability,"name":alias,"displayName":format!("{display}: {name}"),"description":description,"source":"mcp","locality":"local","health":if required{"needs_permission"}else{"available"},"providerId":id,"providerLabel":display,"riskLevel":if tool["riskLevel"].is_null(){json!("L3_external_write")}else{tool["riskLevel"].clone()},"dataLevel":if tool["dataLevel"].is_null(){json!("D2_sensitive")}else{tool["dataLevel"].clone()},"inputSchema":schema,"permissionPolicy":{"kind":"mcp-tool","required":required},"runtime":{"executor":"local-tool-host","executorCapabilityId":capability},"origin":{"providerId":id,"transport":transport,"toolName":name,"authMode":mode,"hasCredential":mode!="none" && credential.is_some()}}));
            if manifests.len() > 1024 {
                return Err("mcp_inventory_limit");
            }
        }
    }
    Ok(McpInventory {
        server_count: servers.len(),
        manifests,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_ts_registry_manifests_match_without_transport_or_secrets() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/mcp-inventory.json"
        ))
        .unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let actual = project_mcp_inventory(&case["input"]).unwrap();
            assert_eq!(
                json!(actual.manifests),
                case["expected"],
                "{}",
                case["name"]
            );
        }
        for case in fixtures["rejections"].as_array().unwrap() {
            assert_eq!(
                project_mcp_inventory(&case["input"]).err(),
                case["error"].as_str()
            );
        }
    }
}
