"""Read-only integrated Monad readiness and optional disposable loopback rehearsal.

This entrypoint never loads a wallet or private dotenv file. Public RPC calls are
allowlisted reads. --rehearse-local additionally requires an explicit loopback
Anvil endpoint; its impersonated transactions are reverted to a snapshot afterward.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def local_endpoint(endpoint):
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.username or parsed.password or parsed.fragment or parsed.query or parsed.path not in ("", "/")):
        raise ValueError("--rehearse-local requires an explicit loopback Anvil RPC")
    return endpoint


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    rpc = parser.add_mutually_exclusive_group()
    rpc.add_argument("--rpc", help="RPC endpoint; defaults to the public Monad testnet RPC")
    rpc.add_argument("--rpc-env", help="Read this named process variable, without loading any dotenv file")
    parser.add_argument("--deployments", type=Path, default=ROOT / "oracle/deployments/monad-testnet.json")
    parser.add_argument("--config", type=Path, help="Reviewed integrated input JSON; omission only inspects existing deployment")
    parser.add_argument("--output", type=Path, required=True, help="Report under ignored repository tmp/")
    parser.add_argument("--rehearse-local", action="store_true", help="Execute the unsigned bundle on disposable loopback Anvil only, then restore a snapshot")
    args = parser.parse_args(argv)
    endpoint = os.environ.get(args.rpc_env) if args.rpc_env else args.rpc or "https://testnet-rpc.monad.xyz"
    if not endpoint:
        parser.error("The selected RPC environment variable is unset")
    if args.rehearse_local:
        if not args.config or not (args.rpc or args.rpc_env):
            parser.error("--rehearse-local requires --config and an explicit --rpc or --rpc-env")
        try:
            local_endpoint(endpoint)
        except ValueError as error:
            parser.error(str(error))
    output = args.output.resolve()
    if not output.is_relative_to((ROOT / "tmp").resolve()) or output.suffix != ".json":
        parser.error("--output must be a JSON report inside repository tmp/")
    protected = {args.deployments.resolve(), Path(__file__).resolve()}
    if args.config:
        protected.add(args.config.resolve())
    if output in protected:
        parser.error("Report must not replace a source/input file")
    bun = os.environ.get("LOCAL_BUN") or shutil.which("bun")
    if not bun:
        parser.error("Install the pinned Bun or set LOCAL_BUN")
    environment = {name: value for name, value in os.environ.items()
                   if not any(token in name.upper() for token in ("PRIVATE_KEY", "API_KEY", "API_TOKEN", "RPC_URL", "MONAD_", "INTEGRATED_PREFLIGHT_RPC"))}
    environment["INTEGRATED_PREFLIGHT_RPC"] = endpoint
    command = [bun, "--no-env-file", str(ROOT / "oracle/script/integration/prepare-integrated.ts"),
               "rehearse-local" if args.rehearse_local else "inspect", str(args.deployments.resolve()), str(output)]
    if args.config:
        command.append(str(args.config.resolve()))
    result = subprocess.run(command, cwd=ROOT / "oracle", env=environment,
                            capture_output=True, text=True, encoding="utf-8",
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    # Windows CREATE_NO_WINDOW detaches inherited console handles. Capture and
    # relay the helper's summary so the CLI still reports its readiness status.
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr.replace(endpoint, "[redacted]"))
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
