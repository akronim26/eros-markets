import importlib.util
import http.client
import json
import os
from pathlib import Path
import unittest
from threading import Thread
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("forge_local_rpc", Path(__file__).with_name("forge-local-rpc.py"))
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class LocalForgeRpcTests(unittest.TestCase):
    def test_rejects_nonliteral_or_credentialed_upstream(self):
        for endpoint in (
            "https://127.0.0.1:8545", "http://localhost:8545", "http://127.0.0.1.example:8545",
            "http://user:key@127.0.0.1:8545", "http://127.0.0.1:8545/path",
            "http://127.0.0.1:8545/?redirect=1", "http://127.0.0.1:8545/#x", "http://[::1]:8545",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                adapter.upstream_address(endpoint)
        self.assertEqual(adapter.upstream_address("http://127.0.0.1:18546"), ("127.0.0.1", 18546))

    def test_refuses_proxy_environment(self):
        with patch.dict(os.environ, {"http_proxy": "http://example.invalid:8080"}, clear=True):
            with self.assertRaises(ValueError):
                adapter.reject_proxy_environment()

    def test_only_node_info_is_filtered_and_never_forwarded(self):
        def fail_if_forwarded(*arguments):
            self.fail("Diagnostic handler reached upstream")
        request = b'{"jsonrpc":"2.0","method":"anvil_nodeInfo","params":[],"id":17}'
        status, _, response = adapter.dispatch(request, ("127.0.0.1", 8545), fail_if_forwarded)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response)["id"], 17)
        self.assertEqual(json.loads(response)["error"]["code"], -32601)

    def test_economic_requests_and_responses_remain_byte_identical(self):
        for method in ("eth_sendRawTransaction", "eth_call", "eth_estimateGas", "eth_chainId", "anvil_metadata"):
            request = (' { "jsonrpc":"2.0", "id":912345678901234567890, "method":"' + method + '","params":["0xdeadbeef"] } ').encode()
            response = b' { "jsonrpc":"2.0", "id":912345678901234567890, "result":"0x123" } '
            forwarded = []
            def send(address, body):
                forwarded.append(body)
                return 200, "application/json", response
            self.assertEqual(adapter.dispatch(request, ("127.0.0.1", 8545), send)[2], response)
            self.assertEqual(forwarded, [request])

    def test_unfiltered_batch_is_forwarded_intact(self):
        body = b' [ {"method":"eth_chainId","id":1}, {"method":"eth_blockNumber","id":2} ] '
        forwarded = []
        def send(address, original):
            forwarded.append(original)
            return 200, "application/json", b'[{"result":"0x7a69","id":1},{"result":"0x2","id":2}]'
        adapter.dispatch(body, ("127.0.0.1", 8545), send)
        self.assertEqual(forwarded, [body])

    def test_mixed_batch_preserves_nonfiltered_values_and_response_bytes(self):
        ordinary = b'{ "method":"eth_call", "id":123456789012345678901, "params":[{"value":123456789012345678901},"latest"] }'
        body = b'[{"method":"anvil_nodeInfo","id":1},' + ordinary + b']'
        response = b'{"id":123456789012345678901,"result":"0x123"}'
        forwarded = []
        def send(address, original):
            forwarded.append(original)
            return 200, "application/json", response
        result = adapter.dispatch(body, ("127.0.0.1", 8545), send)[2]
        self.assertEqual(forwarded, [ordinary])
        self.assertIn(response, result)
        self.assertEqual(json.loads(result)[0]["error"]["code"], -32601)

    def test_filtered_notification_has_no_response(self):
        result = adapter.dispatch(b'{"method":"anvil_nodeInfo"}', ("127.0.0.1", 8545))
        self.assertEqual(result, (204, "application/json", b""))

    def test_batch_limits_and_invalid_json_are_rejected(self):
        for body in (b'[]', b'not-json', b'{"params":NaN}', json.dumps([{}] * 257).encode()):
            with self.subTest(body=body[:20]), self.assertRaises(ValueError):
                adapter.parsed_requests(body)

    def test_upstream_redirect_is_not_followed(self):
        with patch.object(adapter.http.client, "HTTPConnection") as connection:
            connection.return_value.getresponse.return_value.status = 307
            with self.assertRaisesRegex(ValueError, "redirects are forbidden"):
                adapter.forward(("127.0.0.1", 8545), b'{}')
            connection.return_value.close.assert_called_once()

    def test_same_port_is_rejected_before_binding(self):
        with self.assertRaisesRegex(ValueError, "ports must differ"):
            adapter.LocalRpcServer(18546, "http://127.0.0.1:18546")

    def test_http_listener_is_loopback_and_rejects_oversized_body_before_forwarding(self):
        with adapter.LocalRpcServer(0, "http://127.0.0.1:8545") as server:
            self.assertEqual(server.server_address[0], "127.0.0.1")
            worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            worker.start()
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                with patch.object(adapter, "dispatch") as dispatch:
                    connection.putrequest("POST", "/")
                    connection.putheader("Content-Length", str(adapter.MAX_REQUEST_BYTES + 1))
                    connection.endheaders()
                    self.assertEqual(connection.getresponse().status, 413)
                    dispatch.assert_not_called()
            finally:
                connection.close()
                server.shutdown()
                worker.join(timeout=5)

    def test_http_filtered_method_returns_supported_forge_fallback(self):
        with adapter.LocalRpcServer(0, "http://127.0.0.1:8545") as server:
            worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            worker.start()
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                connection.request("POST", "/", body=b'{"jsonrpc":"2.0","id":1,"method":"anvil_nodeInfo","params":[]}')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["error"]["code"], -32601)
            finally:
                connection.close()
                server.shutdown()
                worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
