"""Read-only acceptance checks for the running loopback team API."""
import json
import argparse
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

PUBLIC_FIELDS = {"manifestVersion", "scope", "chainId", "sourceCommit", "riskScenario", "sourceMode",
                 "calibrationEvidence", "provenance", "verifiedAt", "contracts", "markets", "accounts"}
MARKET_FIELDS = {"name", "engine", "marketId", "sourceId", "listingHash", "codehash", "deployBlock",
                 "deploymentCapX", "template", "maxLiqLotsPerBlock", "fundingEnabled"}
SNAPSHOT_FIELDS = PUBLIC_FIELDS - {"contracts", "markets", "accounts"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise RuntimeError("Local API redirects are forbidden")


def runtime_path(root, scenario, explicit=None):
    path = Path(explicit).resolve() if explicit else root / "tmp" / ("local-leverage-latest.json" if scenario == "leveraged" else "local-integration-latest.json")
    if not path.resolve().is_relative_to((root / "tmp").resolve()):
        raise RuntimeError("Runtime pointer must remain in the repository's ignored tmp directory")
    return path


def check_public_manifest(value):
    def private_field(item):
        if isinstance(item, dict):
            return any(re.sub(r"[^a-z]", "", key.lower()) in {"rpcurl", "privatekey", "apikey", "apitoken", "password", "passphrase", "mnemonic"}
                       or private_field(child) for key, child in item.items())
        return isinstance(item, list) and any(private_field(child) for child in item)
    if value.get("manifestVersion") != 1 or set(value) - PUBLIC_FIELDS or private_field(value):
        raise RuntimeError("Public manifest must be versioned and contain no private transport or credentials")


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return value.lower() if isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]+", value) else value


def check_manifest_snapshot(manifest, snapshot, enrolled, runtime):
    check_public_manifest(manifest)
    expected = {key: value for key, value in enrolled.items() if key in PUBLIC_FIELDS}
    expected.setdefault("manifestVersion", 1)
    expected.setdefault("sourceMode", "fixture")
    expected.setdefault("riskScenario", "fully-backed")
    expected.setdefault("accounts", {})
    expected.setdefault("provenance", {"collateral": "fixture", "resolution": "fixture",
        "index": "external" if expected["sourceMode"] == "polymarket" else "fixture",
        "calibration": "synthetic" if expected["riskScenario"] == "leveraged-fixture" else "none"})
    if normalized(manifest) != normalized(expected):
        raise RuntimeError("Public manifest differs from the verified enrollment")
    expected_mode = runtime.get("sourceMode", "fixture")
    if manifest.get("sourceMode") != expected_mode or expected_mode not in {"fixture", "polymarket"}:
        raise RuntimeError("Public manifest source mode differs from the requested runtime")
    identities = lambda value: sorted((normalized({key: item for key, item in market.items() if key in MARKET_FIELDS})
                                      for market in value["markets"]), key=lambda market: market["name"])
    if (any(normalized(manifest.get(key)) != normalized(snapshot.get(key)) for key in SNAPSHOT_FIELDS)
            or identities(manifest) != identities(snapshot)):
        raise RuntimeError("Public manifest differs from the verified API snapshot")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=["fully-backed", "leveraged"], default="fully-backed")
    parser.add_argument("--runtime", help="Explicit runtime pointer in tmp; overrides --scenario")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    runtime = json.loads(runtime_path(root, args.scenario, args.runtime).read_text())
    endpoint = runtime["readUrl"]
    if runtime["scope"] != "local-only" or not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", endpoint):
        raise RuntimeError("Only a local integration API can be probed")
    directory = Path(runtime["directory"]).resolve()
    if not directory.is_relative_to((root / "tmp").resolve()) or not directory.is_dir():
        raise RuntimeError("Probe evidence must remain in the repository's local run directory")
    enrolled = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    results = []
    snapshot = None
    manifest = None
    for route, method, origin, expected in [
        ("/health", "GET", None, 200), ("/manifest", "GET", None, 200),
        ("/snapshot", "GET", "http://localhost:5173", 200), ("/events", "GET", None, 200),
        ("/abi/engine", "GET", None, 200), ("/abi/vault", "GET", None, 200),
        ("/abi/oracle", "GET", None, 200), ("/abi/registry", "GET", None, 200),
        ("/abi/factory", "GET", None, 200),
        ("/snapshot?owner=0x0000000000000000000000000000000000000123", "GET", None, 200),
        ("/snapshot?owner=invalid", "GET", None, 400),
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
            if route == "/manifest":
                check_public_manifest(value)
                manifest = value
            if route.startswith("/snapshot?owner=0x"):
                for market in value["markets"]:
                    if len(market["accounts"]) != 1 or market["accounts"][0]["owner"].lower() != "0x0000000000000000000000000000000000000123":
                        raise RuntimeError("Arbitrary owner query returned fixture accounts")
            if route == "/events" and not {"fromBlock", "toBlock", "nextFromBlock", "records"}.issubset(value):
                raise RuntimeError("Missing bounded event pagination metadata")
            results.append({"route": route, "method": method, "origin": origin, "status": response.status})
    check_manifest_snapshot(manifest, snapshot, enrolled, runtime)
    states = {market["name"]: market for market in snapshot["markets"]}
    live_source = snapshot.get("sourceMode") == "polymarket"
    if snapshot["chainId"] != 31337 or states["demo"]["halt"]["halted"] or (not live_source and not states["terminal"]["settlement"]["claimsEnabled"]):
        raise RuntimeError("Live API lifecycle differs from the intended demo")
    if not states["demo"]["risk"]["indexAvailable"] or int(snapshot["custodyAtoms"]) < int(snapshot["recognizedAtoms"]):
        raise RuntimeError("Live demo pricing or custody is unhealthy")
    (directory / "public-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (directory / "snapshot-live.json").write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    report = {"scope": "local-only", "scenario": runtime.get("scenario", args.scenario), "checks": results, "block": snapshot["block"]["number"],
              "sourceMode": snapshot.get("sourceMode"), "provenance": snapshot.get("provenance"),
              "blockHash": snapshot["block"]["hash"], "demoIndexAvailable": True,
              "demoMarkAvailable": states["demo"]["risk"]["markAvailable"],
              "terminalClaimsEnabled": states["terminal"]["settlement"]["claimsEnabled"],
              "terminalPolicy": "unresolved control; terminal settlement is covered by the deterministic fixture" if live_source else "settled deterministic control",
              "passed": True}
    (directory / "api-check.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "checks": len(results), "demoMarkAvailable": report["demoMarkAvailable"]}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"LOCAL API CHECK FAILED: {error}", file=sys.stderr)
        sys.exit(1)
