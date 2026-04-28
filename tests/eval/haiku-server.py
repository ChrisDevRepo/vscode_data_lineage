"""Haiku endpoint for the eval bridge — supports two modes.

MODE A (HANDSHAKE — default when ANTHROPIC_API_KEY absent):
  Per-turn file handshake. The bridge POST blocks until a response file
  appears on disk. The orchestrator (Claude Code) watches for request
  files, dispatches a Haiku Task with the messages, writes the response
  back. Per-turn fresh Haiku — matches the stateless-per-call invariant.

MODE B (DIRECT — when ANTHROPIC_API_KEY present):
  Server itself calls Anthropic Messages API. Per-turn fresh Haiku
  via stateless HTTP — no orchestrator interaction needed.

Wire shape both modes use:

  vscode-tester (production @lineage participant)
       │ request.model.sendRequest(messages, options, token)
       ▼
  evalLmProvider (registered LanguageModelChatProvider)
       │ POST { model, messages, tools, toolMode } over HTTP
       ▼
  THIS server (haiku-server.py)
       │ MODE A: file handshake → orchestrator dispatches Haiku Task
       │ MODE B: direct Anthropic API call
       ▼
  Haiku response { parts: [...] }
       ▼
  evalLmProvider replays parts via progress.report
       ▼
  vscode-tester participant continues

Run:
  python tests/eval/haiku-server.py [port]                  # MODE A (handshake)
  ANTHROPIC_API_KEY=sk-ant-... python tests/eval/haiku-server.py [port]  # MODE B
Default port: 4271
"""
import json
import os
import sys
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("EVAL_HAIKU_ANTHROPIC_KEY", "")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

LOG_PATH = Path("test-results/eval-bridge/haiku-server.log.jsonl")
HANDSHAKE_DIR = Path("test-results/eval-bridge/handshake")
HANDSHAKE_TIMEOUT_S = 30 * 60  # 30 minutes — generous for orchestrator interactivity


def _bridge_to_anthropic(payload: dict) -> dict:
    """Translate the bridge wire shape to Anthropic Messages API request body.

    Bridge payload (from evalLmProvider.buildBridgePayload):
      { model, toolMode, messages: [{role, content: [{type, text|...}]}], tools: [...] }

    Anthropic body:
      { model, max_tokens, system?, messages: [{role, content: [...]}], tools? }

    The participant's first User message is its system envelope; we hoist it
    into Anthropic's top-level `system` field for proper prompt caching.
    """
    system_text = ""
    convo = []
    for i, m in enumerate(payload.get("messages") or []):
        role = m.get("role", "user")
        content = m.get("content") or []
        # First User message is the participant's system envelope.
        if i == 0 and role == "user":
            text_blocks = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
            system_text = "\n\n".join(text_blocks)
            continue
        convo.append({"role": role, "content": content})

    body = {
        "model": payload.get("model", "claude-haiku-4-5-20251001"),
        "max_tokens": 8192,
        "messages": convo,
    }
    if system_text:
        body["system"] = system_text
    tools = payload.get("tools") or []
    if tools:
        body["tools"] = tools
    return body


def _anthropic_to_bridge(anthropic_resp: dict) -> dict:
    """Translate Anthropic response.content[] into bridge `{parts:[...]}` shape."""
    parts = []
    for block in anthropic_resp.get("content") or []:
        if not isinstance(block, dict):
            continue
        t = block.get("type")
        if t == "text":
            parts.append({"type": "text", "text": block.get("text", "")})
        elif t == "tool_use":
            parts.append({
                "type": "tool_use",
                "id": block.get("id", ""),
                "name": block.get("name", ""),
                "input": block.get("input", {}),
            })
    return {"parts": parts}


def _call_anthropic(body: dict) -> dict:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY env var is required to call real Haiku")
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": ANTHROPIC_VERSION,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _log(entry: dict) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _handshake_dispatch(payload: dict) -> dict:
    """File-handshake: write request, wait for orchestrator-written response.

    @remarks
    Used when no Anthropic API key is configured. The orchestrator (Claude
    Code, running interactively) polls the handshake directory, dispatches a
    Haiku Task per pending request, writes the Task's `{parts:[...]}` output
    back. This server blocks the bridge POST until the response file appears.
    """
    HANDSHAKE_DIR.mkdir(parents=True, exist_ok=True)
    rid = uuid.uuid4().hex[:12]
    req_path = HANDSHAKE_DIR / f"req-{rid}.json"
    resp_path = HANDSHAKE_DIR / f"resp-{rid}.json"

    req_path.write_text(
        json.dumps({"id": rid, "received_at": datetime.utcnow().isoformat(), "payload": payload}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    sys.stderr.write(f"[handshake] wrote {req_path.name} — waiting for {resp_path.name}\n")
    sys.stderr.flush()

    deadline = time.time() + HANDSHAKE_TIMEOUT_S
    while time.time() < deadline:
        if resp_path.exists():
            try:
                content = resp_path.read_text(encoding="utf-8")
            except OSError:
                time.sleep(0.5)
                continue
            try:
                resp = json.loads(content)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"handshake response file {resp_path.name} is not valid JSON: {e}")
            try:
                req_path.unlink(missing_ok=True)
                resp_path.unlink(missing_ok=True)
            except OSError:
                pass
            return resp
        time.sleep(0.5)
    raise TimeoutError(f"handshake timeout after {HANDSHAKE_TIMEOUT_S}s waiting for {resp_path}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        cl = int(self.headers.get("Content-Length", 0))
        try:
            body_bytes = self.rfile.read(cl)
            payload = json.loads(body_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self._send(400, {"error": "invalid_request", "detail": str(e)})
            return

        _log({"ts": datetime.utcnow().isoformat(), "direction": "bridge->haiku-server", "payload": payload})

        try:
            if ANTHROPIC_API_KEY:
                # MODE B: direct Anthropic API call.
                anthropic_body = _bridge_to_anthropic(payload)
                _log({"ts": datetime.utcnow().isoformat(), "direction": "haiku-server->anthropic", "payload": anthropic_body})
                anthropic_resp = _call_anthropic(anthropic_body)
                _log({"ts": datetime.utcnow().isoformat(), "direction": "anthropic->haiku-server", "payload": anthropic_resp})
                bridge_resp = _anthropic_to_bridge(anthropic_resp)
            else:
                # MODE A: file-handshake — orchestrator dispatches a Haiku Task per turn.
                _log({"ts": datetime.utcnow().isoformat(), "direction": "haiku-server->orchestrator", "payload": {"mode": "handshake", "payload": payload}})
                bridge_resp = _handshake_dispatch(payload)
            _log({"ts": datetime.utcnow().isoformat(), "direction": "haiku-server->bridge", "payload": bridge_resp})
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:1000]
            _log({"ts": datetime.utcnow().isoformat(), "direction": "anthropic-error", "payload": {"status": e.code, "body": err_body}})
            self._send(502, {"error": "anthropic_http_error", "status": e.code, "detail": err_body})
            return
        except TimeoutError as e:
            _log({"ts": datetime.utcnow().isoformat(), "direction": "haiku-server-error", "payload": {"error": str(e)}})
            self._send(504, {"error": "handshake_timeout", "detail": str(e)})
            return
        except Exception as e:
            _log({"ts": datetime.utcnow().isoformat(), "direction": "haiku-server-error", "payload": {"error": str(e)}})
            self._send(500, {"error": "haiku_server_failure", "detail": str(e)})
            return

        self._send(200, bridge_resp)

    def _send(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[haiku-server] {fmt % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4271
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    mode = "DIRECT (Anthropic API)" if ANTHROPIC_API_KEY else "HANDSHAKE (orchestrator dispatches Haiku Task per turn)"
    print(f"[haiku-server] mode={mode}", flush=True)
    print(f"[haiku-server] listening on http://127.0.0.1:{port} — log {LOG_PATH}", flush=True)
    if not ANTHROPIC_API_KEY:
        print(f"[haiku-server] handshake dir: {HANDSHAKE_DIR}", flush=True)
        print("[haiku-server] orchestrator: poll handshake dir for req-*.json, dispatch Haiku Task with payload, write resp-*.json with {parts:[...]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
