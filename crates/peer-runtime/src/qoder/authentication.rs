//! Compatibility with Qoder's existing COSY protocol, never Peer permission.
use super::sensitive_json::SensitiveJson;
use crate::model::ModelError;
use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::{Engine, engine::general_purpose::STANDARD};
use md5::{Digest, Md5};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rsa::{PublicKey, pkcs8::DecodePublicKey};
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

pub(super) const VERSION: &str = "1.0.39";
pub(super) const API_PATH: &str = "/api/v2/service/pro/sse/agent_chat_generation";
pub(crate) const INFER_PATH: &str = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
pub(super) struct Fields {
    info: Zeroizing<String>,
    key: Zeroizing<String>,
}
fn invalid() -> ModelError {
    ModelError::new("qoder_auth_invalid")
}
fn public_key() -> Result<PublicKey, ModelError> {
    PublicKey::from_public_key_pem(include_str!("inference-public.pem")).map_err(|_| invalid())
}
impl Fields {
    pub fn from_profile(profile: &Value) -> Result<Self, ModelError> {
        if let (Some(info), Some(key)) = (
            profile["encrypt_user_info"].as_str(),
            profile["key"].as_str(),
        ) && !info.is_empty()
            && !key.is_empty()
        {
            return Ok(Self {
                info: Zeroizing::new(info.into()),
                key: Zeroizing::new(key.into()),
            });
        }
        // Keep the current TS serialization order, including only present fields.
        let mut identity = SensitiveJson(serde_json::json!({}));
        for name in [
            "uid",
            "organization_id",
            "organization_tags",
            "data_policy_agreed",
        ] {
            if let Some(value) = profile.get(name) {
                identity.0[name] = value.clone();
            }
        }
        let plain = Zeroizing::new(serde_json::to_vec(&identity.0).map_err(|_| invalid())?);
        let mut random = Zeroizing::new([0u8; 16]);
        getrandom::fill(&mut *random)
            .map_err(|_| ModelError::new("qoder_auth_random_unavailable"))?;
        let id = uuid::Builder::from_random_bytes(*random).into_uuid();
        let simple = Zeroizing::new(id.simple().to_string());
        let key = Zeroizing::new(simple.as_bytes()[..16].to_vec());
        let encrypted_key = public_key()?
            .pkcs1v15_encrypt(&key)
            .map_err(|_| invalid())?;
        Self::encrypt(&plain, &key, encrypted_key)
    }
    fn encrypt(plain: &[u8], key: &[u8], encrypted_key: Vec<u8>) -> Result<Self, ModelError> {
        let length = plain.len();
        let mut buffer = Zeroizing::new(Vec::with_capacity(length + 16));
        buffer.extend_from_slice(plain);
        buffer.resize(length + 16, 0);
        let cipher =
            cbc::Encryptor::<aes::Aes128>::new_from_slices(key, key).map_err(|_| invalid())?;
        let encrypted = cipher
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, length)
            .map_err(|_| invalid())?;
        Ok(Self {
            info: Zeroizing::new(STANDARD.encode(encrypted)),
            key: Zeroizing::new(STANDARD.encode(encrypted_key)),
        })
    }
}
pub(super) struct Runtime {
    pub client: String,
    pub product: String,
    pub business: String,
    pub scene: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    version: &'a str,
    request_id: &'a str,
    info: &'a str,
    cosy_version: &'a str,
    ide_version: &'a str,
}

pub(super) struct Request<'a> {
    pub profile: &'a Value,
    pub machine: &'a str,
    pub fields: &'a Fields,
    pub runtime: &'a Runtime,
    pub model: &'a str,
    pub source: &'a str,
    pub encoded: &'a [u8],
}
impl Request<'_> {
    pub fn headers(&self, now: u64) -> Result<HeaderMap, ModelError> {
        self.headers_for(now, &uuid::Uuid::new_v4().to_string())
    }
    fn headers_for(&self, now: u64, request_id: &str) -> Result<HeaderMap, ModelError> {
        let envelope = Zeroizing::new(
            serde_json::to_vec(&Envelope {
                version: "v1",
                request_id,
                info: &self.fields.info,
                cosy_version: VERSION,
                ide_version: "",
            })
            .map_err(|_| invalid())?,
        );
        let envelope = Zeroizing::new(STANDARD.encode(&*envelope));
        let date = now.to_string();
        let mut digest = Md5::new();
        for (index, part) in [
            envelope.as_bytes(),
            self.fields.key.as_bytes(),
            date.as_bytes(),
            self.encoded,
            API_PATH.as_bytes(),
        ]
        .iter()
        .enumerate()
        {
            if index > 0 {
                digest.update(b"\n");
            }
            digest.update(part);
        }
        let authorization =
            Zeroizing::new(format!("Bearer COSY.{}.{:x}", *envelope, digest.finalize()));
        let mut headers = HeaderMap::new();
        let mut insert = |name: &'static str, value: &str| -> Result<(), ModelError> {
            if value.len() > 8192 {
                return Err(invalid());
            }
            let mut value = HeaderValue::from_str(value).map_err(|_| invalid())?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_static(name), value);
            Ok(())
        };
        for (name, value) in [
            ("authorization", authorization.as_str()),
            ("cache-control", "no-cache"),
            ("cosy-business-product", self.runtime.product.as_str()),
            ("cosy-business-type", self.runtime.business.as_str()),
            ("cosy-clienttype", self.runtime.client.as_str()),
            ("cosy-scene", self.runtime.scene.as_str()),
            ("cosy-date", date.as_str()),
            ("cosy-key", self.fields.key.as_str()),
            ("cosy-machineid", self.machine),
            ("cosy-machinetoken", self.machine),
            ("cosy-machinetype", "5"),
            ("cosy-version", VERSION),
            ("login-version", "v2"),
            ("x-model-key", self.model),
            ("x-model-source", self.source),
            (
                "cosy-user",
                self.profile["uid"].as_str().ok_or_else(invalid)?,
            ),
            (
                "cosy-data-policy",
                if self.profile["data_policy_agreed"] == true {
                    "agree"
                } else {
                    "disagree"
                },
            ),
        ] {
            insert(name, value)?;
        }
        if let Some(org) = self.profile["organization_id"]
            .as_str()
            .filter(|v| !v.is_empty())
        {
            insert("cosy-organization-id", org)?;
        }
        if let Some(tags) = self.profile["organization_tags"]
            .as_array()
            .filter(|v| !v.is_empty())
        {
            let tags = Zeroizing::new(
                tags.iter()
                    .map(|v| v.as_str().ok_or_else(invalid))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(","),
            );
            insert("cosy-organization-tags", &tags)?;
        }
        Ok(headers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixed;
    impl rsa::rand_core::TryRng for Fixed {
        type Error = std::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(u32::from_le_bytes([7; 4]))
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            Ok(u64::from_le_bytes([7; 8]))
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            dst.fill(7);
            Ok(())
        }
    }
    impl rsa::rand_core::TryCryptoRng for Fixed {}
    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/qoder-requests.json"
        ))
        .unwrap()
    }
    #[test]
    fn runtime_fields_match_rng_only_official_sdk_oracle() {
        for case in fixtures()["fields"].as_array().unwrap() {
            let key = b"0707070707074707";
            let encrypted = public_key()
                .unwrap()
                .pkcs1v15_encrypt_with_rng(&mut Fixed, key)
                .unwrap();
            let fields =
                Fields::encrypt(case["plain"].as_str().unwrap().as_bytes(), key, encrypted)
                    .unwrap();
            assert_eq!(
                fields.info.as_str(),
                case["expected"]["encrypt_user_info"].as_str().unwrap()
            );
            assert_eq!(
                fields.key.as_str(),
                case["expected"]["key"].as_str().unwrap()
            );
        }
    }
    #[test]
    fn cosy_headers_match_unmodified_official_sdk_with_encoded_body_and_independent_uuid() {
        for case in fixtures()["authentication"].as_array().unwrap() {
            let fields = Fields::from_profile(&case["profile"]).unwrap();
            let runtime = Runtime {
                client: "5".into(),
                product: "cli".into(),
                business: "agent".into(),
                scene: "assistant".into(),
            };
            let request = Request {
                profile: &case["profile"],
                machine: case["machine"].as_str().unwrap(),
                fields: &fields,
                runtime: &runtime,
                model: "auto",
                source: "system",
                encoded: case["encoded"].as_str().unwrap().as_bytes(),
            };
            let headers = request
                .headers_for(
                    case["date"].as_u64().unwrap(),
                    case["authRequestId"].as_str().unwrap(),
                )
                .unwrap();
            for (key, value) in case["headers"].as_object().unwrap() {
                if ["Accept", "Connection", "Content-Type"].contains(&key.as_str()) {
                    continue;
                }
                let actual = &headers[key.to_lowercase()];
                assert_eq!(actual.to_str().unwrap(), value.as_str().unwrap(), "{key}");
                assert!(actual.is_sensitive());
            }
            let plain = case["body"].as_str().unwrap().as_bytes();
            let wrong = Request {
                encoded: plain,
                ..request
            }
            .headers_for(
                case["date"].as_u64().unwrap(),
                case["authRequestId"].as_str().unwrap(),
            )
            .unwrap();
            assert_ne!(headers["authorization"], wrong["authorization"]);
        }
    }
    #[test]
    fn missing_runtime_fields_use_fresh_os_randomness_without_changing_the_profile() {
        let profile = serde_json::json!({"uid":"fixture","security_oauth_token":"SYNTHETIC"});
        let original = profile.clone();
        let first = Fields::from_profile(&profile).unwrap();
        let second = Fields::from_profile(&profile).unwrap();
        assert_ne!(first.info, second.info);
        assert_ne!(first.key, second.key);
        assert_eq!(profile, original);
        assert_eq!(STANDARD.decode(&*first.key).unwrap().len(), 128);
    }
}
