"""The raw store as one immutable release asset (task O39.1).

The raw pulls are too large for git, and the APIs cannot reproduce them later, so they are published once as a
GitHub Release asset. The repository keeps raw/MANIFEST.json (every file's sha256) and snapshot.json (the asset's
name, URL and sha256); `fetch` downloads the asset, checks it and every file in it.

  python3 -m dataset.snapshot pack                 # raw/ -> raw.tar.gz and snapshot.json
  python3 -m dataset.snapshot fetch                # download raw.tar.gz from snapshot.json's URL, verify, unpack
  python3 -m dataset.snapshot unpack raw.tar.gz    # verify and unpack a local copy

The tarball is byte-reproducible: files in manifest order, fixed mode, owner and time, gzip without a time stamp.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

from .build import load_raw

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
ASSET = "raw.tar.gz"
RELEASE_TAG = "validation-dataset-v1"
REPO = "xipharis/eros-markets"


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def pack(root: Path = RAW) -> bytes:
    """raw/ as a deterministic tar.gz: MANIFEST.json, then every file the manifest lists, in its order."""
    manifest = json.loads((root / "MANIFEST.json").read_text())
    names = ["MANIFEST.json"] + [f["file"] for f in manifest["files"]]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in names:
            data = (root / name).read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = len(data), 0o644, 0, 0, 0, "", ""
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(buf.getvalue(), mtime=0)


def unpack(blob: bytes, root: Path = RAW, expected_sha256: str | None = None) -> dict:
    """Checks the asset's hash, extracts only the manifest's files, then checks every file (build.load_raw)."""
    if expected_sha256 is not None and sha256(blob) != expected_sha256:
        raise ValueError(f"{ASSET}: sha256 {sha256(blob)} is not the recorded {expected_sha256}")
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob)), mode="r") as tar:
        members = {m.name: m for m in tar.getmembers() if m.isfile()}
        manifest = json.loads(tar.extractfile(members["MANIFEST.json"]).read())
        for name in ["MANIFEST.json"] + [f["file"] for f in manifest["files"]]:
            if name not in members or name.startswith("/") or ".." in Path(name).parts:
                raise ValueError(f"{ASSET}: {name} missing or unsafe")
            out = root / name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tar.extractfile(members[name]).read())
    load_raw(root)  # every file against its sha256
    return manifest


def write_snapshot(blob: bytes, out: Path = HERE, root: Path = RAW) -> dict:
    snap = {
        "schema": "eros-validation-snapshot/1",
        "asset": ASSET,
        "release": RELEASE_TAG,
        "url": f"https://github.com/{REPO}/releases/download/{RELEASE_TAG}/{ASSET}",
        "bytes": len(blob),
        "sha256": sha256(blob),
        "manifestSha256": sha256((root / "MANIFEST.json").read_bytes()),
    }
    (out / "snapshot.json").write_text(json.dumps(snap, indent=2) + "\n")
    return snap


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pack")
    sub.add_parser("fetch")
    u = sub.add_parser("unpack")
    u.add_argument("file")
    a = ap.parse_args(argv)
    if a.cmd == "pack":
        blob = pack()
        (HERE / ASSET).write_bytes(blob)
        snap = write_snapshot(blob)
        print(f"wrote {HERE / ASSET} ({snap['bytes']} bytes, sha256 {snap['sha256']}) and snapshot.json")
        return
    snap = json.loads((HERE / "snapshot.json").read_text())
    if a.cmd == "fetch":
        with urllib.request.urlopen(snap["url"], timeout=300) as r:
            blob = r.read()
    else:
        blob = Path(a.file).read_bytes()
    manifest = unpack(blob, RAW, snap["sha256"])
    print(f"verified and unpacked {len(manifest['files'])} files into {RAW}")


if __name__ == "__main__":
    main()
