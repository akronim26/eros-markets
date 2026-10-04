#!/usr/bin/env python3
"""Testnet hackathon custody (X03 profile, ADJ-38): every §12.1 role as a hot key.

The contracts check addresses and signatures, not custody, so on testnet each role can be a plain key. Mainnet
keeps the full §12.1 custody (hardware wallets, Safes, KMS attestor, separate watchdog account).

  python3 script/testnet_keys.py generate   # new keys -> deployments/testnet-keys.env (git-ignored), addresses
                                            # -> deployments/params.monad-testnet.json, sim relayer key ->
                                            # workflows/.env (CRE_ETH_PRIVATE_KEY)
  python3 script/testnet_keys.py show       # the addresses
  python3 script/testnet_keys.py fund [--amount 0.05] [--rpc URL]
                                            # MON from the deployer to every role that sends transactions

Keys are never printed by `generate` or `show`. `generate` refuses to replace an existing key file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ORACLE = Path(__file__).resolve().parent.parent
KEYS = ORACLE / "deployments" / "testnet-keys.env"
PARAMS = ORACLE / "deployments" / "params.monad-testnet.json"
WORKFLOW_ENV = ORACLE / "workflows" / ".env"
RPC = "https://testnet-rpc.monad.xyz"

# role -> sends transactions (and so is funded)
ROLES = {
    "DEPLOYER": True,       # deploys; on testnet also pays for the deployment
    "LISTER": True,         # stands in for the team Safe: Timelock proposer/canceller and registry lister
    "GUARDIAN": True,       # stands in for the guardian Safe (revoke-only)
    "COMMITTEE_1": False,   # committee members sign EIP-712 proposals; a relayer submits them
    "COMMITTEE_2": False,
    "COMMITTEE_3": False,
    "ATTESTOR": False,      # signs PanelResults (stands in for the KMS key); the keeper submits
    "WATCHDOG": True,       # disputes from the treasury float
    "KEEPER_1": True,       # keeper jobs and panel/committee submission
    "KEEPER_2": True,
    "SIM_RELAYER": True,    # CRE_ETH_PRIVATE_KEY for `cre workflow simulate --broadcast`
}


def cast(*args: str) -> str:
    return subprocess.run(["cast", *args], check=True, capture_output=True, text=True).stdout.strip()


def load_keys() -> dict[str, str]:
    if not KEYS.exists():
        sys.exit(f"{KEYS} does not exist: run `generate` first")
    return dict(line.split("=", 1) for line in KEYS.read_text().splitlines() if "=" in line and not line.startswith("#"))


def addresses(keys: dict[str, str]) -> dict[str, str]:
    return {r: keys[f"{r}_ADDRESS"] for r in ROLES}


def generate() -> None:
    if KEYS.exists():
        sys.exit(f"{KEYS} exists: refusing to replace keys that may hold funds or roles")
    wallets = json.loads(cast("wallet", "new", "--number", str(len(ROLES)), "--json"))
    lines = ["# Testnet hot keys (ADJ-38). NEVER commit; never use on mainnet."]
    for role, w in zip(ROLES, wallets):
        lines += [f"{role}_ADDRESS={w['address']}", f"{role}_PRIVATE_KEY={w['private_key']}"]
    KEYS.write_text("\n".join(lines) + "\n")
    os.chmod(KEYS, 0o600)
    keys = load_keys()
    a = addresses(keys)

    params = json.loads(PARAMS.read_text())
    params["roles"]["teamSafe"] = a["LISTER"]
    params["roles"]["guardianSafe"] = a["GUARDIAN"]
    params["trustSet"]["runnerAttestor"] = a["ATTESTOR"]
    params["trustSet"]["committee"] = sorted((a["COMMITTEE_1"], a["COMMITTEE_2"], a["COMMITTEE_3"]), key=lambda x: int(x, 16))
    params["trustSet"]["watchdog"] = a["WATCHDOG"]
    params["cre"]["simRelayers"] = [a["SIM_RELAYER"]]
    PARAMS.write_text(json.dumps(params, indent=2) + "\n")

    env = WORKFLOW_ENV.read_text() if WORKFLOW_ENV.exists() else ""
    line = f"CRE_ETH_PRIVATE_KEY={keys['SIM_RELAYER_PRIVATE_KEY']}"
    env = re.sub(r"^CRE_ETH_PRIVATE_KEY=.*$", line, env, flags=re.M) if re.search(r"^CRE_ETH_PRIVATE_KEY=", env, re.M) else env + line + "\n"
    WORKFLOW_ENV.write_text(env)
    show()
    print(f"\nkeys: {KEYS} (mode 600, git-ignored)\nparams: {PARAMS}\nsim relayer key: {WORKFLOW_ENV}")
    print(f"\nNext: get testnet MON from https://faucet.monad.xyz for the DEPLOYER, then run `fund`.")


def show() -> None:
    for role, addr in addresses(load_keys()).items():
        print(f"{role:12} {addr}{'' if ROLES[role] else '   (signs only, not funded)'}")


def fund(amount: str, rpc: str) -> None:
    keys = load_keys()
    a = addresses(keys)
    balance = int(cast("balance", a["DEPLOYER"], "--rpc-url", rpc))
    each = int(cast("to-wei", amount))
    targets = [r for r, sends in ROLES.items() if sends and r != "DEPLOYER"]
    need = each * len(targets)
    print(f"deployer {a['DEPLOYER']}: {cast('from-wei', str(balance))} MON; sending {amount} MON to {len(targets)} roles")
    if balance < need * 2:  # keep at least as much as is sent, for the deployment itself
        sys.exit(f"deployer needs at least {cast('from-wei', str(need * 2))} MON (half stays for the deployment)")
    for r in targets:
        have = int(cast("balance", a[r], "--rpc-url", rpc))
        if have >= each:
            print(f"{r:12} already has {cast('from-wei', str(have))} MON")
            continue
        cast("send", a[r], "--value", str(each - have), "--private-key", keys["DEPLOYER_PRIVATE_KEY"], "--rpc-url", rpc)
        print(f"{r:12} funded to {amount} MON")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate")
    sub.add_parser("show")
    f = sub.add_parser("fund")
    f.add_argument("--amount", default="0.05", help="MON per funded role")
    f.add_argument("--rpc", default=RPC)
    args = ap.parse_args()
    {"generate": generate, "show": show}.get(args.cmd, lambda: fund(args.amount, args.rpc))()


if __name__ == "__main__":
    main()
