//! Synthetic cross-runtime test adapter, never a production authority source.
use peer_protocol::{normalize_execution_resource_scope, normalize_session_execution_identity};
use peer_store::{
    ExecutionResourceStore, HostClaimClosure, HostDispatchScopes, HostResourcePlan, ResourceError,
    ResourceReservation,
};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read, Write},
    path::PathBuf,
    sync::atomic::AtomicBool,
};
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, ResourceError> {
    v[key].as_str().ok_or(ResourceError::Invalid)
}
fn plan(v: &Value) -> Result<HostResourcePlan, ResourceError> {
    Ok(HostResourcePlan {
        execution: normalize_session_execution_identity(&v["execution"])
            .ok_or(ResourceError::Invalid)?,
        workspace_id: text(v, "workspaceId")?.into(),
        directory: v["directory"].as_str().map(PathBuf::from),
        title: v["title"].as_str().unwrap_or("").into(),
        read_only: v["readOnly"] == true,
    })
}
fn execute(root: &std::path::Path, r: &Value) -> Result<Value, ResourceError> {
    let op = text(r, "op")?;
    let at = r["at"].as_str().unwrap_or("2026-11-14T00:00:00.000Z");
    if op == "schema_crash" {
        let c =
            rusqlite::Connection::open(root.join("project-runtime/execution-resources.sqlite"))?;
        c.pragma_update(None, "user_version", 4)?;
        println!("{}", json!({"uncheckpointedSchema":4}));
        io::stdout().flush().unwrap();
        std::process::exit(77);
    }
    if op == "scope" {
        return Ok(
            json!({"directory":peer_store::directory_resource(text(r,"path")?,r["missing"]==true)?,"fileScopes":peer_store::provider_file_scopes(text(r,"file")?)?,"executionScopes":peer_store::provider_execution_scopes(text(r,"path")?)?}),
        );
    }
    let read = matches!(
        op,
        "snapshot"
            | "claims"
            | "revision"
            | "inspect"
            | "admitted"
            | "retained"
            | "resolutions"
            | "resolution"
            | "evidence"
            | "handles"
            | "has_closure"
    );
    let mut s = if read {
        ExecutionResourceStore::open_existing(root)?
    } else {
        ExecutionResourceStore::initialize(root, Some(&AtomicBool::new(r["cancelled"] == true)))?
    };
    match op {
        "init" => Ok(json!({"revision":s.revision()?})),
        "revision" => Ok(json!(s.revision()?)),
        "snapshot" => Ok(json!(s.snapshot()?)),
        "reserve" | "reserve_crash" => {
            let p = plan(&r["plan"])?;
            let scopes = r["scopes"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| normalize_execution_resource_scope(v).ok_or(ResourceError::Scope))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
                .unwrap_or_default();
            let out = s.reserve(
                &p,
                ResourceReservation {
                    host_epoch: text(r, "host")?,
                    scopes: &scopes,
                    record_conflict: r["recordConflict"] == true,
                },
                at,
            )?;
            if op == "reserve_crash" {
                println!("{}", json!({"ok":true,"value":out}));
                io::stdout().flush().unwrap();
                std::process::exit(77);
            }
            Ok(out)
        }
        "inspect" => s.inspect(&plan(&r["plan"])?, r["host"].as_str()),
        "admitted" => Ok(json!(s.admitted(&plan(&r["plan"])?, text(r, "host")?)?)),
        "activate" => Ok(json!(s.activate(
            &plan(&r["plan"])?,
            text(r, "host")?,
            at
        )?)),
        "claims" => Ok(json!(s.claims_for(&plan(&r["plan"])?)?)),
        "has_closure" => Ok(json!(s.has_closure(&plan(&r["plan"])?)?)),
        "protect" => {
            let calls = r["unknown"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().map(str::to_owned).ok_or(ResourceError::Invalid))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
                .unwrap_or_default();
            s.protect(
                &plan(&r["plan"])?,
                r["host"].as_str(),
                r["operationId"].as_str(),
                r["state"].as_str().unwrap_or("draining"),
                &calls,
                at,
            )?;
            Ok(Value::Null)
        }
        "handle" => {
            s.mark_handle(&plan(&r["plan"])?, &r["handle"], at)?;
            Ok(Value::Null)
        }
        "handles" => Ok(json!(s.unsettled_handles(&plan(&r["plan"])?)?)),
        "settle" => {
            let dispatches = r["dispatches"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| {
                            Ok(HostDispatchScopes {
                                tool_call_id: text(v, "toolCallId")?.into(),
                                scopes: v["scopes"]
                                    .as_array()
                                    .ok_or(ResourceError::Invalid)?
                                    .iter()
                                    .map(|s| {
                                        normalize_execution_resource_scope(s)
                                            .ok_or(ResourceError::Scope)
                                    })
                                    .collect::<Result<_, _>>()?,
                            })
                        })
                        .collect::<Result<Vec<_>, ResourceError>>()
                })
                .transpose()?
                .unwrap_or_default();
            s.settle(&plan(&r["plan"])?, &r["receipt"], &dispatches, at)
        }
        "close" => {
            let c = &r["closure"];
            let unknown = c["unknownCalls"]
                .as_array()
                .ok_or(ResourceError::Invalid)?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or(ResourceError::Invalid))
                .collect::<Result<Vec<_>, _>>()?;
            s.close_claim(
                &plan(&r["plan"])?,
                HostClaimClosure {
                    claim_id: text(c, "claimId")?,
                    claim_revision: c["claimRevision"].as_u64().ok_or(ResourceError::Invalid)?,
                    authority_ref: text(c, "authorityRef")?,
                    unknown_calls: &unknown,
                    proof: c["proof"].as_str().unwrap_or("legacy_user_confirmed"),
                    resolution: c.get("resolution").filter(|v| !v.is_null()),
                    at,
                },
            )
        }
        "retained" => Ok(json!(s.retained_unknowns(&plan(&r["plan"])?)?)),
        "resolutions" => Ok(json!(s.resolutions_for(&plan(&r["plan"])?)?)),
        "resolution" => Ok(json!(s.resolution_for(text(r, "claimId")?)?)),
        "evidence" => Ok(json!(s.reconciliation_evidence_for(text(r, "claimId")?)?)),
        "record_evidence" => s.record_reconciliation(&r["evidence"]),
        "rebind" => {
            s.rebind_requirements(
                &normalize_session_execution_identity(&r["from"]).ok_or(ResourceError::Invalid)?,
                &normalize_session_execution_identity(&r["to"]).ok_or(ResourceError::Invalid)?,
                text(r, "receiptId")?,
            )?;
            Ok(Value::Null)
        }
        _ => Err(ResourceError::Invalid),
    }
}
fn main() {
    let root =
        PathBuf::from(env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").expect("synthetic fixture root"));
    assert!(root.join(".native-cli-fixture").is_file());
    let mut input = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut input).unwrap();
    let decoded = peer_protocol::decode_json_bounded(
        &input,
        peer_protocol::JsonLimits {
            bytes: 1_048_576,
            nodes: 32_768,
            depth: 64,
            string_bytes: 1_048_576,
        },
    );
    let result = decoded
        .map_err(|_| ResourceError::Invalid)
        .and_then(|r| execute(&root, &r.value));
    println!(
        "{}",
        match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"code":error.code()}),
        }
    );
}
