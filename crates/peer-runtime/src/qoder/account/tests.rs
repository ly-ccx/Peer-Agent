use super::*;
use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
struct Fixture {
    root: tempfile::TempDir,
    config: Value,
    selected: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let config = json!({"version":2,"channels":[{"id":"provider","channelId":"qoder","authMethod":"qoder_local_auth"}],"models":[{"id":"provider::auto","groupId":"provider","model":"auto","enabled":true}]});
        let selected = json!({"modelProviderId":"provider::auto"});
        std::fs::write(root.path().join("llm-providers.json"), config.to_string()).unwrap();
        std::fs::create_dir_all(root.path().join("qoder/.auth")).unwrap();
        std::fs::write(
            root.path().join("qoder/.auth/machine_id"),
            "0123456789abcdef-machine\n",
        )
        .unwrap();
        let f = Self {
            root,
            config,
            selected,
        };
        f.user(json!({"uid":"fixture","security_oauth_token":"SYNTHETIC","encrypt_user_info":"INFO","key":"KEY","expire_time":now().unwrap()+3600}));
        f
    }
    fn user(&self, profile: Value) {
        let bytes = profile.to_string().into_bytes();
        let n = bytes.len();
        let mut out = bytes;
        out.resize(n + 16, 0);
        let encrypted = cbc::Encryptor::<aes::Aes128>::new_from_slices(
            b"0123456789abcdef",
            b"0123456789abcdef",
        )
        .unwrap()
        .encrypt_padded_mut::<Pkcs7>(&mut out, n)
        .unwrap();
        std::fs::write(
            self.root.path().join("qoder/.auth/user"),
            STANDARD.encode(encrypted),
        )
        .unwrap();
    }
    fn env(&self) -> Environment {
        let mut env = Environment(ENV_NAMES.iter().map(|_| None).collect());
        for (name, value) in [
            (
                "QODER_CONFIG_DIR",
                self.root
                    .path()
                    .join("qoder")
                    .to_string_lossy()
                    .into_owned(),
            ),
            ("QODER_INFERENCE_ENDPOINT", "http://127.0.0.1:1".into()),
        ] {
            env.0[ENV_NAMES.iter().position(|v| *v == name).unwrap()] = Some(Zeroizing::new(value));
        }
        env
    }
    fn load(&self) -> Result<Account, ModelError> {
        self.load_env(self.env(), &CancellationToken::new())
    }
    fn load_env(
        &self,
        env: Environment,
        cancel: &CancellationToken,
    ) -> Result<Account, ModelError> {
        Account::load_from(
            ModelBinding::new(self.root.path(), &self.config, &self.selected).unwrap(),
            env,
            cancel,
        )
    }
}
#[test]
fn captured_account_is_read_only_and_rejects_rotation_logout_expiry_and_config_change() {
    let f = Fixture::new();
    let path = f.root.path().join("qoder/.auth/user");
    let original = std::fs::read(&path).unwrap();
    let account = f.load().unwrap();
    assert!(
        account
            .endpoint()
            .path()
            .ends_with("/agent_chat_generation")
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    account
        .validate_source(&CancellationToken::new(), now().unwrap())
        .unwrap();
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap() + 4000)
            .unwrap_err()
            .code,
        "qoder_auth_expired"
    );
    f.user(json!({"uid":"other","security_oauth_token":"CHANGED"}));
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap())
            .unwrap_err()
            .code,
        "qoder_auth_changed"
    );
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap())
            .unwrap_err()
            .code,
        "qoder_auth_changed"
    );
    std::fs::write(&path, original).unwrap();
    let account = f.load().unwrap();
    let mut config = f.config.clone();
    config["models"][0]["enabled"] = json!(false);
    std::fs::write(f.root.path().join("llm-providers.json"), config.to_string()).unwrap();
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap())
            .unwrap_err()
            .code,
        "model_configuration_changed"
    );
}
#[test]
fn invalid_or_cancelled_credentials_preserve_source_and_can_be_reloaded_after_repair() {
    for profile in [
        json!({}),
        json!({"uid":"fixture","security_oauth_token":7}),
        json!({"uid":"fixture","security_oauth_token":"SYNTHETIC","expire_time":1}),
        json!({"uid":"fixture","security_oauth_token":"SYNTHETIC","expire_time":"NaN"}),
        json!({"uid":"fixture","security_oauth_token":"SYNTHETIC","organization_tags":[1]}),
        json!({"uid":"fixture","security_oauth_token":"SYNTHETIC","data_policy_agreed":null}),
    ] {
        let f = Fixture::new();
        f.user(profile);
        let path = f.root.path().join("qoder/.auth/user");
        let before = std::fs::read(&path).unwrap();
        assert!(f.load().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        f.user(json!({"uid":"fixture","security_oauth_token":"SYNTHETIC"}));
        assert!(f.load().is_ok());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            f.load_env(f.env(), &cancel).err().unwrap().code,
            "CANCELLED"
        );
    }
}
#[test]
fn bounded_regular_files_reject_symlinks_fifos_invalid_utf8_and_non_byte_compatible_machine_keys() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let path = f.root.path().join("qoder/.auth/user");
    let original = std::fs::read(&path).unwrap();
    std::fs::rename(&path, path.with_extension("saved")).unwrap();
    symlink(path.with_extension("saved"), &path).unwrap();
    assert_eq!(f.load().err().unwrap().code, "qoder_auth_not_regular");
    std::fs::remove_file(&path).unwrap();
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let start = std::time::Instant::now();
    assert_eq!(f.load().err().unwrap().code, "qoder_auth_not_regular");
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    std::fs::remove_file(&path).unwrap();
    for bytes in [vec![0xff], vec![b'x'; CREDENTIAL_LIMIT + 1]] {
        std::fs::write(&path, &bytes).unwrap();
        assert!(f.load().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    std::fs::write(&path, original).unwrap();
    for machine in [
        "short",
        "中文中文中文中文中文中文中文中文",
        "123456789012345🙂",
    ] {
        std::fs::write(f.root.path().join("qoder/.auth/machine_id"), machine).unwrap();
        assert!(f.load().is_err());
    }
}
#[test]
fn environment_token_precedence_does_not_fall_back_to_another_disk_account() {
    let f = Fixture::new();
    let mut env = f.env();
    env.0[ENV_NAMES
        .iter()
        .position(|v| *v == "QODER_ACCESS_TOKEN")
        .unwrap()] = Some(Zeroizing::new("SYNTHETIC-ENV".into()));
    std::fs::remove_file(f.root.path().join("qoder/.auth/user")).unwrap();
    assert_eq!(
        f.load_env(env, &CancellationToken::new())
            .err()
            .unwrap()
            .code,
        "qoder_local_user_info_required"
    );
}
#[test]
fn legacy_mode_uses_bound_base_and_catalog_changes_cannot_silently_switch_it() {
    let mut f = Fixture::new();
    f.config["models"][0]["model"] = json!("unknown-model");
    f.config["channels"][0]["baseUrl"] = json!("http://127.0.0.1:1234/custom");
    std::fs::write(
        f.root.path().join("llm-providers.json"),
        f.config.to_string(),
    )
    .unwrap();
    let account = f.load().unwrap();
    assert_eq!(account.dialect(), QoderDialect::Legacy);
    assert_eq!(
        account.endpoint().as_str(),
        "http://127.0.0.1:1234/custom/chat/completions"
    );
    assert!(account.metadata().is_none());
    std::fs::write(
        f.root.path().join("qoder/.auth/models"),
        r#"{"chat":[{"key":"unknown-model"}]}"#,
    )
    .unwrap();
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap())
            .unwrap_err()
            .code,
        "qoder_auth_changed"
    );
    let fresh = f.load().unwrap();
    assert_eq!(fresh.dialect(), QoderDialect::Prepared);
    assert_eq!(
        fresh.endpoint().as_str(),
        "http://127.0.0.1:1/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
    );
}
#[test]
fn nonempty_persisted_options_select_prepared_but_empty_or_null_options_keep_legacy() {
    for options in [
        json!([]),
        Value::Null,
        json!([{"id":"contextTier","kind":"select","choices":[]}]),
    ] {
        let mut f = Fixture::new();
        f.config["models"][0]["model"] = json!("unknown-model");
        f.config["models"][0]["modelOptions"] = options.clone();
        std::fs::write(
            f.root.path().join("llm-providers.json"),
            f.config.to_string(),
        )
        .unwrap();
        let account = f.load().unwrap();
        assert_eq!(
            account.dialect(),
            if options.as_array().is_some_and(|a| !a.is_empty()) {
                QoderDialect::Prepared
            } else {
                QoderDialect::Legacy
            }
        );
    }
}
#[test]
fn default_legacy_host_follows_captured_environment_and_rejects_url_credentials() {
    let f = Fixture::new();
    let mut env = f.env();
    for (name, value) in [
        ("QODER_ENV", "test"),
        ("QODER_MODEL_SERVER_HOST", "https://host.fixture.invalid/"),
    ] {
        env.0[ENV_NAMES.iter().position(|v| *v == name).unwrap()] =
            Some(Zeroizing::new(value.into()));
        let endpoint = super::super::endpoint::legacy(&env, None).unwrap();
        assert_eq!(
            endpoint.as_str(),
            if name == "QODER_ENV" {
                "https://test-api2-v2.qoder.sh/model/v1/chat/completions"
            } else {
                "https://host.fixture.invalid/model/v1/chat/completions"
            }
        );
    }
    env.0[ENV_NAMES
        .iter()
        .position(|v| *v == "QODER_MODEL_SERVER_HOST")
        .unwrap()] = Some(Zeroizing::new("user:secret@host.fixture.invalid".into()));
    assert_eq!(
        super::super::endpoint::legacy(&env, None)
            .err()
            .unwrap()
            .code,
        "model_endpoint_invalid"
    );
}
#[test]
fn catalog_and_endpoint_identity_changes_invalidate_the_prepared_account() {
    let f = Fixture::new();
    let account = f.load().unwrap();
    std::fs::write(
        f.root.path().join("qoder/.auth/models"),
        r#"{"chat":[{"key":"auto","max_input_tokens":1234}]}"#,
    )
    .unwrap();
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap())
            .unwrap_err()
            .code,
        "qoder_auth_changed"
    );
    let mut env = f.env();
    env.0[ENV_NAMES
        .iter()
        .position(|v| *v == "QODER_INFERENCE_ENDPOINT")
        .unwrap()] = None;
    let account = f.load_env(env, &CancellationToken::new()).unwrap();
    std::fs::create_dir_all(f.root.path().join("qoder/.cache")).unwrap();
    std::fs::write(
        f.root.path().join("qoder/.cache/endpoint-cache.json"),
        r#"{"entries":{"prod":{"endpoint":"http://127.0.0.1:1"}}}"#,
    )
    .unwrap();
    assert_eq!(
        account
            .validate_source(&CancellationToken::new(), now().unwrap())
            .unwrap_err()
            .code,
        "qoder_auth_changed"
    );
}
