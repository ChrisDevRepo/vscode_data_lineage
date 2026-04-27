"""Mock Haiku endpoint — accepts the bridge payload, returns a canned response.

Used to verify the LM-provider router end-to-end without spending real Haiku
tokens. Records every received payload so the test can assert against it.

Run: python tests/eval/mock-haiku-server.py [port]
Default port: 4271
"""
import json
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

LOG_PATH = Path("test-results/eval-bridge/mock-haiku.log.jsonl")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length)
        try:
            payload = json.loads(body_bytes.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"invalid json"}')
            return

        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": datetime.utcnow().isoformat(),
                "received_payload": payload,
            }) + "\n")

        # Canned response — the participant should see one text part.
        last_msg = payload.get("messages", [])[-1] if payload.get("messages") else None
        echo = ""
        if last_msg:
            for part in last_msg.get("content", []):
                if isinstance(part, dict) and part.get("type") == "text":
                    echo = part.get("text", "")[:120]
                    break

        response = {
            "parts": [
                {"type": "text", "text": f"[mock-haiku] received {len(payload.get('messages', []))} message(s); last text snippet: {echo}"},
            ],
        }
        body = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[mock-haiku] {fmt % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4271
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[mock-haiku] listening on http://127.0.0.1:{port} — log {LOG_PATH}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
