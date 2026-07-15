use std::io::{self, Read, Write};

use peer_credential_helper::{Request, Response, handle_request, resolve_data_home};

const MAX_REQUEST_BYTES: u64 = 512 * 1024;

fn run() -> Response {
    let mut input = Vec::new();
    if io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)
        .is_err()
        || input.len() as u64 > MAX_REQUEST_BYTES
    {
        return Response::error(
            "credential_request_too_large",
            "The credential helper request is too large.",
        );
    }

    let request: Request = match serde_json::from_slice(&input) {
        Ok(request) => request,
        Err(_) => {
            return Response::error(
                "credential_request_invalid",
                "The credential helper request is not valid JSON.",
            );
        }
    };
    let data_home = match resolve_data_home() {
        Ok(path) => path,
        Err(error) => return Response::error(error.code(), error.public_message()),
    };
    handle_request(request, &data_home)
}

fn main() {
    let response = run();
    let ok = response.ok;
    let encoded = serde_json::to_vec(&response).unwrap_or_else(|_| {
        br#"{"version":1,"ok":false,"error":{"code":"credential_response_invalid","message":"The credential helper could not encode its response."}}"#.to_vec()
    });
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(&encoded);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
    if !ok {
        std::process::exit(1);
    }
}
