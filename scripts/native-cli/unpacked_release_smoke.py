#!/usr/bin/env python3
"""
P7 unpacked release archive smoke test (zero Node/Bun/Desktop on PATH).
Unpacks peer-<target>.tar.gz into an isolated temp directory, checks dynamic
library linkage, executes CLI commands with PATH=/nonexistent, and runs all
real PTY suites (pty_checks, tui_e2e_pty, resume_pty) against the unpacked `peer`.
"""
import argparse
import hashlib
import http.server
import json
import os
import platform
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class MockServer:
    def __init__(self, expected_version: str):
        self.expected_version = expected_version
        self.server = None
        self.thread = None
        self.port = 0

    def start(self):
        expected_version = self.expected_version

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                if self.path.startswith("/releases"):
                    body = json.dumps([
                        {
                            "tag_name": "v0.1.0-rc.999",
                            "html_url": "https://example.invalid/releases/v0.1.0-rc.999",
                            "draft": False,
                            "prerelease": True,
                        }
                    ]).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                if "/chat/completions" in self.path:
                    sse = (
                        'data: {"id":"cmpl-smoke","object":"chat.completion.chunk",'
                        '"choices":[{"index":0,"delta":{"role":"assistant","content":"UNPACKED_SMOKE_OK"},"finish_reason":null}]}\n\n'
                        'data: {"id":"cmpl-smoke","object":"chat.completion.chunk",'
                        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
                        '"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n'
                        "data: [DONE]\n\n"
                    ).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(sse)))
                    self.end_headers()
                    self.wfile.write(sse)
                else:
                    self.send_response(404)
                    self.end_headers()

        class ReusableTCPServer(socketserver.TCPServer):
            allow_reuse_address = True

        self.server = ReusableTCPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()


def check_linkage(binary: Path) -> dict:
    sysname = platform.system().lower()
    if sysname == "darwin":
        out = subprocess.check_output(["/usr/bin/otool", "-L", str(binary)], text=True)
        libs = [line.strip().split(" ")[0] for line in out.splitlines()[1:] if line.strip()]
    elif sysname == "linux":
        out = subprocess.check_output(["ldd", str(binary)], text=True)
        libs = [line.strip() for line in out.splitlines() if line.strip()]
    else:
        libs = []
    forbidden = [lib for lib in libs if any(k in lib.lower() for k in ("bun", "node", "electron", "homebrew", "v8"))]
    assert not forbidden, f"Forbidden dynamic linkage found: {forbidden}"
    return {"libs": libs, "forbidden": forbidden, "passed": True}


def run_isolated(binary: Path, args: list, env: dict, stdin_bytes: bytes = None, cwd: Path = None):
    proc = subprocess.run(
        [str(binary), *args],
        input=stdin_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=str(cwd) if cwd else None,
        timeout=30,
    )
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--fixture", required=True, help="release terminal-lifecycle fixture binary")
    parser.add_argument("--helper-probe", required=True, help="helper-probe binary")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    archive = Path(args.archive).resolve()
    fixture = Path(args.fixture).resolve()
    helper_probe = Path(args.helper_probe).resolve()

    with tempfile.TemporaryDirectory(prefix="peer-unpacked-smoke-") as tmp_str:
        tmp = Path(tmp_str)
        unpack = tmp / "unpack"
        unpack.mkdir()
        subprocess.check_call(["/usr/bin/tar", "-xzf", str(archive), "-C", str(unpack)])

        subdirs = [p for p in unpack.iterdir() if p.is_dir()]
        assert len(subdirs) == 1, f"Expected single root folder in archive, got {subdirs}"
        bundle_dir = subdirs[0]
        peer_bin = bundle_dir / "peer"
        helper_bin = bundle_dir / "peer-credential-helper"
        assert peer_bin.is_file() and os.access(peer_bin, os.X_OK), "unpacked peer missing or not executable"
        assert helper_bin.is_file() and os.access(helper_bin, os.X_OK), "unpacked helper missing or not executable"

        linkage_peer = check_linkage(peer_bin)
        linkage_helper = check_linkage(helper_bin)

        home_dir = tmp / "home"
        data_home = tmp / "peer-home"
        ws_dir = tmp / "workspace"
        for d in (home_dir, data_home, ws_dir):
            d.mkdir(parents=True, exist_ok=True)

        mock = MockServer(args.version)
        base_url = mock.start()

        iso_env = {
            "PATH": "/nonexistent",
            "HOME": str(home_dir),
            "PEER_AGENT_HOME": str(data_home),
            "NO_PROXY": "*",
            "TERM": "xterm-256color",
        }

        checks = {}
        try:
            # 1. --version & version
            rc, out, err = run_isolated(peer_bin, ["--version"], iso_env, cwd=ws_dir)
            assert rc == 0 and out.strip() == f"peer {args.version}", (rc, out, err)
            rc2, out2, _ = run_isolated(peer_bin, ["version"], iso_env, cwd=ws_dir)
            assert rc2 == 0 and out2.strip() == f"peer {args.version}", (rc2, out2)
            checks["version"] = {"exitCode": rc, "output": out.strip(), "passed": True}

            # 2. --help & help
            rc, out, _ = run_isolated(peer_bin, ["--help"], iso_env, cwd=ws_dir)
            assert rc == 0 and "peer update" in out and "No Bun/Node sidecar" in out, (rc, out)
            checks["help"] = {"exitCode": rc, "passed": True}

            # 3. doctor (must find sibling unpacked peer-credential-helper)
            rc, out, err = run_isolated(peer_bin, ["doctor"], iso_env, cwd=ws_dir)
            assert rc == 0 and "peer-credential-helper" in (out + err), (rc, out, err)
            checks["doctor"] = {"exitCode": rc, "passed": True}

            # 4. models
            rc, out, err = run_isolated(peer_bin, ["models"], iso_env, cwd=ws_dir)
            assert rc == 0, (rc, out, err)
            checks["models"] = {"exitCode": rc, "passed": True}

            # 5. bots --json
            rc, out, err = run_isolated(peer_bin, ["bots", "--json"], iso_env, cwd=ws_dir)
            assert rc == 0, (rc, out, err)
            parsed_bots = json.loads(out)
            assert isinstance(parsed_bots, dict) or isinstance(parsed_bots, list)
            checks["botsJson"] = {"exitCode": rc, "passed": True}

            # 6. completions zsh
            rc, out, _ = run_isolated(peer_bin, ["completions", "zsh"], iso_env, cwd=ws_dir)
            assert rc == 0 and "#compdef peer" in out, (rc, out)
            checks["completionsZsh"] = {"exitCode": rc, "passed": True}

            # 7. update --help and update --check (mock HTTP)
            rc, out, _ = run_isolated(peer_bin, ["update", "--help"], iso_env, cwd=ws_dir)
            assert rc == 0 and "peer update --check" in out, (rc, out)
            upd_env = {**iso_env, "PEER_AGENT_UPDATE_API_URL": f"{base_url}/releases"}
            rc, out, err = run_isolated(peer_bin, ["update", "--check"], upd_env, cwd=ws_dir)
            assert rc == 0 and "0.1.0-rc.999" in out, (rc, out, err)
            checks["updateCheck"] = {"exitCode": rc, "output": out.strip(), "passed": True}

            # 8. ordinary exec against mock OpenAI SSE server
            exec_env = {
                **iso_env,
                "PEER_MODEL_API_KEY": "smoke-test-key",
                "PEER_MODEL_BASE_URL": f"{base_url}/v1",
                "PEER_MODEL_ID": "smoke-model",
            }
            rc, out, err = run_isolated(
                peer_bin,
                ["exec", "--access", "session", "--workspace", str(ws_dir), "say hello"],
                exec_env,
                cwd=ws_dir,
            )
            assert rc == 0 and "UNPACKED_SMOKE_OK" in out, (rc, out, err)
            checks["execOrdinary"] = {"exitCode": rc, "passed": True}

            # 9. ACP stdio initialize handshake
            acp_init = json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": 1, "clientCapabilities": {}},
            }) + "\n"
            rc, out, err = run_isolated(
                peer_bin,
                ["acp"],
                iso_env,
                stdin_bytes=acp_init.encode("utf-8"),
                cwd=ws_dir,
            )
            assert rc == 0 and '"protocolVersion"' in out, (rc, out, err)
            checks["acpInitialize"] = {"exitCode": rc, "passed": True}

            # 10. helper-probe against unpacked peer-credential-helper with PATH=/nonexistent
            hp = subprocess.run(
                [str(helper_probe), str(helper_bin)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "PATH": "/nonexistent"},
                timeout=30,
            )
            assert hp.returncode == 0, (hp.returncode, hp.stdout, hp.stderr)
            checks["helperProbe"] = {"exitCode": hp.returncode, "passed": True}

            # 11. All 22 real PTY tests against the unpacked `peer` binary
            pty_out = tmp / "pty-evidence"
            pty_out.mkdir()
            p1 = subprocess.check_output(
                [sys.executable, str(repo_root / "scripts/native-cli/pty_checks.py"),
                 "--binary", str(peer_bin), "--fixture", str(fixture), "--output", str(pty_out / "pty")],
                text=True,
            )
            p2 = subprocess.check_output(
                [sys.executable, str(repo_root / "scripts/native-cli/tui_e2e_pty.py"),
                 "--binary", str(peer_bin), "--output", str(pty_out / "tui-e2e")],
                text=True,
            )
            p3 = subprocess.check_output(
                [sys.executable, str(repo_root / "scripts/native-cli/resume_pty.py"),
                 "--binary", str(peer_bin), "--output", str(pty_out / "resume-pty")],
                text=True,
            )
            checks["ptyChecks"] = json.loads(p1.strip().splitlines()[-1])
            checks["tuiE2ePty"] = json.loads(p2.strip().splitlines()[-1])
            checks["resumePty"] = json.loads(p3.strip().splitlines()[-1])
        finally:
            mock.stop()

        report = {
            "platform": f"{platform.system().lower()}-{platform.machine()}",
            "archiveName": archive.name,
            "archiveBytes": archive.stat().st_size,
            "archiveSha256": sha256_file(archive),
            "peerBytes": peer_bin.stat().st_size,
            "peerSha256": sha256_file(peer_bin),
            "helperBytes": helper_bin.stat().st_size,
            "helperSha256": sha256_file(helper_bin),
            "linkage": {"peer": linkage_peer, "helper": linkage_helper},
            "checks": checks,
            "passed": True,
        }

        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
