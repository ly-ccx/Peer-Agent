//! Port of the existing Node shell classifier, including wrapper/segment rules.
use crate::session_host::HostShellRisk;
fn has(set: &str, name: &str) -> bool {
    set.split(' ').any(|s| s == name)
}
fn name(s: &str) -> String {
    std::path::Path::new(s)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
}
fn words(s: &str) -> Vec<String> {
    s.split_whitespace()
        .map(|s| {
            if s.len() >= 2
                && (s.starts_with('"') && s.ends_with('"')
                    || s.starts_with('\'') && s.ends_with('\''))
            {
                &s[1..s.len() - 1]
            } else {
                s
            }
        })
        .filter(|s| !s.is_empty())
        .filter(|s| {
            let Some((k, _)) = s.split_once('=') else {
                return true;
            };
            !(!k.is_empty()
                && k.bytes().enumerate().all(|(i, b)| {
                    b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit()
                }))
        })
        .map(str::to_owned)
        .collect()
}
fn segments(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            current.push(c);
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            current.push(c);
            if c == q {
                quote = None
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            current.push(c);
            continue;
        }
        if (c == '&' || c == '|') && chars.peek() == Some(&c) {
            chars.next();
            out.push(std::mem::take(&mut current));
            continue;
        }
        if c == ';' || c == '|' {
            out.push(std::mem::take(&mut current));
            continue;
        }
        current.push(c)
    }
    out.push(current);
    out
}
fn segment(s: &str, depth: usize) -> Result<u8, &'static str> {
    if s.contains("$(") || s.contains('`') {
        return Ok(3);
    }
    if s.split_whitespace().any(|s| has("> >> 1> 2> &> << <<<", s)) {
        return Ok(2);
    }
    let tokens = words(s);
    if tokens.is_empty() {
        return Ok(0);
    }
    let mut i = 0;
    while has("builtin command env", &name(&tokens[i])) && i < tokens.len() - 1 {
        i += 1
    }
    let n = name(&tokens[i]);
    let args = &tokens[i + 1..];
    if has("bash sh zsh", &n) {
        if let Some(i) = args
            .iter()
            .position(|s| s == "-c" || s == "-lc")
            .filter(|i| *i + 1 < args.len())
        {
            if depth >= 16 {
                return Err("shell_classification_limit");
            }
            return classify_inner(&args[i + 1..].join(" "), depth + 1);
        }
        return Ok(3);
    }
    if has(
        "dd diskutil halt kill killall mkfs pkill poweroff reboot rm shutdown",
        &n,
    ) {
        return Ok(5);
    }
    if has("launchctl mount sudo su systemctl umount", &n) {
        return Ok(4);
    }
    if has(
        "curl nc ncat netcat open rsync scp ssh telnet wget cargo make node npm npx pnpm python python3 ruby yarn",
        &n,
    ) {
        return Ok(3);
    }
    if has("chmod chown cp install mkdir mv perl tee touch", &n) {
        return Ok(2);
    }
    if n == "git" {
        let sub = args
            .iter()
            .find(|s| !s.starts_with('-'))
            .map(|s| name(s))
            .unwrap_or_default();
        return Ok(
            if has("branch diff log rev-parse show status tag version", &sub) {
                1
            } else {
                2
            },
        );
    }
    Ok(
        if has(
            "cat date echo find grep head ls printf pwd rg sed tail test true false wc whoami which type",
            &n,
        ) {
            1
        } else {
            3
        },
    )
}
fn classify_inner(s: &str, depth: usize) -> Result<u8, &'static str> {
    segments(s)
        .iter()
        .map(|s| segment(s, depth))
        .try_fold(0, |a, b| b.map(|b| a.max(b)))
}
pub(super) fn classify(s: &str) -> Result<HostShellRisk, &'static str> {
    Ok(match classify_inner(s, 0)? {
        0 => return Err("empty_command"),
        1 => HostShellRisk::LocalRead,
        2 => HostShellRisk::LocalWrite,
        3 => HostShellRisk::ExternalWrite,
        4 => return Err("privileged_command"),
        _ => return Err("destructive_command"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_source_shell_policy_is_not_weakened() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/native-context-wire.json"
        ))
        .unwrap();
        for c in f["shellCases"].as_array().unwrap() {
            let actual = classify(c["command"].as_str().unwrap());
            let risk = c["expected"]["riskLevel"].as_str().unwrap();
            match risk {
                "L0_inert" | "L4_privileged" | "L5_destructive" => {
                    assert!(actual.is_err(), "{}", c["command"])
                }
                _ => {
                    let expected = match risk {
                        "L1_local_read" => HostShellRisk::LocalRead,
                        "L2_local_write" => HostShellRisk::LocalWrite,
                        _ => HostShellRisk::ExternalWrite,
                    };
                    assert!(actual.is_ok_and(|v| v == expected), "{}", c["command"])
                }
            }
        }
    }
}
