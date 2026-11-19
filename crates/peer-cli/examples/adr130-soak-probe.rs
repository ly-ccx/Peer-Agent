#![forbid(unsafe_code)]

//! ADR 130 Bounded Memory & Transcript Virtualization release-build probe.
//!
//! Exercises the real `TranscriptReader`, `ByteBudgetLru`, `render_markdown_bounded`,
//! `render_classic`, and `NativeProjectHost` crates across:
//! 1. 1,000-turn (>= 100 MiB) transcript with long code/diff blocks & scrolling
//! 2. 1 GiB history file containing a 10 MiB / 1,000,000-line single message
//! 3. 100 create/open/render/close session & NativeProjectHost cycles (FD & RSS check)
//! 4. Rolling soak iterations measuring RSS trajectory & linear regression slope

use peer_project_agent::NativeProjectHost;
use peer_protocol::TranscriptRow;
use peer_store::{TranscriptLimits, TranscriptReader};
use peer_tui::{
    ByteBudgetLru, ClassicMessage, ClassicOverlay, ClassicView, Composer, DARK_PALETTE,
    GoalMenuStatus, MARKDOWN_WRAP_CACHE_BYTES, ModelPickerState, ReadingAnchor, RenderedBlock,
    ThemeMode, TuiLocale, WrapCacheKey, render_classic,
};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::Path,
    process::Command,
    time::Instant,
};
use tempfile::tempdir;

fn current_rss_kib() -> u64 {
    let pid = std::process::id().to_string();
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    out.trim().parse::<u64>().unwrap_or(0)
}

fn open_fd_count() -> usize {
    #[cfg(target_os = "macos")]
    {
        fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0)
    }
    #[cfg(target_os = "linux")]
    {
        fs::read_dir("/proc/self/fd")
            .map(|d| d.count())
            .unwrap_or(0)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        0
    }
}

fn row_to_classic(row: TranscriptRow, idx: usize) -> ClassicMessage {
    match row {
        TranscriptRow::Message { raw, .. } => ClassicMessage {
            id: raw["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("row-{idx}")),
            revision: 1,
            role: raw["role"].as_str().unwrap_or("assistant").to_owned(),
            text: raw["content"].as_str().unwrap_or("").to_owned(),
        },
        _ => ClassicMessage {
            id: format!("other-{idx}"),
            revision: 1,
            role: "system".into(),
            text: "unreadable".into(),
        },
    }
}

fn write_conv_dir(home: &Path, conv_id: &str) -> std::path::PathBuf {
    let dir = home.join("conversations");
    fs::create_dir_all(&dir).unwrap();
    dir.join(format!("{conv_id}.jsonl"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let soak_secs: u64 = args
        .iter()
        .position(|a| a == "--soak-secs")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);

    let root = tempdir().unwrap();
    let home = root.path();

    // --- Scenario 1: 1,000 turns (>= 100 MiB total transcript) ---
    let conv_1k = "conv-1000-turns";
    let path_1k = write_conv_dir(home, conv_1k);
    let mut total_1k_bytes = 0u64;
    {
        let mut w = BufWriter::new(File::create(&path_1k).unwrap());
        let code_body = format!(
            "Turn analysis with code:\n```diff\n{}\n```\n",
            "+fn bounded_memory_line_payload_0123456789() -> usize { 42 }\n".repeat(1800)
        );
        for turn in 0..1000usize {
            let user_row = json!({
                "id": format!("u-{turn}"),
                "role": "user",
                "content": format!("Turn {turn}: inspect module and verify diff"),
                "createdAt": "2026-11-19T00:00:00.000Z"
            });
            let uline = format!("{user_row}\n");
            w.write_all(uline.as_bytes()).unwrap();
            total_1k_bytes += uline.len() as u64;

            let asst_row = json!({
                "id": format!("a-{turn}"),
                "role": "assistant",
                "content": format!("Turn {turn} summary:\n{code_body}"),
                "createdAt": "2026-11-19T00:00:01.000Z"
            });
            let aline = format!("{asst_row}\n");
            w.write_all(aline.as_bytes()).unwrap();
            total_1k_bytes += aline.len() as u64;
        }
        w.flush().unwrap();
    }

    let reader = TranscriptReader::new(home);
    let mut cache: ByteBudgetLru<WrapCacheKey, RenderedBlock> =
        ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 256);
    let composer = Composer::default();
    let picker = ModelPickerState::default();
    let mut anchor = ReadingAnchor::FollowingLatest;
    let mut term_wide = Terminal::new(TestBackend::new(120, 40)).unwrap();
    let mut term_narrow = Terminal::new(TestBackend::new(40, 16)).unwrap();

    let mut rss_1k_samples = Vec::new();
    let mut peak_1k_kib = current_rss_kib();
    let mut cursor = None;
    let mut pages_read = 0usize;
    let t1_start = Instant::now();
    loop {
        let page = reader
            .read_page(
                conv_1k,
                cursor.as_ref(),
                TranscriptLimits {
                    records: 16,
                    ..TranscriptLimits::default()
                },
                None,
            )
            .unwrap();
        let msgs: Vec<ClassicMessage> = page
            .rows
            .into_iter()
            .enumerate()
            .map(|(i, r)| row_to_classic(r, i))
            .collect();
        term_wide
            .draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/bench",
                        model_badge: "bench",
                        effort_badge: "default",
                        mode_badge: "chat",
                        access_badge: "session",
                        context_percent: Some(25),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_banner: None,
                        is_running: false,
                        activity_label: None,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "ok",
                        approval: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        pages_read += 1;
        if pages_read.is_multiple_of(10) {
            let rss = current_rss_kib();
            peak_1k_kib = peak_1k_kib.max(rss);
            rss_1k_samples.push(rss);
        }
        cursor = page.older;
        if cursor.is_none() || pages_read >= 120 {
            break;
        }
    }
    let steady_1k_kib = current_rss_kib();
    peak_1k_kib = peak_1k_kib.max(steady_1k_kib);
    let s1_ms = t1_start.elapsed().as_millis();

    // --- Scenario 2: 1 GiB history + 10 MiB / 1M-line single message ---
    let conv_1g = "conv-1gib-giant";
    let path_1g = write_conv_dir(home, conv_1g);
    let mut total_1g_bytes = 0u64;
    let mut giant_text = String::with_capacity(14 * 1024 * 1024);
    for line_i in 0..1_000_000usize {
        giant_text.push_str(&format!("line-{line_i:07}\n"));
    }
    let giant_text_bytes = giant_text.len();
    {
        let mut w = BufWriter::with_capacity(1024 * 1024, File::create(&path_1g).unwrap());
        let filler_line = format!(
            "{}\n",
            json!({
                "id": "hist-pad",
                "role": "assistant",
                "content": "P".repeat(250_000),
                "createdAt": "2026-11-19T00:00:00.000Z"
            })
        );
        // Write ~1.02 GiB of earlier transcript rows
        let target_bytes: u64 = 1040 * 1024 * 1024;
        while total_1g_bytes < target_bytes {
            w.write_all(filler_line.as_bytes()).unwrap();
            total_1g_bytes += filler_line.len() as u64;
        }
        // Append 4 normal tail messages so tail paging over a >1 GiB file can be measured directly
        for idx in 0..4usize {
            let tail_row = format!(
                "{}\n",
                json!({
                    "id": format!("tail-{idx}"),
                    "role": if idx % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("Tail message #{idx} after 1 GiB of archived history."),
                    "createdAt": "2026-11-19T00:59:00.000Z"
                })
            );
            w.write_all(tail_row.as_bytes()).unwrap();
            total_1g_bytes += tail_row.len() as u64;
        }
        w.flush().unwrap();
    }

    let t2_start = Instant::now();
    // 2a. Tail-only pagination on a >1 GiB JSONL file without loading the prefix.
    let page_1g_tail = reader
        .read_page(
            conv_1g,
            None,
            TranscriptLimits {
                records: 4,
                ..TranscriptLimits::default()
            },
            None,
        )
        .unwrap();
    let tail_scanned_bytes = page_1g_tail.scanned_bytes;
    let older_page = reader
        .read_page(
            conv_1g,
            page_1g_tail.older.as_ref(),
            TranscriptLimits {
                records: 2,
                ..TranscriptLimits::default()
            },
            None,
        )
        .unwrap();
    assert!(!older_page.rows.is_empty());

    // 2b. Append a 10+ MiB / 1,000,000-line single JSONL row and assert TranscriptReader
    // safely diagnoses LimitExceeded (RecordBytes) without loading the 1 GiB file.
    {
        let mut f = fs::OpenOptions::new().append(true).open(&path_1g).unwrap();
        let giant_row = format!(
            "{}\n",
            json!({
                "id": "giant-1m-lines",
                "role": "assistant",
                "content": &giant_text,
                "createdAt": "2026-11-19T01:00:00.000Z"
            })
        );
        f.write_all(giant_row.as_bytes()).unwrap();
        total_1g_bytes += giant_row.len() as u64;
    }
    let default_read = reader.read_page(
        conv_1g,
        None,
        TranscriptLimits {
            records: 8,
            ..TranscriptLimits::default()
        },
        None,
    );
    let diagnosed_record_limit = matches!(
        default_read,
        Err(peer_store::TranscriptError::LimitExceeded {
            kind: peer_store::TranscriptLimit::RecordBytes,
            ..
        })
    );

    // 2c. Render the 10+ MiB / 1,000,000-line single message directly through bounded TUI
    // chunked Markdown virtualization across wide and narrow viewports.
    let mut msgs_1g: Vec<ClassicMessage> = page_1g_tail
        .rows
        .into_iter()
        .enumerate()
        .map(|(i, r)| row_to_classic(r, i))
        .collect();
    msgs_1g.push(ClassicMessage {
        id: "giant-1m-lines".into(),
        role: "assistant".into(),
        text: giant_text,
        revision: 999_999,
    });
    for term in [&mut term_wide, &mut term_narrow] {
        term.draw(|f| {
            render_classic(
                f,
                ClassicView {
                    title: "Peer",
                    workspace_label: "~/bench",
                    model_badge: "bench",
                    effort_badge: "default",
                    mode_badge: "chat",
                    access_badge: "session",
                    context_percent: Some(50),
                    quota_label: None,
                    quota_remaining: None,
                    fast_mode: false,
                    fast_available: false,
                    goal_status: GoalMenuStatus::None,
                    goal_banner: None,
                    is_running: false,
                    activity_label: None,
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &msgs_1g,
                    live_stream: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "ok",
                    approval: None,
                    model_picker: &picker,
                    overlay: &ClassicOverlay::None,
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();
    }
    drop(msgs_1g);
    let s2_ms = t2_start.elapsed().as_millis();
    let steady_1g_kib = current_rss_kib();
    let cache_bytes_after_1g = cache.used_bytes();

    // Remove the 1 GiB temp file promptly before cycle test
    let _ = fs::remove_file(&path_1g);

    // --- Scenario 3: 100 create/open/render/close session + NativeProjectHost cycles ---
    let fds_before = open_fd_count();
    let rss_before_100 = current_rss_kib();
    let mut peak_100_kib = rss_before_100;
    for cycle in 0..100usize {
        let ws_dir = home.join(format!("ws-cycle-{cycle}"));
        fs::create_dir_all(&ws_dir).unwrap();
        let host = NativeProjectHost::new(home, "0.1.0-bench", Some(1)).unwrap();
        let (entry, _) = host.bind_workspace(&ws_dir, Some("CycleBot")).unwrap();
        let _ = host.submit_user_input(&entry.workspace_id, &format!("cyc-{cycle}"), "ping", None);
        host.close();
        drop(host);
        if cycle % 20 == 19 {
            peak_100_kib = peak_100_kib.max(current_rss_kib());
        }
    }
    let rss_after_100 = current_rss_kib();
    let fds_after = open_fd_count();

    // --- Scenario 4: Rolling soak trajectory (scroll, resize, cache pressure) ---
    let soak_start = Instant::now();
    let mut soak_samples: Vec<(f64, u64)> = Vec::new();
    let mut iter = 0usize;
    while soak_start.elapsed().as_secs() < soak_secs {
        iter += 1;
        let page = reader
            .read_page(
                conv_1k,
                None,
                TranscriptLimits {
                    records: 16,
                    ..TranscriptLimits::default()
                },
                None,
            )
            .unwrap();
        let msgs: Vec<ClassicMessage> = page
            .rows
            .into_iter()
            .enumerate()
            .map(|(i, r)| row_to_classic(r, i))
            .collect();
        anchor.scroll_up(iter % 20, 200, None);
        let term = if iter.is_multiple_of(2) {
            &mut term_wide
        } else {
            &mut term_narrow
        };
        term.draw(|f| {
            render_classic(
                f,
                ClassicView {
                    title: "Peer",
                    workspace_label: "~/bench",
                    model_badge: "bench",
                    effort_badge: "default",
                    mode_badge: "chat",
                    access_badge: "session",
                    context_percent: Some(15),
                    quota_label: None,
                    quota_remaining: None,
                    fast_mode: false,
                    fast_available: false,
                    goal_status: GoalMenuStatus::None,
                    goal_banner: None,
                    is_running: true,
                    activity_label: Some("soak"),
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &msgs,
                    live_stream: "Peer  streaming soak delta...",
                    anchor: &anchor,
                    composer: &composer,
                    status: "soak",
                    approval: None,
                    model_picker: &picker,
                    overlay: &ClassicOverlay::None,
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();
        anchor.jump_to_latest();
        if iter.is_multiple_of(10) {
            soak_samples.push((soak_start.elapsed().as_secs_f64(), current_rss_kib()));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // Compute late-window (second half) linear regression slope in MiB/hour
    let half = soak_samples.len() / 2;
    let late = &soak_samples[half..];
    let slope_mib_per_hour = if late.len() >= 2 {
        let n = late.len() as f64;
        let mean_x = late.iter().map(|(t, _)| *t).sum::<f64>() / n;
        let mean_y = late.iter().map(|(_, r)| *r as f64 / 1024.0).sum::<f64>() / n;
        let num: f64 = late
            .iter()
            .map(|(t, r)| (*t - mean_x) * (*r as f64 / 1024.0 - mean_y))
            .sum();
        let den: f64 = late.iter().map(|(t, _)| (*t - mean_x).powi(2)).sum();
        if den > 1e-9 {
            (num / den) * 3600.0
        } else {
            0.0
        }
    } else {
        0.0
    };

    let report = json!({
        "scenario1_1000_turns": {
            "transcriptBytes": total_1k_bytes,
            "pagesRead": pages_read,
            "durationMs": s1_ms,
            "steadyRssMiB": (steady_1k_kib as f64) / 1024.0,
            "peakRssMiB": (peak_1k_kib as f64) / 1024.0,
            "budgetSteadyMiB": 256.0,
            "budgetPeakMiB": 512.0,
            "passed": total_1k_bytes >= 100 * 1024 * 1024 && (steady_1k_kib as f64) / 1024.0 <= 256.0 && (peak_1k_kib as f64) / 1024.0 <= 512.0
        },
        "scenario2_1gib_10mb_single_msg": {
            "transcriptBytes": total_1g_bytes,
            "tailScannedBytes": tail_scanned_bytes,
            "giantMessageBytes": giant_text_bytes,
            "diagnosedDefaultRecordLimit": diagnosed_record_limit,
            "durationMs": s2_ms,
            "steadyRssMiB": (steady_1g_kib as f64) / 1024.0,
            "wrapCacheBytes": cache_bytes_after_1g,
            "wrapCacheBudgetBytes": MARKDOWN_WRAP_CACHE_BYTES,
            "passed": tail_scanned_bytes < 2 * 1024 * 1024 && diagnosed_record_limit && (steady_1g_kib as f64) / 1024.0 <= 256.0 && cache_bytes_after_1g <= MARKDOWN_WRAP_CACHE_BYTES
        },
        "scenario3_100_session_cycles": {
            "rssBeforeMiB": (rss_before_100 as f64) / 1024.0,
            "rssAfterMiB": (rss_after_100 as f64) / 1024.0,
            "peakRssMiB": (peak_100_kib as f64) / 1024.0,
            "fdsBefore": fds_before,
            "fdsAfter": fds_after,
            "fdDelta": (fds_after as i64) - (fds_before as i64),
            "passed": (rss_after_100 as f64) / 1024.0 <= 256.0 && ((fds_after as i64) - (fds_before as i64)).abs() <= 4
        },
        "scenario4_soak": {
            "durationSecs": soak_secs,
            "iterations": iter,
            "sampleCount": soak_samples.len(),
            "lateWindowSlopeMiBPerHour": slope_mib_per_hour,
            "finalRssMiB": (current_rss_kib() as f64) / 1024.0,
            "wrapCacheBytes": cache.used_bytes(),
            "passed": (current_rss_kib() as f64) / 1024.0 <= 256.0 && cache.used_bytes() <= MARKDOWN_WRAP_CACHE_BYTES
        }
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    assert!(report["scenario1_1000_turns"]["passed"] == true);
    assert!(report["scenario2_1gib_10mb_single_msg"]["passed"] == true);
    assert!(report["scenario3_100_session_cycles"]["passed"] == true);
    assert!(report["scenario4_soak"]["passed"] == true);
}
