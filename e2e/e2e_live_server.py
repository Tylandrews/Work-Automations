"""
HTTP server for the Call Log live E2E dashboard (HTML + JSON polling).
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable


class LiveDashboardHandler(BaseHTTPRequestHandler):
    server_version = "CallLogLiveDashboard/1.0"

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        srv: LiveDashboardHTTPServer = self.server  # type: ignore[assignment]
        if path in ("/", "/index.html"):
            body = srv.html_doc.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/live-state":
            snap = srv.get_snapshot()
            raw = json.dumps(snap, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_error(404, "Not found")

    def log_message(self, format: str, *args: Any) -> None:
        return


class LiveDashboardHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        html_doc: str,
        get_snapshot: Callable[[], dict[str, Any]],
    ) -> None:
        super().__init__(server_address, LiveDashboardHandler)
        self.html_doc = html_doc
        self.get_snapshot = get_snapshot


def start_live_dashboard_server(
    host: str,
    port: int,
    html_doc: str,
    get_snapshot: Callable[[], dict[str, Any]],
) -> tuple[LiveDashboardHTTPServer, threading.Thread]:
    httpd = LiveDashboardHTTPServer((host, port), html_doc, get_snapshot)
    thread = threading.Thread(target=httpd.serve_forever, name="live-dashboard", daemon=True)
    thread.start()
    return httpd, thread


def try_start_live_dashboard(
    html_doc: str,
    get_snapshot: Callable[[], dict[str, Any]],
    host: str,
    start_port: int,
    max_tries: int = 30,
) -> tuple[LiveDashboardHTTPServer, threading.Thread, int]:
    last_err: OSError | None = None
    for port in range(start_port, start_port + max_tries):
        try:
            httpd, thr = start_live_dashboard_server(host, port, html_doc, get_snapshot)
            return httpd, thr, port
        except OSError as e:
            last_err = e
            continue
    msg = f"Could not bind live dashboard on {host} ports {start_port}-{start_port + max_tries - 1}: {last_err}"
    raise RuntimeError(msg) from last_err
