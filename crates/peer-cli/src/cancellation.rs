//! Own signal registrations, cancellation watcher and runtime for native commands.
use peer_runtime::CancellationToken;
use std::{
    future::Future,
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
struct Signals(Vec<signal_hook::SigId>);
impl Drop for Signals {
    fn drop(&mut self) {
        for id in self.0.drain(..) {
            signal_hook::low_level::unregister(id);
        }
    }
}
pub(crate) fn run<T, F: Future<Output = T>>(
    operation: impl FnOnce(CancellationToken) -> F,
) -> io::Result<T> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let flag = Arc::new(AtomicBool::new(false));
    let mut signals = Signals(Vec::new());
    for signal in [
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ] {
        signals
            .0
            .push(signal_hook::flag::register(signal, flag.clone())?);
    }
    let result = runtime.block_on(async {
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let watcher = tokio::spawn(async move {
            loop {
                if flag.load(Ordering::Relaxed) {
                    stop.cancel();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        });
        let result = operation(cancel).await;
        watcher.abort();
        let _ = watcher.await;
        result
    });
    runtime.shutdown_timeout(Duration::from_secs(2));
    Ok(result)
}
