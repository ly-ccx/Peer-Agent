//! Explicit native MCP credential management; never invokes a tool or grants it.
use crate::{
    CancellationToken,
    credentials::HelperClient,
    mcp_auth::{self, SensitiveConfig},
};
use peer_store::{
    McpCredentialBinding, McpCredentialStore, McpCredentialTransaction, McpRegistryStore,
};
use reqwest::Url;
use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    InMemoryCredentialStore, OAuthClientConfig, StoredCredentials,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{future::Future, path::Path, sync::Arc, time::Duration};
mod callback;
mod http;

async fn bounded<T>(
    cancel: &CancellationToken,
    future: impl Future<Output = T>,
    seconds: u64,
) -> Result<T, &'static str> {
    tokio::select! {biased;_=cancel.cancelled()=>Err("CANCELLED"),value=tokio::time::timeout(Duration::from_secs(seconds),future)=>value.map_err(|_|"mcp_oauth_timeout")}
}
fn now_ms() -> Result<u64, &'static str> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .map_err(|_| "mcp_oauth_clock_invalid")
}
struct Commit {
    registry_revision: String,
    binding: McpCredentialBinding,
    transaction: McpCredentialTransaction,
    payload: SensitiveConfig,
    memory: InMemoryCredentialStore,
}
struct Flow {
    commit: Commit,
    manager: AuthorizationManager,
}
impl Flow {
    async fn load(
        home: &Path,
        server: &str,
        cancel: &CancellationToken,
        recovery: bool,
    ) -> Result<Self, &'static str> {
        let registry = McpRegistryStore::new(home).read().map_err(|e| e.code())?;
        let mut config = registry.server(server).ok_or("mcp_server_missing")?;
        if config["auth"]["mode"] != "oauth2" || config["transport"] == "stdio" {
            return Err("mcp_oauth_binding_required");
        }
        if config["transport"].is_null() {
            config["transport"] = json!("streamable_http");
        }
        let binding = mcp_auth::binding(home, &config)?.ok_or("mcp_oauth_binding_required")?;
        let transaction = McpCredentialStore::new(home)
            .transaction(&binding)
            .map_err(|e| e.code())?;
        let payload = mcp_auth::load_payload(home, &binding, cancel).await?;
        if let Some(state) = payload.0.get("refreshState") {
            let known = state["schemaVersion"] == 1
                && state["previousTokens"].is_object()
                && state["operationId"].as_str().is_some_and(|id| {
                    uuid::Uuid::parse_str(id)
                        .is_ok_and(|u| u.get_version_num() == 4 && u.to_string() == id)
                });
            if !recovery || !known {
                return Err("mcp_oauth_recovery_required");
            }
        }
        let raw = config["url"]
            .as_str()
            .or_else(|| config["serverUrl"].as_str())
            .ok_or("mcp_url_invalid")?;
        let url = Url::parse(raw).map_err(|_| "mcp_url_invalid")?;
        let client = Arc::new(http::BoundedHttp::new(&url, cancel)?);
        let challenge = bounded(cancel, client.challenge(&url), 30).await??;
        let mut manager = AuthorizationManager::new_with_oauth_http_client(raw, client)
            .await
            .map_err(|_| "mcp_oauth_config_invalid")?;
        let resolution = bounded(
            cancel,
            manager.resolve_metadata_from_challenge(challenge.as_deref()),
            30,
        )
        .await?
        .map_err(|_| "mcp_oauth_discovery_failed")?;
        let issuer = resolution
            .metadata
            .issuer
            .as_deref()
            .ok_or("mcp_oauth_issuer_missing")?;
        for key in ["authorizationServerUrl", "nativeIssuer"] {
            if let Some(expected) = payload.0["oauth"][key].as_str().filter(|v| !v.is_empty()) {
                let expected = Url::parse(expected).map_err(|_| "mcp_oauth_issuer_invalid")?;
                let actual = Url::parse(issuer).map_err(|_| "mcp_oauth_issuer_invalid")?;
                if expected != actual {
                    return Err("mcp_oauth_issuer_changed");
                }
            }
        }
        let mut payload = payload;
        payload.0["oauth"]["nativeIssuer"] = json!(issuer);
        manager.set_metadata(resolution.metadata);
        let memory = InMemoryCredentialStore::new();
        manager.set_credential_store(memory.clone());
        Ok(Self {
            commit: Commit {
                registry_revision: registry.source_revision,
                binding,
                transaction,
                payload,
                memory,
            },
            manager,
        })
    }
    async fn client(
        &mut self,
        redirect: &str,
        cancel: &CancellationToken,
    ) -> Result<OAuthClientConfig, &'static str> {
        let oauth = &self.commit.payload.0["oauth"];
        let id = oauth["clientInformation"]["client_id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| oauth["clientId"].as_str().filter(|v| !v.is_empty()));
        let mut scopes = oauth["scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if scopes.is_empty() {
            scopes = self.manager.select_initial_scopes(&[]).await;
        }
        let client = if let Some(id) = id {
            let mut config = OAuthClientConfig::new(id, redirect).with_scopes(scopes);
            if let Some(secret) = oauth["clientInformation"]["client_secret"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or_else(|| oauth["clientSecret"].as_str().filter(|v| !v.is_empty()))
            {
                config = config.with_client_secret(secret);
            }
            config
        } else {
            let refs = scopes.iter().map(String::as_str).collect::<Vec<_>>();
            bounded(
                cancel,
                self.manager
                    .register_client("Peer native CLI", redirect, &refs),
                30,
            )
            .await?
            .map_err(|_| "mcp_oauth_registration_failed")?
        };
        self.commit.payload.0["oauth"]["clientInformation"] =
            json!({"client_id":client.client_id,"client_secret":client.client_secret});
        self.commit.payload.0["oauth"]["clientId"] = json!(client.client_id);
        self.commit.payload.0["oauth"]["redirectUrl"] = json!(redirect);
        Ok(client)
    }
}
impl Commit {
    async fn save(mut self, home: &Path, cancel: &CancellationToken) -> Result<(), &'static str> {
        if McpRegistryStore::new(home)
            .read()
            .map_err(|e| e.code())?
            .source_revision
            != self.registry_revision
        {
            return Err("mcp_oauth_binding_changed");
        }
        let stored = self
            .memory
            .load()
            .await
            .map_err(|_| "mcp_oauth_store_failed")?
            .ok_or("mcp_oauth_token_missing")?;
        let mut tokens = SensitiveConfig(
            serde_json::to_value(stored.token_response.ok_or("mcp_oauth_token_missing")?)
                .map_err(|_| "mcp_oauth_token_invalid")?,
        );
        if let Some(seconds) = tokens.0["expires_in"].as_u64() {
            let expires = stored
                .token_received_at
                .unwrap_or(now_ms()? / 1000)
                .checked_mul(1000)
                .and_then(|v| seconds.checked_mul(1000).and_then(|s| v.checked_add(s)))
                .filter(|v| *v <= 9007199254740991)
                .ok_or("mcp_oauth_token_invalid")?;
            tokens.0["expires_at"] = json!(expires);
        }
        self.payload.0["oauth"]["tokens"] = tokens.0.take();
        if !stored.granted_scopes.is_empty() {
            self.payload.0["oauth"]["scopes"] = json!(stored.granted_scopes);
        }
        self.payload.0["oauth"]["codeVerifier"] = json!("");
        self.payload
            .0
            .as_object_mut()
            .unwrap()
            .remove("refreshState");
        let metadata = self.stage(home, cancel).await?;
        // Commit cannot be cancelled after rename; an uncertain receipt preserves it.
        self.transaction.commit(metadata).map_err(|e| e.code())?;
        Ok(())
    }
    async fn reserve_refresh(
        &mut self,
        home: &Path,
        cancel: &CancellationToken,
    ) -> Result<(), &'static str> {
        let previous = self.payload.0["oauth"]
            .as_object_mut()
            .ok_or("mcp_oauth_token_invalid")?
            .remove("tokens")
            .ok_or("mcp_oauth_token_invalid")?;
        self.payload.0["refreshState"] = json!({
            "schemaVersion":1,"operationId":uuid::Uuid::new_v4().to_string(),
            "previousTokens":previous
        });
        let mut metadata = self.stage(home, cancel).await?;
        metadata["oauth"]["tokenStatus"] = json!("recovery_required");
        self.binding = self.transaction.publish(metadata).map_err(|e| e.code())?;
        Ok(())
    }
    async fn stage(
        &mut self,
        home: &Path,
        cancel: &CancellationToken,
    ) -> Result<serde_json::Value, &'static str> {
        let raw = zeroize::Zeroizing::new(
            serde_json::to_string(&self.payload.0).map_err(|_| "mcp_oauth_token_invalid")?,
        );
        if raw.len() > 262144 {
            return Err("mcp_credential_limit");
        }
        drop(SensitiveConfig(
            peer_protocol::decode_json_bounded(
                raw.as_bytes(),
                peer_protocol::JsonLimits {
                    bytes: 262144,
                    nodes: 8192,
                    depth: 32,
                    string_bytes: 262144,
                },
            )
            .map_err(|_| "mcp_credential_limit")?
            .value,
        ));
        let key = format!(
            "mcp/{:x}/{}",
            Sha256::digest(
                self.binding.metadata["credentialRef"]
                    .as_str()
                    .ok_or("mcp_credential_invalid")?
                    .as_bytes()
            ),
            uuid::Uuid::new_v4()
        );
        let client = HelperClient::for_home(home).map_err(|_| "credential_helper_unavailable")?;
        client.set(&key, &raw, cancel).await.map_err(|_| {
            if cancel.is_cancelled() {
                "CANCELLED"
            } else {
                "mcp_credential_unavailable"
            }
        })?;
        let actual = client
            .get(&key, cancel)
            .await
            .map_err(|_| {
                if cancel.is_cancelled() {
                    "CANCELLED"
                } else {
                    "mcp_credential_unavailable"
                }
            })?
            .ok_or("mcp_credential_verification_failed")?;
        let difference = actual
            .expose()
            .bytes()
            .zip(raw.bytes())
            .fold(0u8, |v, (a, b)| v | (a ^ b));
        if actual.expose().len() != raw.len() || difference != 0 {
            return Err("mcp_credential_verification_failed");
        }
        let oauth = &self.payload.0["oauth"];
        let mut metadata = self.binding.metadata.clone();
        metadata["vaultKey"] = json!(key);
        metadata["storage"] = json!("vault");
        let now = time::OffsetDateTime::from_unix_timestamp((now_ms()? / 1000) as i64)
            .map_err(|_| "mcp_oauth_clock_invalid")?;
        metadata["updatedAt"] = json!(
            now.format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| "mcp_oauth_clock_invalid")?
        );
        metadata["oauth"] = json!({"authorizationServerUrl":oauth["nativeIssuer"],"clientId":oauth["clientId"],"clientSecretConfigured":oauth["clientInformation"]["client_secret"].as_str().is_some_and(|v|!v.is_empty()),"scopes":oauth["scopes"],"redirectUrl":oauth["redirectUrl"],"tokenStatus":"available"});
        if let Some(ms) = oauth["tokens"]["expires_at"].as_u64() {
            let expiry = time::OffsetDateTime::from_unix_timestamp((ms / 1000) as i64)
                .map_err(|_| "mcp_oauth_token_invalid")?;
            metadata["oauth"]["expiresAt"] = json!(
                expiry
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|_| "mcp_oauth_token_invalid")?
            );
        }
        if McpRegistryStore::new(home)
            .read()
            .map_err(|e| e.code())?
            .source_revision
            != self.registry_revision
        {
            return Err("mcp_oauth_binding_changed");
        }
        Ok(metadata)
    }
}

/// Browser navigation remains a human action; callback has one owned listener.
pub async fn authorize(
    home: &Path,
    server: &str,
    cancel: &CancellationToken,
    on_url: impl FnOnce(&str) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let mut flow = Flow::load(home, server, cancel, true).await?;
    let oauth = &flow.commit.payload.0["oauth"];
    let has_client = [&oauth["clientId"], &oauth["clientInformation"]["client_id"]]
        .iter()
        .any(|v| v.as_str().is_some_and(|v| !v.is_empty()));
    // Existing Desktop preregistrations use this exact callback when omitted.
    // New DCR can register a freshly bound loopback port.
    let configured = oauth["redirectUrl"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or(if has_client {
            "http://127.0.0.1:33418/mcp/oauth/callback"
        } else {
            ""
        });
    let (listener, redirect) = callback::listen(configured).await?;
    let config = flow.client(&redirect, cancel).await?;
    let mut request = AuthorizationRequest::new(&redirect)
        .with_initial_scope_selection()
        .with_preregistered_client(&config.client_id)
        .with_scopes(config.scopes.iter().map(String::as_str));
    if let Some(secret) = config.client_secret {
        request = request.with_client_secret(secret);
    }
    let session = bounded(cancel, AuthorizationSession::new(flow.manager, request), 30)
        .await?
        .map_err(|_| "mcp_oauth_authorization_failed")?;
    on_url(session.get_authorization_url())?;
    let callback =
        callback::wait(listener, &redirect, session.get_authorization_url(), cancel).await?;
    bounded(cancel, session.handle_callback_url(&callback), 30)
        .await?
        .map_err(|_| "mcp_oauth_callback_rejected")?;
    flow.commit.save(home, cancel).await
}

/// Explicit refresh never replays a tool, initialize, or authorization code.
pub async fn refresh(
    home: &Path,
    server: &str,
    cancel: &CancellationToken,
) -> Result<(), &'static str> {
    let mut flow = Flow::load(home, server, cancel, false).await?;
    if flow.commit.payload.0["oauth"]["tokens"]["refresh_token"]
        .as_str()
        .is_none_or(|s| s.is_empty())
    {
        return Err("mcp_oauth_authorization_required");
    }
    let redirect = flow.commit.payload.0["oauth"]["redirectUrl"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("http://127.0.0.1/mcp/oauth/callback")
        .to_owned();
    let config = flow.client(&redirect, cancel).await?;
    flow.manager
        .configure_client(config.clone())
        .map_err(|_| "mcp_oauth_config_invalid")?;
    let mut tokens = flow.commit.payload.0["oauth"]["tokens"].clone();
    if tokens.get("token_type").is_none() {
        tokens["token_type"] = json!("Bearer");
    }
    let token = serde_json::from_value(tokens).map_err(|_| "mcp_oauth_token_invalid")?;
    let stored = StoredCredentials::new(
        config.client_id,
        Some(token),
        config.scopes,
        Some(now_ms()? / 1000),
    )
    .with_issuer(
        flow.commit.payload.0["oauth"]["nativeIssuer"]
            .as_str()
            .map(str::to_owned),
    );
    flow.commit
        .memory
        .save(stored)
        .await
        .map_err(|_| "mcp_oauth_store_failed")?;
    flow.commit.reserve_refresh(home, cancel).await?;
    bounded(cancel, flow.manager.refresh_token(), 30)
        .await?
        .map_err(|_| "mcp_oauth_refresh_failed")?;
    flow.commit.save(home, cancel).await
}
