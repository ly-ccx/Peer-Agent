use std::env;
use std::process;

fn print_health() {
    println!(
        r#"{{"status":"ready","capabilityId":"local.health","riskLevel":"L0_inert","dataLevel":"D0_public","summary":"CU Proxy health stub is ready. No local files were read."}}"#
    );
}

fn main() {
    let command = env::args().nth(1).unwrap_or_else(|| "health".to_string());

    match command.as_str() {
        "health" => print_health(),
        other => {
            eprintln!("unsupported command: {other}");
            process::exit(2);
        }
    }
}
