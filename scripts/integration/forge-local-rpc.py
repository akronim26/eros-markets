import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
from urllib.parse import urlsplit


MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_BATCH_ITEMS = 256
FILTERED_METHOD = "anvil_nodeInfo"


def upstream_address(endpoint):
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or parsed.port is None
        or not 1 <= parsed.port <= 65535
        or parsed.netloc != f"127.0.0.1:{parsed.port}"
    ):
        raise ValueError("Upstream must be literal http://127.0.0.1:<port>")
    return parsed.hostname, parsed.port


def reject_proxy_environment():
    for name, value in os.environ.items():
        if name.upper() in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY") and value:
            raise ValueError("Proxy environment variables are forbidden for the local Forge adapter")


def parsed_requests(body):
    payload = body.decode("utf-8")
    decoder = json.JSONDecoder(parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    decoded = decoder.decode(payload)
    if not isinstance(decoded, list):
        return False, [(decoded, body)]
    if not decoded or len(decoded) > MAX_BATCH_ITEMS:
        raise ValueError("Invalid or oversized JSON-RPC batch")
    position = payload.index("[") + 1
    requests = []
    for item in decoded:
        while payload[position].isspace() or payload[position] == ",":
            position += 1
        _, end = decoder.raw_decode(payload, position)
        requests.append((item, payload[position:end].encode("utf-8")))
        position = end
    return True, requests


def diagnostic_response(request):
    if "id" not in request:
        return None
    return json.dumps({
        "jsonrpc": "2.0",
        "id": request["id"],
        "error": {"code": -32601, "message": "anvil_nodeInfo is disabled by the local Forge adapter"},
    }, separators=(",", ":")).encode()


def forward(address, body):
    connection = http.client.HTTPConnection(*address, timeout=120)
    try:
        connection.request("POST", "/", body=body, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise ValueError("Upstream redirects are forbidden")
        result = response.read(MAX_RESPONSE_BYTES + 1)
        if len(result) > MAX_RESPONSE_BYTES:
            raise ValueError("Upstream response exceeds the local adapter limit")
        return response.status, response.getheader("Content-Type", "application/json"), result
    finally:
        connection.close()


def dispatch(body, address, send=forward):
    batch, requests = parsed_requests(body)
    is_filtered = lambda request: isinstance(request, dict) and request.get("method") == FILTERED_METHOD
    if not any(is_filtered(request) for request, _ in requests):
        return send(address, body)
    responses = []
    for request, original in requests:
        if is_filtered(request):
            response = diagnostic_response(request)
        else:
            status, _, response = send(address, original)
            if status != 200:
                return status, "application/json", response
            if not response.strip():
                response = None
        if response is not None:
            responses.append(response)
    if not responses:
        return 204, "application/json", b""
    result = b"[" + b",".join(responses) + b"]" if batch else responses[0]
    return 200, "application/json", result


class LocalRpcServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, upstream):
        self.upstream = upstream_address(upstream)
        if port == self.upstream[1]:
            raise ValueError("Proxy and upstream ports must differ")
        super().__init__(("127.0.0.1", port), LocalRpcHandler)


class LocalRpcHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format_string, *arguments):
        return

    def do_POST(self):
        if self.client_address[0] != "127.0.0.1" or self.path != "/":
            self.send_error(403)
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or "Transfer-Encoding" in self.headers:
            self.send_error(400)
            return
        try:
            length = int(lengths[0])
        except ValueError:
            self.send_error(400)
            return
        if not 0 < length <= MAX_REQUEST_BYTES:
            self.send_error(413)
            return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                self.send_error(400)
                return
            status, content_type, response = dispatch(body, self.server.upstream)
        except (ValueError, UnicodeError):
            self.send_error(400, "Invalid local RPC request or upstream response")
            return
        except (OSError, http.client.HTTPException, socket.timeout):
            self.send_error(502, "Local RPC upstream unavailable")
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def main():
    parser = argparse.ArgumentParser(description="Local-only Forge adapter disabling only anvil_nodeInfo")
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()
    reject_proxy_environment()
    if not 1 <= arguments.port <= 65535:
        parser.error("port must be between 1 and 65535")
    address = upstream_address(arguments.upstream)
    status, _, body = forward(address, b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')
    if status != 200 or json.loads(body).get("result") != "0x7a69":
        raise RuntimeError("The local Forge adapter requires chain 31337")
    status, _, body = forward(address, b'{"jsonrpc":"2.0","id":2,"method":"web3_clientVersion","params":[]}')
    if status != 200 or not str(json.loads(body).get("result", "")).lower().startswith("anvil/"):
        raise RuntimeError("The local Forge adapter requires Anvil")
    with LocalRpcServer(arguments.port, arguments.upstream) as server:
        print(f"Forge localhost adapter on 127.0.0.1:{arguments.port}; only {FILTERED_METHOD} disabled", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
