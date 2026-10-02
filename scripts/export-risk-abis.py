"""Build and export production ABIs, excluding concrete test compositions.

The source digest hashes sorted, compact JSON mapping compiler dependency paths
to SHA-256 hashes of their canonical LF bytes (CRLF is normalized to LF).
The abstract engine ABI is not a deployment ABI.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"
EXPORTS = (
    (
        "RiskAccountingBridge.sol/RiskAccountingBridge.json",
        "engine-abi.json",
        "External ABI of the abstract RiskAccountingBridge (Person B controllers + Person A accounting). "
        "Exported directly from the production composition, not CombinedEngine or MockBookAdapter. "
        "Includes OrderAdmissionMath.ReservationUnderflow, a production library error omitted "
        "from the abstract contract's compiler ABI. "
        "No deployment constructor or book hook internals are included; a concrete production engine "
        "must supply the book adapter and deployment wiring. integration/risk.",
        (("OrderAdmissionMath.sol/OrderAdmissionMath.json", "ReservationUnderflow"),),
    ),
    (
        "CollateralVault.sol/CollateralVault.json",
        "vault-abi.json",
        "CollateralVault ABI, including its production constructor (A017).",
        (),
    ),
)


def export_payload(artifact_path, note, additional_errors):
    artifact = json.loads((CONTRACTS / "out" / artifact_path).read_text(encoding="utf-8"))
    metadata = artifact["metadata"]
    source_hashes = {
        relative: hashlib.sha256((CONTRACTS / relative).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
        for relative in sorted(metadata["sources"])
    }
    source_digest = hashlib.sha256(
        json.dumps(source_hashes, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    abi = artifact["abi"]
    for library_path, error_name in additional_errors:
        library = json.loads((CONTRACTS / "out" / library_path).read_text(encoding="utf-8"))
        entry = next(item for item in library["abi"] if item["type"] == "error" and item["name"] == error_name)
        if entry not in abi:
            abi.append(entry)
    payload = {
        "note": note,
        "source": metadata["settings"]["compilationTarget"],
        "compiler": metadata["compiler"]["version"],
        "source_sha256": source_digest,
        "abi": abi,
    }
    return json.dumps(payload, indent=1) + "\n", len(source_hashes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forge", default="forge", help="Forge executable (use the pinned CI version)")
    parser.add_argument("--check", action="store_true", help="Fail instead of updating stale exports")
    arguments = parser.parse_args()
    forge_path = Path(arguments.forge)
    forge = str(forge_path.resolve()) if forge_path.is_file() else arguments.forge
    subprocess.run([forge, "build", "src/engine/RiskAccountingBridge.sol",
                    "src/vaults/CollateralVault.sol", "--skip-lint"], cwd=CONTRACTS, check=True)
    stale = False
    for artifact_path, filename, note, additional_errors in EXPORTS:
        content, source_count = export_payload(artifact_path, note, additional_errors)
        destination = ROOT / "artifacts" / "risk" / filename
        if arguments.check:
            matches = destination.is_file() and destination.read_text(encoding="utf-8") == content
            stale = stale or not matches
            print(f"{filename}: {'current' if matches else 'STALE'}")
        else:
            destination.write_text(content, encoding="utf-8", newline="\n")
        payload = json.loads(content)
        print(f"{filename}: {len(payload['abi'])} ABI entries, {source_count} source files, "
              f"source SHA-256 {payload['source_sha256']}")
    return 1 if stale else 0


if __name__ == "__main__":
    raise SystemExit(main())
