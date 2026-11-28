//! Static HTTP capability. Network replies are data, never Context instructions.
use super::*;
use std::{
    cell::Cell,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
mod http;
mod publication;
mod search;
mod text;
static MEMORY: OnceLock<Arc<Semaphore>> = OnceLock::new();
pub(super) struct WebProvider;
struct Fetch {
    args: Value,
    home: PathBuf,
    port: Option<EffectAdmission>,
}
struct Search {
    args: Value,
    port: Option<EffectAdmission>,
}
struct Guard {
    cancel: CancellationToken,
    port: EffectAdmission,
    runtime: tokio::runtime::Handle,
    next: Cell<Instant>,
    error: Cell<Option<&'static str>>,
}
impl Guard {
    fn check(&self) -> Result<(), &'static str> {
        if self.cancel.is_cancelled() {
            self.error.set(Some("CANCELLED"));
            return Err("CANCELLED");
        };
        match self.runtime.block_on(self.port.check()) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.error.set(Some(e.0));
                Err(e.0)
            }
        }
    }
    fn interrupted(&self) -> bool {
        if self.error.get().is_some() {
            return true;
        }
        if self.cancel.is_cancelled() {
            self.error.set(Some("CANCELLED"));
            return true;
        }
        if Instant::now() >= self.next.get() {
            self.next.set(Instant::now() + Duration::from_millis(100));
            return self.check().is_err();
        }
        false
    }
}
impl CapabilityProvider for WebProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let fetch: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/web-fetch.json"
        ))
        .expect("compiled web-fetch manifest");
        let search: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/web-search.json"
        ))
        .expect("compiled web-search manifest");
        vec![
            ("web_fetch".into(), fetch["manifest"].clone()),
            ("web_search".into(), search["manifest"].clone()),
        ]
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        match capability {
            "local.web.fetch" => {
                validate_shape(&args, &["url", "waitForRender", "timeoutMs"])?;
                if args["url"].as_str().is_none() {
                    return Err(HostError("invalid_url"));
                }
                if args.get("waitForRender").is_some_and(|v| !v.is_boolean())
                    || args.get("timeoutMs").is_some_and(|v| !v.is_number())
                {
                    return Err(HostError("tool_arguments_invalid"));
                }
                if args["url"].as_str().unwrap().len() > 16384 {
                    return Err(HostError("web_url_limit"));
                }
                Ok(Box::new(Fetch {
                    args,
                    home: home.into(),
                    port: None,
                }))
            }
            "local.web.search" => {
                search::validate_args(&args)?;
                Ok(Box::new(Search { args, port: None }))
            }
            _ => Err(HostError("tool_not_projected")),
        }
    }
}
impl PreparedEffect for Search {
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
    fn evidence(&self) -> Option<Value> {
        Some(json!({"operation":"web_search"}))
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
            search::execute(&self.args, port, cancel).await
        }))
    }
}
impl PreparedEffect for Fetch {
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
    fn evidence(&self) -> Option<Value> {
        Some(json!({"operation":"web_fetch","fetchMode":"http"}))
    }
    fn start(
        mut self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        let conversation = call.conversation_id().to_owned();
        let call = call.tool_call_id().to_owned();
        Ok(Box::pin(async move {
            let pool = MEMORY.get_or_init(|| Arc::new(Semaphore::new(1))).clone();
            let permit = tokio::select! {biased;_=cancel.cancelled()=>return EffectOutcome::not_dispatched("CANCELLED"),p=pool.acquire_owned()=>match p{Ok(p)=>p,Err(_)=>return EffectOutcome::not_dispatched("web_fetch_unavailable")}};
            let rt = tokio::runtime::Handle::current();
            let home = self.home.clone();
            let token = cancel.clone();
            let p = port.clone();
            let runtime = rt.clone();
            let preflight = tokio::task::spawn_blocking(move || {
                runtime.block_on(p.check()).map_err(|e| e.0)?;
                peer_store::WebArtifactStore::new(home)
                    .check_capacity(&|| token.is_cancelled())
                    .map_err(|e| e.code)
            })
            .await;
            match preflight {
                Ok(Ok(())) => {}
                Ok(Err(code)) => return EffectOutcome::not_dispatched(code),
                Err(_) => return EffectOutcome::not_dispatched("web_artifact_unavailable"),
            }
            let fetched = match http::fetch(&self.args, &port, &cancel).await {
                Ok(v) => v,
                Err(e) => return e.outcome(),
            };
            let guard = Guard {
                cancel,
                port,
                runtime: rt,
                next: Cell::new(Instant::now()),
                error: Cell::new(None),
            };
            // The working-set permit moves into the real blocking owner and cannot be
            // released while extraction or publication is still running.
            let task = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                publication::save(
                    &self.home,
                    &conversation,
                    &call,
                    &self.args,
                    fetched,
                    &guard,
                )
            });
            task.await.unwrap_or_else(|_| {
                let mut v = EffectOutcome::failed("execution_outcome_unknown");
                v.output = json!({"reason":"web_worker_failed"});
                v
            })
        }))
    }
}

#[cfg(test)]
mod tests;
