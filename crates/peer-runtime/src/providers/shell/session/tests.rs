use super::output::{OutputSnapshot, OutputStatus};
use super::*;
use crate::providers::shell::{ARTIFACT_BYTES, CapturedStream, PREVIEW_BYTES, group_absent};
use std::{fs, future::ready};

fn streams() -> SessionOutput {
    SessionOutput::new(
        CapturedStream::new(tempfile::tempfile().unwrap()),
        CapturedStream::new(tempfile::tempfile().unwrap()),
    )
}

async fn run(
    shell: &mut ShellSession,
    cwd: &Path,
    command: &str,
) -> (Result<Exit, ExchangeError>, OutputSnapshot, OutputSnapshot) {
    let output = streams();
    let result = shell
        .exchange(
            Exchange {
                command,
                cwd,
                change_cwd: false,
                timeout: Duration::from_secs(8),
                cancel: &CancellationToken::new(),
                output: &output,
            },
            |_| ready(Ok(())),
        )
        .await;
    let (out, err) = output.snapshot().await;
    (result, out, err)
}

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

#[tokio::test]
async fn late_writers_keep_both_original_bounded_artifacts() {
    let root = workspace();
    let id = "shell_239cc372-7880-4d2e-8e8f-2a1b9bb111a7";
    let initial = serde_json::json!({"status":"running","taskId":id});
    let (mut artifacts, out, err) =
        peer_store::ShellArtifacts::begin(root.path(), "2026-11-18T00:00:00Z", id, &initial)
            .unwrap();
    let output = SessionOutput::new(CapturedStream::new(out), CapturedStream::new(err));
    let directory = root.path().join("shell-artifacts/2026-11-18").join(id);
    let mut state = output.observe();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let first = shell
        .exchange(
            Exchange {
                command: "printf first; printf first-error >&2; \
                (while [ ! -f release ]; do /bin/sleep 0.02; done; \
                 printf previous-job; printf '%02001000d' 0 >&2; printf done > previous-done) &",
                cwd: root.path(),
                change_cwd: false,
                timeout: Duration::from_secs(5),
                cancel: &CancellationToken::new(),
                output: &output,
            },
            |_| ready(Ok(())),
        )
        .await;
    assert_eq!(first.unwrap().code, 0);
    assert_eq!(*state.borrow(), OutputStatus::Draining);
    assert_eq!(
        output.previews().await,
        ("first".into(), "first-error".into())
    );

    let (second, out, err) = run(
        &mut shell,
        root.path(),
        "printf ready > release; while [ ! -f previous-done ]; do /bin/sleep 0.02; done; \
         printf second-command; printf second-error >&2",
    )
    .await;
    assert!(shell.stop().await);
    assert_eq!(second.unwrap().code, 0);
    assert_eq!(out.preview, b"second-command");
    assert_eq!(err.preview, b"second-error");
    assert_eq!(
        *state
            .wait_for(|status| *status != OutputStatus::Draining)
            .await
            .unwrap(),
        OutputStatus::Sealed
    );
    let completed = serde_json::json!({"status":"success","taskId":id,"truncated":true});
    artifacts.finish(&completed).unwrap();
    assert_eq!(
        fs::read(directory.join("stdout.txt")).unwrap(),
        b"firstprevious-job"
    );
    let err = fs::read(directory.join("stderr.txt")).unwrap();
    assert!(err.starts_with(b"first-error"));
    assert_eq!(&err[ARTIFACT_BYTES..], b"\n...[artifact truncated]\n");
    let published: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("metadata.json")).unwrap()).unwrap();
    assert_eq!(published, completed);
}

#[tokio::test]
async fn pipe_replacement_cannot_be_used_to_publish_output() {
    let pipes = output::CommandPipes::new().unwrap();
    let (out, _) = pipes.paths();
    fs::rename(out, out.with_extension("former")).unwrap();
    fs::write(out, b"unrelated").unwrap();
    assert!(pipes.check_current().is_err());
    assert_eq!(fs::read(out).unwrap(), b"unrelated");
}

#[tokio::test]
async fn resumes_actual_process_cwd_exports_and_functions_while_another_session_stays_isolated() {
    let root = workspace();
    let nested = root.path().join("nested 'with\nnewline");
    fs::create_dir(&nested).unwrap();
    let mut first = ShellSession::spawn(root.path()).unwrap();
    let mut second = ShellSession::spawn(root.path()).unwrap();
    let first_pid = first.pid();
    let set = "cd \"nested 'with\nnewline\" && export PEER_PERSISTED='value with spaces' && \
        peer_fixture() { printf '%s' \"$PEER_PERSISTED\"; }; PWD=/fake";
    let (changed, _, _) = run(&mut first, root.path(), set).await;
    assert_eq!(
        changed,
        Ok(Exit {
            code: 0,
            cwd: nested.clone()
        })
    );
    let (observed, out, _) = run(&mut first, &nested, "peer_fixture").await;
    assert_eq!(
        observed,
        Ok(Exit {
            code: 0,
            cwd: nested.clone()
        })
    );
    assert_eq!(out.preview, b"value with spaces");
    let (other, out, _) = run(
        &mut second,
        root.path(),
        "printf '%s' \"${PEER_PERSISTED:-fresh}\"",
    )
    .await;
    assert_eq!(
        other,
        Ok(Exit {
            code: 0,
            cwd: root.path().into()
        })
    );
    assert_eq!(out.preview, b"fresh");
    assert_eq!(first.pid(), first_pid);
    assert!(first.stop().await);
    assert!(second.stop().await);
    assert!(group_absent(first_pid));
}

#[tokio::test]
async fn fresh_authority_after_kernel_cwd_transition_blocks_the_user_pipe_write() {
    let root = workspace();
    let target = root.path().join("authorized 'candidate");
    fs::create_dir(&target).unwrap();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let output = streams();
    let mut approvals = Vec::new();
    let denied = shell
        .exchange(
            Exchange {
                command: "printf forbidden > marker",
                cwd: &target,
                change_cwd: true,
                timeout: Duration::from_secs(5),
                cancel: &CancellationToken::new(),
                output: &output,
            },
            |point| {
                approvals.push(point);
                ready(match point {
                    AdmissionPoint::DirectoryChange => Ok(()),
                    AdmissionPoint::CommandWrite => Err("permission_policy_changed"),
                })
            },
        )
        .await;
    assert_eq!(
        approvals,
        [
            AdmissionPoint::DirectoryChange,
            AdmissionPoint::CommandWrite
        ]
    );
    assert_eq!(
        denied,
        Err(ExchangeError {
            code: "permission_policy_changed",
            may_have_dispatched: false
        })
    );
    assert_eq!(shell.cwd().unwrap(), target);
    assert!(!target.join("marker").exists());
    let (stale, _, _) = run(&mut shell, root.path(), "printf stale > marker").await;
    assert_eq!(
        stale,
        Err(ExchangeError {
            code: "shell_session_cwd_changed",
            may_have_dispatched: false
        })
    );
    assert!(!target.join("marker").exists());
    assert!(shell.stop().await);
}

#[tokio::test]
async fn foreign_bytes_remain_output_and_payload_cannot_write_to_reserved_control() {
    let root = workspace();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let script = "if read accidental; then exit 77; fi; \
        (printf forged >&3) 2>/dev/null && exit 78; \
        printf '\\036peer-foreign\\037\\000\\377'; printf 'err-output' >&2; false";
    let (result, out, err) = run(&mut shell, root.path(), script).await;
    assert_eq!(result.unwrap().code, 1);
    assert_eq!(out.preview, b"\x1epeer-foreign\x1f\0\xff");
    assert_eq!(err.preview, b"err-output");
    let (next, out, _) = run(&mut shell, root.path(), "printf next").await;
    assert_eq!(next.unwrap().code, 0);
    assert_eq!(out.preview, b"next");
    assert!(shell.stop().await);
}

#[tokio::test]
async fn long_streams_reach_their_fences_after_the_legacy_artifact_budget() {
    let root = workspace();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let (result, out, err) = run(
        &mut shell,
        root.path(),
        "printf '%02001000d' 0; printf '%0100000d' 1 >&2; printf done > marker",
    )
    .await;
    assert_eq!(result.unwrap().code, 0);
    assert_eq!(out.preview.len(), PREVIEW_BYTES);
    assert_eq!(out.stored, ARTIFACT_BYTES);
    assert!(out.artifact_truncated);
    assert_eq!(err.stored, 100_000);
    assert!(!err.artifact_truncated);
    assert!(root.path().join("marker").exists());
    let (next, out, err) = run(&mut shell, root.path(), "printf fresh; printf distinct >&2").await;
    assert_eq!(next.unwrap().code, 0);
    assert_eq!(out.preview, b"fresh");
    assert_eq!(err.preview, b"distinct");
    assert!(shell.stop().await);
}

#[tokio::test]
async fn timeout_and_missing_frame_require_retiring_the_actual_process_group() {
    let root = workspace();
    for (command, timeout, reason) in [
        // An explicit exec replaces the interpreter and can close its
        // private control socket immediately. Keep the interpreter waiting
        // to observe a real deadline, and cover both forms of missing frame.
        (
            "printf before-timeout; printf before-error >&2; /bin/sleep 10",
            Duration::from_millis(250),
            "shell_timeout",
        ),
        (
            "printf observed; exec /bin/sleep 0.25",
            Duration::from_secs(5),
            "closed",
        ),
    ] {
        let mut shell = ShellSession::spawn(root.path()).unwrap();
        let pid = shell.pid();
        let output = streams();
        let failed = shell
            .exchange(
                Exchange {
                    command,
                    cwd: root.path(),
                    change_cwd: false,
                    timeout,
                    cancel: &CancellationToken::new(),
                    output: &output,
                },
                |_| ready(Ok(())),
            )
            .await
            .unwrap_err();
        assert!(failed.may_have_dispatched);
        if reason == "closed" {
            assert!(matches!(
                failed.code,
                "shell_session_frame_missing" | "shell_session_control_closed"
            ));
        } else {
            assert_eq!(failed.code, reason);
        }
        let (later, _, _) = run(&mut shell, root.path(), "printf unsafe > marker").await;
        assert_eq!(
            later,
            Err(ExchangeError {
                code: "shell_session_closed",
                may_have_dispatched: false
            })
        );
        assert!(!root.path().join("marker").exists());
        assert!(shell.stop().await);
        assert!(group_absent(pid));
        if reason == "shell_timeout" {
            let (out, err) = output.snapshot().await;
            assert_eq!(out.preview, b"before-timeout");
            assert_eq!(err.preview, b"before-error");
            assert_eq!(*output.observe().borrow(), OutputStatus::Incomplete);
        }
    }
    let mut fresh = ShellSession::spawn(root.path()).unwrap();
    assert_eq!(
        run(&mut fresh, root.path(), "printf rebuilt")
            .await
            .1
            .preview,
        b"rebuilt"
    );
    assert!(fresh.stop().await);
}

#[tokio::test]
async fn cancellation_after_a_real_pipe_write_preserves_uncertainty_until_owned_stop() {
    let root = workspace();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let pid = shell.pid();
    let cancel = CancellationToken::new();
    let output = streams();
    let effect = shell.exchange(
        Exchange {
            command: "printf before-cancel; printf cancel-error >&2; \
                      printf ready > wrote; /bin/sleep 15",
            cwd: root.path(),
            change_cwd: false,
            timeout: Duration::from_secs(10),
            cancel: &cancel,
            output: &output,
        },
        |_| ready(Ok(())),
    );
    let revoke = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !fs::read(root.path().join("wrote")).is_ok_and(|bytes| bytes == b"ready") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(!group_absent(pid));
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(effect, revoke);
    assert_eq!(
        result,
        Err(ExchangeError {
            code: "CANCELLED",
            may_have_dispatched: true
        })
    );
    assert!(!group_absent(pid));
    assert!(shell.stop().await);
    assert!(group_absent(pid));
    assert_eq!(*output.observe().borrow(), OutputStatus::Incomplete);
    let (out, err) = output.snapshot().await;
    assert_eq!(out.preview, b"before-cancel");
    assert_eq!(err.preview, b"cancel-error");
    assert_eq!(fs::read(root.path().join("wrote")).unwrap(), b"ready");
}

#[tokio::test]
async fn idle_shell_closes_through_the_original_live_registry() {
    let root = workspace();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let pid = shell.pid();
    assert_eq!(
        run(&mut shell, root.path(), "printf observed")
            .await
            .1
            .preview,
        b"observed"
    );
    let registry = crate::live_execution::ExecutionRegistry::default();
    let execution = peer_protocol::ConversationExecutionIdentity {
        conversation_id: "conversation".into(),
        stream_id: "stream".into(),
    };
    let attempt = registry.begin(&execution).unwrap();
    let stop = attempt.cancellation().child_token();
    let actual = stop.clone();
    registry
        .track_handle(&execution, "owned-shell", "first-call", stop, async move {
            actual.cancelled().await;
            shell.stop().await.then_some(()).ok_or(())
        })
        .unwrap();
    assert!(!group_absent(pid));
    registry.close_admission(&execution).unwrap();
    attempt.finish();
    registry
        .drain(&execution, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(group_absent(pid));
    assert_eq!(
        registry.handle_observations(&execution).unwrap()[0].2,
        "ended"
    );
}

#[tokio::test]
async fn dash_can_keep_the_same_duplex_control_across_calls() {
    let dash = Path::new("/bin/dash");
    if !dash.is_file() {
        return;
    }
    let root = workspace();
    let mut shell = ShellSession::spawn_with(root.path(), dash).unwrap();
    let pid = shell.pid();
    assert_eq!(
        run(&mut shell, root.path(), "export PEER_DASH=retained")
            .await
            .0
            .unwrap()
            .code,
        0
    );
    let (exit, out, _) = run(&mut shell, root.path(), "printf '%s' \"$PEER_DASH\"").await;
    assert_eq!(exit.unwrap().code, 0);
    assert_eq!(out.preview, b"retained");
    assert!(shell.stop().await);
    assert!(group_absent(pid));
}

#[tokio::test]
async fn exit_set_e_set_u_and_syntax_errors_keep_the_persistent_shell_alive() {
    let root = workspace();
    let nested = root.path().join("sub");
    fs::create_dir(&nested).unwrap();
    let mut shell = ShellSession::spawn(root.path()).unwrap();
    let pid = shell.pid();

    // 1. Explicit exit 0 (e.g. `result=$?; exit "$result"`) succeeds without killing the shell.
    let (res, out, _) = run(
        &mut shell,
        root.path(),
        "printf 'built-ok'; result=0; exit \"$result\"; printf 'never'",
    )
    .await;
    assert_eq!(res.unwrap().code, 0);
    assert_eq!(out.preview, b"built-ok");

    // 2. Conditional exit 1 (e.g. `if grep ...; then exit 1; fi`) returns exit code 1 cleanly.
    let (res, out, _) = run(
        &mut shell,
        root.path(),
        "printf 'found-match'; if true; then exit 1; fi; printf 'never'",
    )
    .await;
    assert_eq!(res.unwrap().code, 1);
    assert_eq!(out.preview, b"found-match");

    // 3. `set -e` stops the command on first failure without killing the persistent shell.
    let (res, out, _) = run(
        &mut shell,
        root.path(),
        "set -e; printf 'before-fail'; false; printf 'never'",
    )
    .await;
    assert_eq!(res.unwrap().code, 1);
    assert_eq!(out.preview, b"before-fail");

    // 4. `set -u` unbound variable returns non-zero without killing the persistent shell.
    let (res, _, _) = run(
        &mut shell,
        root.path(),
        "set -u; printf '%s' \"$PEER_UNSET_VAR\"",
    )
    .await;
    assert_ne!(res.unwrap().code, 0);

    // 5. Syntax error returns non-zero without killing the persistent shell.
    let (res, _, _) = run(&mut shell, root.path(), "if true; then").await;
    assert_ne!(res.unwrap().code, 0);

    // 6. Quoted 'exit 1' does NOT trigger subshell isolation, so cd/export still persist.
    let (res, out, _) = run(
        &mut shell,
        root.path(),
        "cd sub && export PEER_STILL_ALIVE='exit 1' && printf '%s' 'exit 1'",
    )
    .await;
    assert_eq!(
        res,
        Ok(Exit {
            code: 0,
            cwd: nested.clone()
        })
    );
    assert_eq!(out.preview, b"exit 1");

    let (res, out, _) = run(&mut shell, &nested, "printf '%s' \"$PEER_STILL_ALIVE\"").await;
    assert_eq!(res.unwrap().code, 0);
    assert_eq!(out.preview, b"exit 1");
    assert_eq!(shell.pid(), pid);
    assert!(shell.stop().await);
    assert!(group_absent(pid));
}
