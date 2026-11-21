//! Multiple read lanes share one call/Grant, owned lifetime and bounded scheduler.
use super::*;
use std::{collections::HashSet, sync::OnceLock};
use tokio::{sync::Semaphore, task::JoinSet};
const LANES: usize = 8;
const WORKERS: usize = 2;
const MATCHES: usize = 500;
const RESULT_BYTES: usize = 4 * 1024 * 1024;
static POOL: OnceLock<Arc<Semaphore>> = OnceLock::new();
pub(in crate::providers) struct BatchSearchProvider;
#[derive(Clone)]
struct Lane {
    id: String,
    label: String,
    args: Value,
}
struct Batch {
    args: Value,
    lanes: Vec<Lane>,
    workspace: PathBuf,
    concurrency: usize,
    port: Option<EffectAdmission>,
    #[cfg(feature = "test-fixtures")]
    home: PathBuf,
}
fn lanes(args: &Value) -> Result<Vec<Lane>, HostError> {
    validate_shape(args, &["queries", "max_concurrency", "dedupe"])?;
    let items = args["queries"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= LANES)
        .ok_or(HostError("invalid_queries"))?;
    let mut seen = HashSet::new();
    items
        .iter()
        .enumerate()
        .map(|(i, v)| {
            validate_shape(
                v,
                &[
                    "id",
                    "label",
                    "query",
                    "path",
                    "case_sensitive",
                    "max_results",
                ],
            )?;
            let text = |key: &str| {
                v[key]
                    .as_str()
                    .map(peer_protocol::javascript_trim)
                    .filter(|s| !s.is_empty())
            };
            let id = text("id")
                .map(str::to_owned)
                .unwrap_or_else(|| format!("lane-{}", i + 1));
            if !seen.insert(id.clone()) {
                return Err(HostError("duplicate_query_id"));
            }
            let query = text("query").ok_or(HostError("invalid_query"))?;
            let mut search = json!({"query":query,"case_sensitive":v["case_sensitive"]==true});
            if let Some(path) = text("path") {
                search["path"] = json!(path)
            }
            if v["max_results"].is_number() {
                search["max_results"] = v["max_results"].clone()
            }
            Ok(Lane {
                id,
                label: text("label").unwrap_or(query).into(),
                args: search,
            })
        })
        .collect()
}
fn concurrency(args: &Value) -> usize {
    args["max_concurrency"]
        .as_f64()
        .unwrap_or(4.0)
        .floor()
        .clamp(1.0, 8.0) as usize
}
fn failed(lane: &Lane, code: &str) -> Value {
    json!({"id":lane.id,"label":lane.label,"query":lane.args["query"],"status":if code=="CANCELLED"{"cancelled"}else{"failed"},"matchCount":0,"truncated":false,"matches":[],"errorMessage":code})
}
fn control_error(code: &str) -> bool {
    !matches!(
        code,
        "file_unavailable"
            | "file_parent_unavailable"
            | "invalid_path"
            | "not_a_file_or_directory"
            | "file_collection_limit"
            | "file_result_limit"
            | "file_path_encoding"
            | "file_locale_unavailable"
            | "invalid_query"
            | "tool_arguments_invalid"
    )
}
fn aggregate(lanes: &[Value], dedupe: bool) -> Result<(Vec<Value>, bool), HostError> {
    let mut out: Vec<Value> = Vec::new();
    let mut locations = HashMap::new();
    for lane in lanes {
        for m in lane["matches"].as_array().unwrap() {
            // Match legacy ordering: reaching the cap precedes even a dedupe hit,
            // and that early return intentionally bypasses the final sort.
            if out.len() >= MATCHES {
                return Ok((out, true));
            }
            let key = format!("{}:{}", m["path"].as_str().unwrap(), m["line"]);
            if let Some(&i) = locations.get(&key).filter(|_| dedupe) {
                let hit: &mut Value = &mut out[i];
                let ids = hit["laneIds"].as_array_mut().unwrap();
                if !ids.contains(&lane["id"]) {
                    ids.push(lane["id"].clone())
                }
                hit["hitCount"] = json!(hit["hitCount"].as_u64().unwrap() + 1);
                continue;
            }
            if dedupe {
                locations.insert(key, out.len());
            }
            let mut m = m.clone();
            m["laneIds"] = json!([lane["id"]]);
            m["hitCount"] = json!(1);
            out.push(m);
        }
    }
    let locale = locale::FileLocale::current()?;
    out.sort_by(|a, b| {
        b["hitCount"]
            .as_u64()
            .cmp(&a["hitCount"].as_u64())
            .then_with(|| locale.compare(a["path"].as_str().unwrap(), b["path"].as_str().unwrap()))
            .then_with(|| a["line"].as_u64().cmp(&b["line"].as_u64()))
    });
    Ok((out, false))
}
fn output(results: &[Value], concurrency: usize, dedupe: bool) -> Result<Value, HostError> {
    let (matches, truncated) = aggregate(results, dedupe)?;
    let count = |status: &str| results.iter().filter(|r| r["status"] == status).count();
    let completed = count("completed");
    let failed = count("failed");
    let cancelled = count("cancelled");
    let summaries: Vec<Value> = results
        .iter()
        .map(|r| {
            let mut r = r.clone();
            r.as_object_mut().unwrap().shift_remove("matches");
            r
        })
        .collect();
    let v = json!({"status":if failed>0||cancelled>0{"partial"}else{"success"},"laneCount":results.len(),"completedCount":completed,"failedCount":failed,"cancelledCount":cancelled,"concurrency":concurrency,"dedupe":dedupe,"lanes":summaries,"aggregated":{"totalUniqueMatches":matches.len(),"truncated":truncated,"matches":matches}});
    scan::bounded_to(&v, RESULT_BYTES).map_err(|_| HostError("batch_result_limit"))?;
    Ok(v)
}
impl CapabilityProvider for BatchSearchProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/batch-search.json"
        ))
        .expect("compiled batch contract");
        vec![("batch_search".into(), data["manifest"].clone())]
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        _home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability != "local.search.aggregate" {
            return Err(HostError("tool_not_projected"));
        }
        let normalized = lanes(&args)?;
        let concurrency = concurrency(&args);
        Ok(Box::new(Batch {
            args,
            lanes: normalized,
            workspace: std::fs::canonicalize(workspace)
                .map_err(|_| HostError("file_unavailable"))?,
            concurrency,
            port: None,
            #[cfg(feature = "test-fixtures")]
            home: _home.into(),
        }))
    }
}
impl PreparedEffect for Batch {
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Read
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }
    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port)
    }
    fn start(
        mut self: Box<Self>,
        _call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            let local = cancel.child_token();
            let mut tasks = JoinSet::new();
            let mut next = 0;
            let mut results = vec![Value::Null; self.lanes.len()];
            let mut control = None;
            while next < self.lanes.len() || !tasks.is_empty() {
                while next < self.lanes.len() && tasks.len() < self.concurrency.min(WORKERS) {
                    let i = next;
                    next += 1;
                    let lane = self.lanes[i].clone();
                    let workspace = self.workspace.clone();
                    let port = port.clone();
                    let cancel = local.clone();
                    #[cfg(feature = "test-fixtures")]
                    let home = self.home.clone();
                    tasks.spawn(async move {
                        let pool = POOL.get_or_init(|| Arc::new(Semaphore::new(WORKERS))).clone();
                        let permit = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => return (i, failed(&lane, "CANCELLED"), Some("CANCELLED")),
                            permit = pool.acquire_owned() => match permit {
                                Ok(permit) => permit,
                                Err(_) => return (i, failed(&lane, "batch_worker_failed"), Some("batch_worker_failed")),
                            },
                        };
                        let fallback = lane.clone();
                        let runtime = tokio::runtime::Handle::current();
                        let result = tokio::task::spawn_blocking(move || {
                            let _permit = permit;
                            let run = RunGuard { cancel, port, runtime };
                            let result = (|| {
                                run.check()?;
                                #[cfg(feature = "test-fixtures")]
                                barrier(&home, i, &run)?;
                                let path = resolve(&workspace, lane.args["path"].as_str().unwrap_or("."))?;
                                run.authorize_path(&path)?;
                                scan::search(&path, &workspace, &lane.args, &run)
                            })();
                            match result {
                                Ok(value) => (json!({"id":lane.id,"label":lane.label,"query":lane.args["query"],"status":"completed","matchCount":value["matchCount"],"truncated":value["truncated"],"matches":value["matches"]}), None),
                                Err(error) => (failed(&lane, error.0), control_error(error.0).then_some(error.0)),
                            }
                        }).await.unwrap_or_else(|_| (failed(&fallback, "batch_worker_failed"), Some("batch_worker_failed")));
                        (i, result.0, result.1)
                    });
                }
                match tasks.join_next().await {
                    Some(Ok((i, result, error))) => {
                        results[i] = result;
                        if let Some(error) = error {
                            if control.is_none() {
                                control = Some(error)
                            }
                            local.cancel();
                        }
                    }
                    Some(Err(_)) => {
                        control = Some("batch_worker_failed");
                        local.cancel();
                    }
                    None => break,
                }
            }
            // All async jobs have awaited their blocking worker; cancellation
            // never abandons a scan or drops ownership while it still runs.
            if results.iter().any(Value::is_null) {
                return EffectOutcome::failed("batch_worker_failed");
            }
            let value = match output(&results, self.concurrency, self.args["dedupe"] != false) {
                Ok(v) => v,
                Err(e) => return EffectOutcome::failed(e.0),
            };
            let error = control.or_else(|| {
                if value["failedCount"] == value["laneCount"] {
                    Some("all_search_lanes_failed")
                } else if value["cancelledCount"] == value["laneCount"] {
                    Some("CANCELLED")
                } else {
                    None
                }
            });
            EffectOutcome {
                status: if error == Some("CANCELLED") {
                    "cancelled"
                } else if error.is_some() {
                    "failed"
                } else {
                    "success"
                },
                output: value,
                error,
                artifacts: vec![],
                ended: true,
                materialization: None,
                not_dispatched: false,
            }
        }))
    }
}

#[cfg(feature = "test-fixtures")]
fn barrier(home: &Path, index: usize, run: &RunGuard) -> Result<(), HostError> {
    let kind = std::env::var("PEER_NATIVE_BATCH_BARRIER").unwrap_or_default();
    if home.join(".native-cli-fixture").is_file()
        && (kind == "hold" || kind == "after-first" && index > 0)
    {
        std::fs::write(home.join(format!("batch-worker-{index}-ready")), "owned")
            .map_err(|_| HostError("batch_worker_failed"))?;
        while !home.join("batch-worker-resume").exists() {
            run.check()?;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
