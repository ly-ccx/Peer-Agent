//! Development conformance driver; never linked into the production executable.
use peer_protocol::{JsonLimits, decode_json_bounded};
use peer_runtime::{
    CancellationToken,
    system_context::instructions::{ConfigInstruction, InstructionInput, ProjectInstructions},
};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};
fn main() {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    let v = decode_json_bounded(
        &bytes,
        JsonLimits {
            bytes: 1024 * 1024,
            nodes: 8192,
            depth: 16,
            string_bytes: 1024 * 1024,
        },
    )
    .unwrap()
    .value;
    let workspace = PathBuf::from(v["workspace"].as_str().unwrap());
    let home = PathBuf::from(v["home"].as_str().unwrap());
    assert!(home.join(".native-cli-fixture").is_file());
    let cancel = CancellationToken::new();
    if v["cancel"] == true {
        cancel.cancel();
    }
    let instructions = if v["host"] == true {
        ProjectInstructions::observe_host(&workspace, &home, &cancel)
    } else {
        let config: Vec<_> = v["config"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| ConfigInstruction {
                id: c["id"].as_str().unwrap().into(),
                title: c["title"].as_str().unwrap().into(),
                content: c["content"].as_str().unwrap().into(),
                source: c["source"].as_str().map(str::to_owned),
                priority: c["priority"].as_i64().unwrap(),
            })
            .collect();
        let targets: Vec<_> = v["targets"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| PathBuf::from(p.as_str().unwrap()))
            .collect();
        ProjectInstructions::observe_input(
            &InstructionInput {
                workspace: &workspace,
                data_home: &home,
                include_global: v["global"] == true,
                config: &config,
                target_paths: &targets,
            },
            &cancel,
        )
    };
    let result: Value = match instructions {
        Ok(source) => json!({"sections":source.sections()}),
        Err(error) => json!({"error":error}),
    };
    println!("{result}");
}
