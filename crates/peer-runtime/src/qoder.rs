//! Native Qoder data formats. No third-party process, VM, file writes or grants.
//! These are preparation primitives; a decoded credential is not a login proof.
mod cryptography;
mod transport_encoding;
pub use cryptography::{CacheFormat, DecodedCache, decrypt_cache, decrypt_credential};
pub use transport_encoding::{decode_body, encode_body};
use zeroize::Zeroizing;

pub const CREDENTIAL_LIMIT: usize = 1024 * 1024;
pub const CACHE_LIMIT: usize = 4 * 1024 * 1024;
pub const BODY_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatError {
    Limit,
    Encoding,
    Key,
    Cipher,
    Utf8,
    Version,
}
impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Limit => "qoder_data_limit",
            Self::Encoding => "qoder_data_encoding",
            Self::Key => "qoder_data_key",
            Self::Cipher => "qoder_data_cipher",
            Self::Utf8 => "qoder_data_utf8",
            Self::Version => "qoder_data_version",
        })
    }
}
impl std::error::Error for FormatError {}

/// The one owned plaintext allocation. Intentionally no Debug/Display/Clone.
pub struct PrivateText(Zeroizing<Vec<u8>>);
impl PrivateText {
    fn new(bytes: Zeroizing<Vec<u8>>) -> Result<Self, FormatError> {
        std::str::from_utf8(&bytes).map_err(|_| FormatError::Utf8)?;
        Ok(Self(bytes))
    }
    pub fn expose(&self) -> &str {
        std::str::from_utf8(&self.0).expect("validated immutable UTF-8")
    }
}
