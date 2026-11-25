//! Existing ordinary exec argv contract. No terminal, Store or credential access.
use crate::{Command, bot_exec::BotExecOptions};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub bot: Option<BotExecOptions>,
    pub access: String,
    pub tools: Option<Vec<String>>,
    pub output_format: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: String,
    pub fast: bool,
    pub workspace: Option<String>,
    pub max_turns: Option<usize>,
    pub prompt_parts: Vec<String>,
    pub image_paths: Vec<std::path::PathBuf>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            bot: None,
            access: "session".into(),
            tools: None,
            output_format: "text".into(),
            provider: None,
            model: None,
            effort: None,
            mode: "chat".into(),
            fast: false,
            workspace: None,
            max_turns: None,
            prompt_parts: vec![],
            image_paths: vec![],
        }
    }
}
fn count(s: &str) -> Option<usize> {
    let s = peer_protocol::javascript_trim(s);
    let n = if let Some(s) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u64::from_str_radix(s, 16).ok().map(|v| v as f64)
    } else if let Some(s) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
        u64::from_str_radix(s, 8).ok().map(|v| v as f64)
    } else if let Some(s) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
        u64::from_str_radix(s, 2).ok().map(|v| v as f64)
    } else {
        s.parse::<f64>().ok()
    }?;
    if !n.is_finite() || n < 1.0 || n.fract() != 0.0 || n >= usize::MAX as f64 {
        return None;
    }
    Some(n as usize)
}
pub(crate) fn parse(args: &[String]) -> Command {
    match parse_inner(args) {
        Ok(Some(options)) => Command::OrdinaryExec(Box::new(options)),
        Ok(None) => Command::ExecHelp,
        Err(message) => Command::Usage(message),
    }
}
fn valid_wait_ms(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 7 || !matches!(bytes[0], b'1'..=b'9') {
        return None;
    }
    if !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let parsed = value.parse::<u64>().ok()?;
    (parsed <= 1_800_000).then_some(parsed)
}

fn parse_inner(args: &[String]) -> Result<Option<Options>, String> {
    let mut options = Options::default();
    let mut explicit: HashSet<&str> = HashSet::new();
    let mut bot = false;
    let mut input_id: Option<String> = None;
    let mut wait_ms: Option<u64> = None;
    let mut i = 0;
    let mut positional = false;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if positional {
            options.prompt_parts.push(arg.clone());
            continue;
        }
        if arg == "--" {
            positional = true;
            continue;
        }
        if arg == "--help" || arg == "-h" {
            return Ok(None);
        }
        if !arg.starts_with('-') || arg == "-" {
            options.prompt_parts.push(arg.clone());
            continue;
        }
        let (name, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(a, b)| (a, Some(b)));
        if name == "--bot" && inline.is_none() {
            bot = true;
            continue;
        }
        if name == "--fast" {
            if inline.is_some() {
                return Err("peer exec: --fast does not take a value".into());
            }
            explicit.insert("--fast");
            options.fast = true;
            continue;
        }
        if ![
            "--input-id",
            "--wait-ms",
            "--access",
            "--tools",
            "--output-format",
            "--provider",
            "--model",
            "--effort",
            "--mode",
            "--workspace",
            "--image",
            "--max-turns",
        ]
        .contains(&name)
        {
            return Err(format!("peer exec: unknown option {name}"));
        }
        let value = match inline {
            Some(s) if !peer_protocol::javascript_trim(s).is_empty() => s.to_owned(),
            Some(_) => return Err(format!("peer exec: {name} requires a value")),
            None => {
                let s = args
                    .get(i)
                    .filter(|s| !s.starts_with('-') || s.as_str() == "-")
                    .ok_or_else(|| format!("peer exec: {name} requires a value"))?;
                i += 1;
                s.clone()
            }
        };
        match name {
            "--input-id" => {
                if !peer_project_agent::is_valid_input_id(&value) {
                    return Err("peer exec: invalid --input-id".into());
                }
                input_id = Some(value);
            }
            "--wait-ms" => {
                wait_ms = Some(valid_wait_ms(&value).ok_or("peer exec: invalid --wait-ms")?);
            }
            "--access" => {
                explicit.insert("--access");
                if !["ask", "session", "full"].contains(&value.as_str()) {
                    return Err("peer exec: --access must be ask, session, or full".into());
                }
                options.access = value;
            }
            "--tools" => {
                explicit.insert("--tools");
                let v = value
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if v.is_empty() {
                    return Err("peer exec: --tools requires a value".into());
                }
                options.tools = Some(v);
            }
            "--output-format" => {
                if !["text", "json"].contains(&value.as_str()) {
                    return Err("peer exec: --output-format must be text or json".into());
                }
                options.output_format = value;
            }
            "--provider" => {
                explicit.insert("--provider");
                options.provider = Some(value);
            }
            "--model" => {
                explicit.insert("--model");
                options.model = Some(value);
            }
            "--effort" => {
                explicit.insert("--effort");
                options.effort = Some(value);
            }
            "--workspace" => options.workspace = Some(value),
            "--image" => {
                explicit.insert("--image");
                options.image_paths.push(value.into());
            }
            "--mode" => {
                explicit.insert("--mode");
                if !["chat", "plan", "goal"].contains(&value.as_str()) {
                    return Err("peer exec: --mode must be chat, plan, or goal".into());
                }
                options.mode = value;
            }
            "--max-turns" => {
                explicit.insert("--max-turns");
                options.max_turns =
                    Some(count(&value).ok_or("peer exec: --max-turns must be a positive integer")?)
            }
            _ => unreachable!(),
        }
    }
    if bot
        && [
            "--access",
            "--tools",
            "--provider",
            "--model",
            "--effort",
            "--mode",
            "--fast",
            "--max-turns",
            "--image",
        ]
        .iter()
        .any(|flag| explicit.contains(flag))
    {
        return Err("peer exec: --bot uses the bound Bot policy and model".into());
    }
    if !bot && (input_id.is_some() || wait_ms.is_some()) {
        return Err("peer exec: --input-id and --wait-ms require --bot".into());
    }
    if bot {
        options.bot = Some(BotExecOptions {
            input_id,
            wait_ms: wait_ms.unwrap_or(1_800_000),
        });
    }
    Ok(Some(options))
}
pub(super) fn tools(tokens: Option<&[String]>) -> Result<Option<Vec<String>>, String> {
    let Some(tokens) = tokens else {
        return Ok(None);
    };
    let resources: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/ordinary-exec-tools.json"
    ))
    .map_err(|_| "exec tool contract invalid")?;
    let mut out = vec![];
    for token in tokens {
        let token = peer_protocol::javascript_trim(token);
        if token.is_empty() {
            continue;
        }
        let skill = token.strip_prefix("local.skill.");
        let selected = if skill.is_some_and(peer_runtime::providers::skill_id)
            || peer_runtime::providers::wire_skill_name(token)
        {
            Some(token)
        } else if matches!(token, "read_tool_result" | "local.tool-result.read") {
            Some("local.tool-result.read")
        } else if matches!(token, "web_search" | "local.web.search") {
            Some("local.web.search")
        } else {
            None
        };
        if let Some(id) = selected {
            if !out.iter().any(|value| value == id) {
                out.push(id.to_owned());
            }
            continue;
        }
        let ids = resources["toolAliases"][token]
            .as_array()
            .ok_or_else(|| format!("peer exec: unknown --tools token \"{token}\""))?;
        for id in ids {
            let id = id.as_str().ok_or("exec tool contract invalid")?.to_owned();
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    if out.is_empty() {
        return Err("peer exec: --tools requires a value".into());
    }
    Ok(Some(out))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[test]
    fn ordinary_arguments_and_tool_aliases_match_actual_ts_cli() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/ordinary-exec.json"
        ))
        .unwrap();
        for c in fixture["argvCases"].as_array().unwrap() {
            let args = c["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            let actual = parse(&args);
            match actual {
                Command::OrdinaryExec(o) => {
                    assert_eq!(c["expected"]["kind"], "exec");
                    let v = json!({"access":o.access,"tools":o.tools,"outputFormat":o.output_format,"provider":o.provider,"model":o.model,"effort":o.effort,"mode":o.mode,"fast":o.fast,"workspace":o.workspace,"maxTurns":o.max_turns,"promptParts":o.prompt_parts});
                    for (k, val) in v.as_object().unwrap() {
                        if val.is_null() {
                            assert!(c["expected"]["options"].get(k).is_none(), "{args:?}: {k}");
                        } else {
                            assert_eq!(val, &c["expected"]["options"][k], "{args:?}: {k}");
                        }
                    }
                }
                Command::ExecHelp => assert_eq!(c["expected"]["kind"], "help"),
                Command::Usage(m) => {
                    assert_eq!(c["expected"]["kind"], "error");
                    assert_eq!(m, c["expected"]["message"], "{args:?}");
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        for (token, expected) in fixture["toolAliases"].as_object().unwrap() {
            assert_eq!(
                json!(tools(Some(std::slice::from_ref(token))).unwrap().unwrap()),
                *expected
            );
        }
        assert_eq!(
            tools(Some(&["web_search".into()])).unwrap().unwrap(),
            vec!["local.web.search".to_owned()]
        );
        assert_eq!(
            tools(Some(&["local.web.search".into()])).unwrap().unwrap(),
            vec!["local.web.search".to_owned()]
        );
        assert!(tools(Some(&["browser_open_panel".into()])).is_err());
    }

    #[test]
    fn bot_exec_arguments_match_ts_cli_contract() {
        let ok = parse(&[
            "--bot".into(),
            "--input-id".into(),
            "req-1".into(),
            "--wait-ms=5000".into(),
            "--output-format".into(),
            "json".into(),
            "hello".into(),
        ]);
        let Command::OrdinaryExec(opts) = ok else {
            panic!("expected OrdinaryExec, got {ok:?}");
        };
        assert_eq!(
            opts.bot,
            Some(BotExecOptions {
                input_id: Some("req-1".into()),
                wait_ms: 5000,
            })
        );
        assert_eq!(opts.output_format, "json");
        assert_eq!(opts.prompt_parts, vec!["hello"]);

        assert_eq!(
            parse(&["--input-id".into(), "req-1".into(), "hi".into()]),
            Command::Usage("peer exec: --input-id and --wait-ms require --bot".into())
        );
        assert_eq!(
            parse(&[
                "--bot".into(),
                "--model".into(),
                "gpt-4o".into(),
                "hi".into()
            ]),
            Command::Usage("peer exec: --bot uses the bound Bot policy and model".into())
        );
        assert_eq!(
            parse(&["--bot".into(), "--wait-ms".into(), "0".into(), "hi".into()]),
            Command::Usage("peer exec: invalid --wait-ms".into())
        );
        assert_eq!(
            parse(&[
                "--bot".into(),
                "--input-id".into(),
                "../bad".into(),
                "hi".into()
            ]),
            Command::Usage("peer exec: invalid --input-id".into())
        );
    }
}
