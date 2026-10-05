"""Read-only acceptance checks for the running loopback team API."""
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise RuntimeError("Local API redirects are forbidden")


def main():
    root = Path(__file__).resolve().parents[2]
    runtime = json.loads((root / "tmp" / "local-integration-latest.json").read_text())
    endpoint = runtime["readUrl"]
    if runtime["scope"] != "local-only" or not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", endpoint):
        raise RuntimeError("Only a local integration API can be probed")
    directory = Path(runtime["directory"]).resolve()
    if not directory.is_relative_to((root / "tmp").resolve()) or not directory.is_dir():
        raise RuntimeError("Probe evidence must remain in the repository's local run directory")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    results = []
    snapshot = None
    for route, method, origin, expected in [
        ("/health", "GET", None, 200), ("/manifest", "GET", None, 200),
        ("/snapshot", "GET", "http://localhost:5173", 200), ("/events", "GET", None, 200),
        ("/abi/engine", "GET", None, 200), ("/abi/vault", "GET", None, 200),
        ("/abi/oracle", "GET", None, 200), ("/abi/registry", "GET", None, 200),
        ("/snapshot", "POST", None, 405), ("/snapshot", "GET", "https://example.invalid", 403),
        ("/unknown", "GET", None, 404),
    ]:
        request = urllib.request.Request(endpoint + route, method=method, headers={"Origin": origin} if origin else {})
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if response.status != expected:
                raise RuntimeError(f"{method} {route}: expected {expected}, received {response.status}")
            value = json.load(response)
            if origin == "http://localhost:5173" and response.headers.get("Access-Control-Allow-Origin") != origin:
                raise RuntimeError("Local frontend CORS did not match its origin")
            if route == "/snapshot" and expected == 200:
                snapshot = value
            if route == "/events" and not {"fromBlock", "toBlock", "nextFromBlock", "records"}.issubset(value):
                raise RuntimeError("Missing bounded event pagination metadata")
            results.append({"route": route, "method": method, "origin": origin, "status": response.status})
    states = {market["name"]: market for market in snapshot["markets"]}
    if snapshot["chainId"] != 31337 or states["demo"]["halt"]["halted"] or not states["terminal"]["settlement"]["claimsEnabled"]:
        raise RuntimeError("Live API lifecycle differs from the intended demo")
    if not states["demo"]["risk"]["indexAvailable"] or int(snapshot["custodyAtoms"]) < int(snapshot["recognizedAtoms"]):
        raise RuntimeError("Live demo pricing or custody is unhealthy")
    (directory / "snapshot-live.json").write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    report = {"scope": "local-only", "checks": results, "block": snapshot["block"]["number"],
              "blockHash": snapshot["block"]["hash"], "demoIndexAvailable": True,
              "demoMarkAvailable": states["demo"]["risk"]["markAvailable"], "passed": True}
    (directory / "api-check.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "checks": len(results), "demoMarkAvailable": report["demoMarkAvailable"]}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"LOCAL API CHECK FAILED: {error}", file=sys.stderr)
        sys.exit(1)
