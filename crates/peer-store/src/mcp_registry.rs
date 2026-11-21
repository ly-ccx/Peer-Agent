//! Desktop-compatible MCP server registry CRUD, renderer view projection,
//! and capability manifest synthesis under `DirectoryLock` + `durable_jsonl::replace`.

use crate::{DirectoryLock, McpRegistryStore, StoreError, durable_jsonl as log, files};
use serde_json::{Map, Value, json};
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_REGISTRY_BYTES: usize = 2 * 1024 * 1024;

fn now_iso() -> Result<String, StoreError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| StoreError::InvalidInput)
}

fn as_trimmed_str(value: &Value) -> &str {
    value.as_str().map(str::trim).unwrap_or("")
}

fn sanitize_symbol(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn slugify_mcp_id(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    let truncated: String = trimmed.chars().take(80).collect();
    if truncated.is_empty() {
        let id = uuid::Uuid::new_v4().to_string();
        format!("mcp-{}", &id[..8])
    } else {
        truncated
    }
}

fn is_valid_http_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                        | b'-'
                )
        })
}

fn is_valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

pub fn normalize_auth_binding(auth: &Value) -> Result<Value, StoreError> {
    let mode = auth["mode"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("none");
    if mode == "none" {
        return Ok(json!({ "mode": "none" }));
    }
    if !matches!(mode, "http_bearer" | "http_header" | "stdio_env" | "oauth2") {
        return Err(StoreError::InvalidInput);
    }
    let raw_ref = as_trimmed_str(&auth["credentialRef"]);
    if raw_ref.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    let credential_ref = if raw_ref.starts_with("mcp-cred:") {
        raw_ref.to_owned()
    } else {
        format!("mcp-cred:{raw_ref}")
    };
    let mut out = json!({
        "mode": mode,
        "credentialRef": credential_ref,
    });
    if mode == "http_header" {
        let header_name = as_trimmed_str(&auth["headerName"]);
        if !is_valid_http_header_name(header_name) {
            return Err(StoreError::InvalidInput);
        }
        out["headerName"] = json!(header_name);
    }
    if mode == "stdio_env" {
        let env_name = as_trimmed_str(&auth["envName"]);
        if !is_valid_env_name(env_name) {
            return Err(StoreError::InvalidInput);
        }
        out["envName"] = json!(env_name);
    }
    Ok(out)
}

fn string_record(value: &Value) -> Value {
    let Some(obj) = value.as_object() else {
        return json!({});
    };
    let filtered: Map<String, Value> = obj
        .iter()
        .filter(|(_, v)| v.is_string())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    Value::Object(filtered)
}

fn string_array(value: &Value) -> Value {
    let items: Vec<Value> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v.is_string())
        .cloned()
        .collect();
    Value::Array(items)
}

fn normalize_server(item: &Value, now: &str) -> Result<Value, StoreError> {
    let raw_id = item["id"]
        .as_str()
        .or_else(|| item["mcpId"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let hint = item["displayName"]
                .as_str()
                .or_else(|| item["name"].as_str())
                .or_else(|| item["url"].as_str())
                .or_else(|| item["serverUrl"].as_str())
                .unwrap_or("");
            slugify_mcp_id(hint)
        });
    let transport = match item["transport"].as_str() {
        Some("stdio") => "stdio",
        Some("sse") => "sse",
        _ => "streamable_http",
    };
    let url = item["url"]
        .as_str()
        .or_else(|| item["serverUrl"].as_str())
        .unwrap_or("");
    let display_name = item["displayName"]
        .as_str()
        .or_else(|| item["name"].as_str())
        .unwrap_or(&raw_id);
    let auth = normalize_auth_binding(&item["auth"])?;
    let mut policy = json!({
        "trusted": true,
        "visibleByDefault": true,
        "requirePermission": true,
        "maxRiskLevel": "L4_privileged",
    });
    if let Some(obj) = item["policy"].as_object()
        && let Some(target) = policy.as_object_mut()
    {
        for (k, v) in obj {
            target.insert(k.clone(), v.clone());
        }
    }

    let created_at = item["createdAt"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(now);
    let updated_at = item["updatedAt"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(now);

    Ok(json!({
        "id": raw_id,
        "mcpId": raw_id,
        "displayName": display_name,
        "name": display_name,
        "reportedName": item["reportedName"].as_str().filter(|s| !s.is_empty()).map(str::to_owned),
        "reportedTitle": item["reportedTitle"].as_str().filter(|s| !s.is_empty()).map(str::to_owned),
        "reportedVersion": item["reportedVersion"].as_str().filter(|s| !s.is_empty()).map(str::to_owned),
        "description": item["description"].as_str().unwrap_or(""),
        "enabled": item["enabled"] != false,
        "transport": transport,
        "command": item["command"].as_str().unwrap_or(""),
        "args": string_array(&item["args"]),
        "cwd": item["cwd"].as_str().filter(|s| !s.is_empty()).map(str::to_owned),
        "url": url,
        "serverUrl": url,
        "headers": string_record(&item["headers"]),
        "env": string_record(&item["env"]),
        "envSecretRefs": string_record(&item["envSecretRefs"]),
        "auth": auth,
        "policy": policy,
        "toolVisibility": if item["toolVisibility"].is_object() { item["toolVisibility"].clone() } else { json!({}) },
        "tools": if item["tools"].is_array() { item["tools"].clone() } else { json!([]) },
        "resources": if item["resources"].is_array() { item["resources"].clone() } else { json!([]) },
        "prompts": if item["prompts"].is_array() { item["prompts"].clone() } else { json!([]) },
        "health": if item["health"].is_object() {
            item["health"].clone()
        } else {
            json!({ "status": "unknown", "checkedAt": Value::Null, "message": "" })
        },
        "manifestUpdatedAt": item.get("manifestUpdatedAt").cloned().filter(|v| !v.is_null()).or_else(|| item.get("updatedAt").cloned()).unwrap_or(Value::Null),
        "lastError": item.get("lastError").cloned().unwrap_or(Value::Null),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }))
}

pub fn to_renderer_view(server: &Value) -> Value {
    let id = server["id"]
        .as_str()
        .or_else(|| server["mcpId"].as_str())
        .unwrap_or("");
    let display_name = server["displayName"]
        .as_str()
        .or_else(|| server["name"].as_str())
        .unwrap_or(id);
    let transport = match server["transport"].as_str() {
        Some("stdio") => "stdio",
        Some("sse") => "sse",
        _ => "streamable_http",
    };
    let tools = server["tools"].as_array().cloned().unwrap_or_default();
    let resources = server["resources"].as_array().cloned().unwrap_or_default();
    let prompts = server["prompts"].as_array().cloned().unwrap_or_default();
    let visibility = &server["toolVisibility"];

    let visible_tools_count = tools
        .iter()
        .filter(|tool| {
            let name = tool["name"]
                .as_str()
                .or_else(|| tool["toolName"].as_str())
                .unwrap_or("");
            visibility[name] != false
        })
        .count();

    let command_preview = if transport == "stdio" {
        let mut parts = Vec::new();
        if let Some(cmd) = server["command"].as_str().filter(|s| !s.is_empty()) {
            parts.push(cmd.to_owned());
        }
        if let Some(args) = server["args"].as_array() {
            for arg in args {
                if let Some(s) = arg.as_str().filter(|s| !s.is_empty()) {
                    parts.push(s.to_owned());
                }
            }
        }
        parts.join(" ")
    } else {
        String::new()
    };

    let url_preview = if transport == "streamable_http" {
        server["url"]
            .as_str()
            .or_else(|| server["serverUrl"].as_str())
            .unwrap_or("")
            .to_owned()
    } else {
        String::new()
    };

    let auth_view = if server["auth"]["mode"].as_str().unwrap_or("none") == "none" {
        json!({ "mode": "none" })
    } else {
        let mut out = serde_json::Map::new();
        out.insert("mode".into(), server["auth"]["mode"].clone());
        out.insert(
            "credentialRef".into(),
            server["auth"]["credentialRef"].clone(),
        );
        if let Some(hn) = server["auth"]["headerName"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            out.insert("headerName".into(), json!(hn));
        }
        if let Some(en) = server["auth"]["envName"].as_str().filter(|s| !s.is_empty()) {
            out.insert("envName".into(), json!(en));
        }
        Value::Object(out)
    };

    let projected_tools: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let tname = tool["name"]
                .as_str()
                .or_else(|| tool["toolName"].as_str())
                .unwrap_or("");
            let desc = tool["description"]
                .as_str()
                .or_else(|| tool["toolDesc"].as_str())
                .unwrap_or("");
            let schema = if tool["inputSchema"].is_object() {
                tool["inputSchema"].clone()
            } else {
                json!({})
            };
            json!({
                "name": tname,
                "toolName": tname,
                "description": desc,
                "toolDesc": desc,
                "visible": visibility[tname] != false,
                "inputSchema": schema,
            })
        })
        .collect();

    let projected_resources: Vec<Value> = resources
        .iter()
        .map(|r| {
            let uri = r["uri"].as_str().unwrap_or("");
            json!({
                "uri": uri,
                "name": r["name"].as_str().unwrap_or(uri),
                "description": r["description"].as_str().unwrap_or(""),
                "mimeType": r["mimeType"].as_str().unwrap_or(""),
            })
        })
        .collect();

    let projected_prompts: Vec<Value> = prompts
        .iter()
        .map(|p| {
            json!({
                "name": p["name"].as_str().unwrap_or(""),
                "description": p["description"].as_str().unwrap_or(""),
                "arguments": if p["arguments"].is_array() { p["arguments"].clone() } else { json!([]) },
            })
        })
        .collect();

    json!({
        "id": id,
        "mcpId": id,
        "displayName": display_name,
        "name": display_name,
        "reportedName": server.get("reportedName").cloned().unwrap_or(Value::Null),
        "reportedTitle": server.get("reportedTitle").cloned().unwrap_or(Value::Null),
        "reportedVersion": server.get("reportedVersion").cloned().unwrap_or(Value::Null),
        "description": server["description"].as_str().unwrap_or(""),
        "enabled": server["enabled"] != false,
        "transport": transport,
        "commandPreview": command_preview,
        "urlPreview": url_preview,
        "serverUrl": url_preview,
        "auth": auth_view,
        "toolsCount": tools.len(),
        "visibleToolsCount": visible_tools_count,
        "resourcesCount": projected_resources.len(),
        "promptsCount": projected_prompts.len(),
        "tools": projected_tools,
        "resources": projected_resources,
        "prompts": projected_prompts,
        "health": if server["health"].is_object() {
            server["health"].clone()
        } else {
            json!({ "status": "unknown", "checkedAt": Value::Null, "message": "" })
        },
        "manifestUpdatedAt": server.get("manifestUpdatedAt").cloned().unwrap_or(Value::Null),
        "lastError": server.get("lastError").cloned().unwrap_or(Value::Null),
        "policy": {
            "trusted": server["policy"]["trusted"] != false,
            "requirePermission": server["policy"]["requirePermission"] != false,
            "visibleByDefault": server["policy"]["visibleByDefault"] != false,
            "maxRiskLevel": server["policy"]["maxRiskLevel"].as_str().unwrap_or("L4_privileged"),
        },
        "createdAt": server.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": server.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

impl McpRegistryStore {
    fn read_raw_servers(&self) -> Result<Vec<Value>, StoreError> {
        let Some(bytes) = files::read(&self.file, MAX_REGISTRY_BYTES)? else {
            return Ok(Vec::new());
        };
        let value = peer_protocol::decode_json_bounded(
            &bytes,
            peer_protocol::JsonLimits {
                bytes: MAX_REGISTRY_BYTES,
                nodes: 65_536,
                depth: 32,
                string_bytes: MAX_REGISTRY_BYTES,
            },
        )
        .map_err(|_| StoreError::HistoryCorrupt)?
        .value;
        let arr = value
            .as_array()
            .or_else(|| value["servers"].as_array())
            .cloned()
            .unwrap_or_default();
        let now = now_iso()?;
        let mut normalized = Vec::with_capacity(arr.len());
        for entry in arr {
            if let Ok(item) = normalize_server(&entry, &now) {
                normalized.push(item);
            }
        }
        Ok(normalized)
    }

    pub fn list_installed(&self) -> Result<Value, StoreError> {
        let servers = self.read_raw_servers()?;
        Ok(Value::Array(servers.iter().map(to_renderer_view).collect()))
    }

    pub fn list_capability_manifests(&self) -> Result<Value, StoreError> {
        let servers = self.read_raw_servers()?;
        let mut manifests = Vec::new();
        for server in &servers {
            if server["enabled"] == false
                || server["policy"]["trusted"] == false
                || server["health"]["status"] == "failed"
            {
                continue;
            }
            let server_id = server["id"].as_str().unwrap_or("");
            let display_name = server["displayName"].as_str().unwrap_or(server_id);
            let visible_default = server["policy"]["visibleByDefault"] != false;
            let require_permission = server["policy"]["requirePermission"] != false;
            let health = if require_permission {
                "needs_permission"
            } else {
                "available"
            };
            let transport = server["transport"].as_str().unwrap_or("streamable_http");
            let auth_mode = server["auth"]["mode"].as_str().unwrap_or("none");
            let has_credential = server["auth"]["credentialRef"]
                .as_str()
                .is_some_and(|s| !s.is_empty());

            for tool in server["tools"].as_array().into_iter().flatten() {
                let tool_name = tool["name"]
                    .as_str()
                    .or_else(|| tool["toolName"].as_str())
                    .unwrap_or("");
                if tool_name.is_empty() {
                    continue;
                }
                let visible = server["toolVisibility"][tool_name]
                    .as_bool()
                    .unwrap_or(visible_default);
                if !visible {
                    continue;
                }
                let cap_id = format!("local.mcp.{server_id}.{tool_name}");
                let fn_name = format!(
                    "mcp__{}__{}",
                    sanitize_symbol(server_id),
                    sanitize_symbol(tool_name)
                );
                let description = tool["description"]
                    .as_str()
                    .or_else(|| tool["toolDesc"].as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("MCP tool {tool_name} from {display_name}."));
                let input_schema = if tool["inputSchema"].is_object() {
                    tool["inputSchema"].clone()
                } else {
                    json!({ "type": "object", "additionalProperties": true })
                };
                manifests.push(json!({
                    "capabilityId": cap_id,
                    "name": fn_name,
                    "displayName": format!("{display_name}: {tool_name}"),
                    "description": description,
                    "source": "mcp",
                    "locality": "local",
                    "health": health,
                    "providerId": server_id,
                    "providerLabel": display_name,
                    "riskLevel": tool["riskLevel"].as_str().unwrap_or("L3_external_write"),
                    "dataLevel": tool["dataLevel"].as_str().unwrap_or("D2_sensitive"),
                    "inputSchema": input_schema,
                    "permissionPolicy": {
                        "kind": "mcp-tool",
                        "required": require_permission,
                    },
                    "runtime": {
                        "executor": "local-tool-host",
                        "executorCapabilityId": cap_id,
                    },
                    "origin": {
                        "providerId": server_id,
                        "transport": transport,
                        "toolName": tool_name,
                        "authMode": auth_mode,
                        "hasCredential": has_credential,
                    },
                }));
            }
        }
        Ok(Value::Array(manifests))
    }

    fn write_servers(&self, servers: &[Value]) -> Result<(), StoreError> {
        let doc = json!({
            "version": 1,
            "servers": servers,
        });
        let bytes = serde_json::to_vec_pretty(&doc).map_err(|_| StoreError::InvalidInput)?;
        if bytes.len() > MAX_REGISTRY_BYTES {
            return Err(StoreError::HistoryLimit);
        }
        log::replace(&self.file, &bytes, None)
    }

    pub fn upsert_server(&self, config: &Value) -> Result<Value, StoreError> {
        if !config.is_object() {
            return Err(StoreError::InvalidInput);
        }
        let parent = self.file.parent().ok_or(StoreError::InvalidInput)?;
        let _ = log::directory(parent)?;
        let _lock = DirectoryLock::acquire(&self.file, Duration::from_millis(200), None)?;
        let mut servers = self.read_raw_servers()?;
        let now = now_iso()?;

        let id = config["id"]
            .as_str()
            .or_else(|| config["mcpId"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let hint = config["displayName"]
                    .as_str()
                    .or_else(|| config["name"].as_str())
                    .or_else(|| config["url"].as_str())
                    .or_else(|| config["serverUrl"].as_str())
                    .unwrap_or("");
                slugify_mcp_id(hint)
            });

        let pos = servers
            .iter()
            .position(|s| s["id"] == id || s["mcpId"] == id);
        let mut merged = pos
            .and_then(|idx| servers[idx].as_object().cloned())
            .unwrap_or_default();
        let previous_created_at = merged
            .get("createdAt")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if let Some(patch_obj) = config.as_object() {
            for (k, v) in patch_obj {
                merged.insert(k.clone(), v.clone());
            }
        }
        merged.insert("id".into(), json!(id));
        merged.insert("mcpId".into(), json!(id));
        merged.insert("updatedAt".into(), json!(now));
        merged.insert(
            "createdAt".into(),
            json!(previous_created_at.as_deref().unwrap_or(&now)),
        );

        let normalized = normalize_server(&Value::Object(merged), &now)?;
        match pos {
            Some(idx) => servers[idx] = normalized.clone(),
            None => servers.push(normalized.clone()),
        }
        self.write_servers(&servers)?;
        Ok(to_renderer_view(&normalized))
    }

    pub fn uninstall(&self, server_id: &str) -> Result<(Value, Option<String>), StoreError> {
        let parent = self.file.parent().ok_or(StoreError::InvalidInput)?;
        let _ = log::directory(parent)?;
        let _lock = DirectoryLock::acquire(&self.file, Duration::from_millis(200), None)?;
        let servers = self.read_raw_servers()?;
        let bound_cred = servers
            .iter()
            .find(|s| s["id"] == server_id || s["mcpId"] == server_id)
            .and_then(|s| s["auth"]["credentialRef"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let remaining: Vec<Value> = servers
            .into_iter()
            .filter(|s| s["id"] != server_id && s["mcpId"] != server_id)
            .collect();
        self.write_servers(&remaining)?;
        let views: Vec<Value> = remaining.iter().map(to_renderer_view).collect();
        Ok((Value::Array(views), bound_cred))
    }

    pub fn set_enabled(&self, server_id: &str, enabled: bool) -> Result<Value, StoreError> {
        let parent = self.file.parent().ok_or(StoreError::InvalidInput)?;
        let _ = log::directory(parent)?;
        let _lock = DirectoryLock::acquire(&self.file, Duration::from_millis(200), None)?;
        let mut servers = self.read_raw_servers()?;
        let Some(pos) = servers
            .iter()
            .position(|s| s["id"] == server_id || s["mcpId"] == server_id)
        else {
            return Err(StoreError::NotFound);
        };
        let now = now_iso()?;
        servers[pos]["enabled"] = json!(enabled);
        servers[pos]["updatedAt"] = json!(now);
        let updated = normalize_server(&servers[pos], &now)?;
        servers[pos] = updated.clone();
        self.write_servers(&servers)?;
        Ok(to_renderer_view(&updated))
    }

    pub fn set_tool_visibility(
        &self,
        server_id: &str,
        tool_name: &str,
        visible: bool,
    ) -> Result<Value, StoreError> {
        let tname = tool_name.trim();
        if tname.is_empty() {
            return Err(StoreError::InvalidInput);
        }
        let parent = self.file.parent().ok_or(StoreError::InvalidInput)?;
        let _ = log::directory(parent)?;
        let _lock = DirectoryLock::acquire(&self.file, Duration::from_millis(200), None)?;
        let mut servers = self.read_raw_servers()?;
        let Some(pos) = servers
            .iter()
            .position(|s| s["id"] == server_id || s["mcpId"] == server_id)
        else {
            return Err(StoreError::NotFound);
        };
        let now = now_iso()?;
        if !servers[pos]["toolVisibility"].is_object() {
            servers[pos]["toolVisibility"] = json!({});
        }
        servers[pos]["toolVisibility"][tname] = json!(visible);
        servers[pos]["updatedAt"] = json!(now);
        let updated = normalize_server(&servers[pos], &now)?;
        servers[pos] = updated.clone();
        self.write_servers(&servers)?;
        Ok(to_renderer_view(&updated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_visibility_toggle_capabilities_and_uninstall_preserve_redaction() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpRegistryStore::new(dir.path());
        assert_eq!(store.list_installed().unwrap(), json!([]));

        let view = store
            .upsert_server(&json!({
                "displayName": "GitHub Server",
                "transport": "streamable_http",
                "url": "https://mcp.example.com",
                "headers": { "Authorization": "Bearer secret-token" },
                "auth": { "mode": "http_bearer", "credentialRef": "github-pat" },
                "tools": [
                    { "name": "list_issues", "description": "List issues" },
                    { "name": "create_issue", "description": "Create issue" }
                ]
            }))
            .unwrap();

        let id = view["id"].as_str().unwrap().to_owned();
        assert_eq!(id, "github-server");
        assert!(view.get("headers").is_none());
        assert_eq!(view["auth"]["credentialRef"], "mcp-cred:github-pat");
        assert_eq!(view["toolsCount"], 2);

        let caps = store.list_capability_manifests().unwrap();
        assert_eq!(caps.as_array().unwrap().len(), 2);

        let hidden = store
            .set_tool_visibility(&id, "create_issue", false)
            .unwrap();
        assert_eq!(hidden["visibleToolsCount"], 1);
        let caps_after = store.list_capability_manifests().unwrap();
        assert_eq!(caps_after.as_array().unwrap().len(), 1);
        assert_eq!(
            caps_after[0]["capabilityId"],
            "local.mcp.github-server.list_issues"
        );

        let disabled = store.set_enabled(&id, false).unwrap();
        assert_eq!(disabled["enabled"], false);
        assert_eq!(store.list_capability_manifests().unwrap(), json!([]));

        let (remaining, bound_ref) = store.uninstall(&id).unwrap();
        assert_eq!(remaining, json!([]));
        assert_eq!(bound_ref.as_deref(), Some("mcp-cred:github-pat"));
    }
}
