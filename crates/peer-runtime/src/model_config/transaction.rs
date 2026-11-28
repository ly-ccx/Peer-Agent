//! Cooperative config -> Helper ordering. Network/browser waits never own this
//! guard. Zero-wait attempts keep cancellation responsive without worker leaks.
use super::{CancellationToken, ModelError};
use peer_store::{ModelConfigStore, ModelConfigTransaction, StoreError};
use std::{path::Path, time::Duration};
pub(crate) async fn acquire(
    home: &Path,
    cancel: &CancellationToken,
) -> Result<ModelConfigTransaction, ModelError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let store = ModelConfigStore::new(home);
    loop {
        if cancel.is_cancelled() {
            return Err(ModelError::new("CANCELLED"));
        }
        match store.begin(Duration::ZERO, None) {
            Ok(transaction) => return Ok(transaction),
            Err(StoreError::LockBusy) => (),
            Err(_) => return Err(ModelError::new("model_config_transaction_failed")),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ModelError::new("model_config_lock_busy"));
        }
        tokio::select! {biased;
            _=cancel.cancelled()=>return Err(ModelError::new("CANCELLED")),
            _=tokio::time::sleep_until((tokio::time::Instant::now()+Duration::from_millis(5)).min(deadline))=>(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn deadline_and_cancel_preserve_the_original_lock_and_later_admission() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("llm-providers.json");
        let held = peer_store::DirectoryLock::acquire(&file, Duration::ZERO, None).unwrap();
        let cancel = CancellationToken::new();
        let began = tokio::time::Instant::now();
        assert_eq!(
            acquire(home.path(), &cancel).await.err().unwrap().code,
            "model_config_lock_busy"
        );
        assert_eq!(began.elapsed(), Duration::from_secs(5));
        let waiting_cancel = CancellationToken::new();
        let waiting = acquire(home.path(), &waiting_cancel);
        tokio::pin!(waiting);
        tokio::select! {biased; result=&mut waiting=>panic!("unexpected lock admission: {}",result.err().unwrap().code),_=tokio::task::yield_now()=>()}
        waiting_cancel.cancel();
        assert_eq!(waiting.await.err().unwrap().code, "CANCELLED");
        cancel.cancel();
        assert_eq!(
            acquire(home.path(), &cancel).await.err().unwrap().code,
            "CANCELLED"
        );
        held.release().unwrap();
        acquire(home.path(), &CancellationToken::new())
            .await
            .unwrap()
            .finish()
            .unwrap();
        assert!(!file.with_extension("json.lock").exists());
    }
}
