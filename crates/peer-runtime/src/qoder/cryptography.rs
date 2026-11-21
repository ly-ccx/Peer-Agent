use super::{CACHE_LIMIT, CREDENTIAL_LIMIT, FormatError, PrivateText};
use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{AeadInPlace, KeyInit},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheFormat {
    PlainText,
    LegacyBase64,
    GcmV1,
}
pub struct DecodedCache {
    pub format: CacheFormat,
    pub text: PrivateText,
}

/// Qoder's pre-existing CBC format is unauthenticated. The caller must validate
/// account identity, expiry and field types; successful padding is no proof.
pub fn decrypt_credential(encoded: &str, key: &[u8]) -> Result<PrivateText, FormatError> {
    if encoded.len() > CREDENTIAL_LIMIT {
        return Err(FormatError::Limit);
    }
    if key.len() != 16 {
        return Err(FormatError::Key);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    STANDARD
        .decode_vec(encoded, &mut bytes)
        .map_err(|_| FormatError::Encoding)?;
    if bytes.is_empty() || !bytes.len().is_multiple_of(16) {
        return Err(FormatError::Cipher);
    }
    let cipher =
        cbc::Decryptor::<aes::Aes128>::new_from_slices(key, key).map_err(|_| FormatError::Key)?;
    let length = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut bytes)
        .map_err(|_| FormatError::Cipher)?
        .len();
    bytes.truncate(length);
    PrivateText::new(bytes)
}

/// Legacy text/base64 carriers are not authenticated. Catalog schema validation
/// belongs to the catalog adapter, independently of this format observation.
pub fn decrypt_cache(encoded: &str, uid: &[u8]) -> Result<DecodedCache, FormatError> {
    if encoded.len() > CACHE_LIMIT || uid.len() > 4096 {
        return Err(FormatError::Limit);
    }
    let trimmed = peer_protocol::javascript_trim(encoded);
    if encoded.is_empty() {
        return Err(FormatError::Encoding);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    let mut format = if STANDARD.decode_vec(trimmed, &mut bytes).is_ok() {
        CacheFormat::LegacyBase64
    } else {
        bytes.zeroize();
        bytes.extend_from_slice(encoded.as_bytes());
        CacheFormat::PlainText
    };
    if bytes.starts_with(b"QMC") {
        if bytes.get(3) != Some(&1) {
            return Err(FormatError::Version);
        }
        if bytes.len() <= 4 + 12 + 16 {
            return Err(FormatError::Cipher);
        }
        let nonce: [u8; 12] = bytes[4..16].try_into().expect("checked nonce length");
        let mut key = Zeroizing::new([0u8; 32]);
        hkdf::Hkdf::<Sha256>::new(Some(b"qoder-model-cache-enc"), uid)
            .expand(b"model-cache-v1", &mut *key)
            .map_err(|_| FormatError::Key)?;
        let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| FormatError::Key)?;
        let length = bytes.len() - 16;
        bytes.copy_within(16.., 0);
        bytes.truncate(length);
        cipher
            .decrypt_in_place(Nonce::from_slice(&nonce), b"", &mut *bytes)
            .map_err(|_| FormatError::Cipher)?;
        format = CacheFormat::GcmV1;
    }
    Ok(DecodedCache {
        format,
        text: PrivateText::new(bytes)?,
    })
}
