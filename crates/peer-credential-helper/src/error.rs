use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum HelperError {
    #[error("secure storage is unavailable")]
    SecureStorageUnavailable,
    #[error("the credential vault master key is missing")]
    MasterKeyMissing,
    #[error("the credential vault master key is invalid")]
    MasterKeyInvalid,
    #[error("the credential vault is unavailable")]
    VaultIo(#[source] io::Error),
    #[error("the credential vault is invalid")]
    VaultInvalid,
    #[error("the credential vault failed authentication")]
    VaultAuthenticationFailed,
    #[error("the credential helper request is invalid")]
    InvalidRequest,
}

impl HelperError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SecureStorageUnavailable => "secure_storage_unavailable",
            Self::MasterKeyMissing => "vault_master_key_missing",
            Self::MasterKeyInvalid => "vault_master_key_invalid",
            Self::VaultIo(_) => "credential_vault_unavailable",
            Self::VaultInvalid => "credential_vault_invalid",
            Self::VaultAuthenticationFailed => "credential_vault_authentication_failed",
            Self::InvalidRequest => "credential_request_invalid",
        }
    }

    pub fn public_message(&self) -> &'static str {
        match self {
            Self::SecureStorageUnavailable => {
                "The operating system secure credential store is unavailable."
            }
            Self::MasterKeyMissing => {
                "The credential vault exists but its protected master key is missing."
            }
            Self::MasterKeyInvalid => "The protected credential vault master key is invalid.",
            Self::VaultIo(_) => "The credential vault could not be accessed safely.",
            Self::VaultInvalid => "The credential vault format is invalid.",
            Self::VaultAuthenticationFailed => {
                "The credential vault failed integrity verification."
            }
            Self::InvalidRequest => "The credential helper request is invalid.",
        }
    }
}

impl From<io::Error> for HelperError {
    fn from(error: io::Error) -> Self {
        Self::VaultIo(error)
    }
}

pub type Result<T> = std::result::Result<T, HelperError>;
