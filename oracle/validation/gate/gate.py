"""Freeze the gate (plan §8.3, §10 step 2, task O39.3).

Everything here is derived from the train and calibration splits only; the holdout records are dropped before any of
it is computed (a test changes every holdout answer and checks gate.json does not move).

  models          the panel's three families from three providers (gpt-oss-120b on Groq, Kimi K3 on NVIDIA, Gemini
                  3.8 Flash through AICredits); the pilot budget (ADJ-46) allowed no alternative candidates, so the
                  choice is recorded with each model's coverage and accuracy and the pairwise error correlation
  prompts         the pinned per-category templates of the panel runner (O33.2): promptHash = keccak256(template)
  calibration     calibrate.fit on the calibration split → calibration/maps.json, calibratorHash
  highConfBps     θ_hi: the smallest grid value (9,000 … 9,900 bps) at which the train bucket "unanimous YES/NO with
                  every calibrated bps ≥ θ" is non-empty and error-free; 9,900 when no grid value gives such a bucket
  gateHash        keccak256(abi.encode(bytes32[3] modelIdHashes, promptHash, calibratorHash, uint16 highConfBps)),
                  per category (the prompt differs), exactly as MarketRegistry computes it

Records come from the panel runner's validation run (`bun run validate`, gate/runs/panel.jsonl, local); `--import`
strips them to gate/panel-runs.json (ids, labels, confidences, citations, costs; no page or rationale text), which is
committed and pinned by its sha256.

  python3 -m gate.gate --import   # panel.jsonl → panel-runs.json
  python3 -m gate.gate            # writes calibration/maps.json and gate/gate.json
"""

from __future__ import annotations

import hashlib
import json
import sys
from fractions import Fraction
from itertools import combinations
from pathlib import Path

from split.split import SPLIT_FILE

from . import calibrate
from .keccak import hex32, k, keccak256, word

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNS_FILE = HERE / "panel-runs.json"
GATE_FILE = HERE / "gate.json"
MAPS_FILE = ROOT / "calibration" / "maps.json"
TEMPLATES = ROOT.parent / "services" / "panel-runner" / "src" / "prompts" / "templates"
CATEGORIES = ("sports", "macro", "elections", "politics", "crypto", "companies", "other")  # the panel runner's order
MODELS = ("groq:openai/gpt-oss-120b@2026-10-03", "nvidia:moonshotai/kimi-k3@2026-10-03", "aicredits:google/gemini-3.8-flash@2026-10-04")
THETA_GRID = tuple(range(9000, 10000, 100))
THETA_FALLBACK = 9900
BINARY = ("YES", "NO")


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load_runs(path: Path = RUNS_FILE) -> list[dict]:
    return json.loads(path.read_text(), parse_float=Fraction)["records"]


def import_runs(src: Path = HERE / "runs" / "panel.jsonl", dst: Path = RUNS_FILE) -> None:
    keep = ("split", "category", "rank", "parent_id", "market_id", "truth", "status", "evidenceHash", "promptHash")
    records = []
    for line in src.read_text().splitlines():
        r = json.loads(line)
        out = {key: r[key] for key in keep if key in r}
        out["costInr"] = f"{r.get('costInr', 0):.4f}"
        out["items"] = [{"url": it["url"], "httpStatus": it["httpStatus"]} for it in r["items"]]
        out["outcomes"] = [{key: o[key] for key in ("model", "label", "confidence", "cited", "abstainReason")} for o in r.get("outcomes", [])]
        if "watchdog" in r:
            out["watchdog"] = {"model": r["watchdog"]["model"], "outcome": r["watchdog"]["signal"]["outcome"]}
        records.append(out)
    records.sort(key=lambda x: (CATEGORIES.index(x["category"]), ("train", "calibration", "holdout").index(x["split"]), x["rank"]))
    dst.write_text(json.dumps({"schema": "eros-validation-runs/1", "models": list(MODELS), "records": records}, indent=1) + "\n")


def ran(records: list[dict], *splits: str) -> list[dict]:
    return [r for r in records if r["split"] in splits and r["status"] == "RUN"]


def model_stats(records: list[dict], model: str) -> dict:
    known = [(r, o) for r in records for o in r["outcomes"] if o["model"] == model and o["label"] in calibrate.KNOWN]
    return {
        "markets": sum(1 for r in records for o in r["outcomes"] if o["model"] == model),
        "known": len(known),
        "correct": sum(1 for r, o in known if o["label"] == r["truth"]),
        "notYet": sum(1 for r in records for o in r["outcomes"] if o["model"] == model and o["label"] == "NOT_YET"),
        "abstain": sum(1 for r in records for o in r["outcomes"] if o["model"] == model and o["label"] == "ABSTAIN"),
    }


def error_correlation(records: list[dict], a: str, b: str) -> dict:
    """φ between two models' error indicators over markets where both gave a known label (display only).

    Recorded as n and φ² with its sign, exactly; undefined when an indicator never varies."""
    pairs = []
    for r in records:
        la = next(o["label"] for o in r["outcomes"] if o["model"] == a)
        lb = next(o["label"] for o in r["outcomes"] if o["model"] == b)
        if la in calibrate.KNOWN and lb in calibrate.KNOWN:
            pairs.append((int(la != r["truth"]), int(lb != r["truth"])))
    n11 = sum(1 for x, y in pairs if x and y)
    n10 = sum(1 for x, y in pairs if x and not y)
    n01 = sum(1 for x, y in pairs if not x and y)
    n00 = len(pairs) - n11 - n10 - n01
    den = (n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00)
    if den == 0:
        return {"models": [a, b], "n": len(pairs), "phiSquared": None, "sign": None}
    num = n11 * n00 - n10 * n01
    return {"models": [a, b], "n": len(pairs), "phiSquared": str(Fraction(num * num, den)), "sign": (num > 0) - (num < 0)}


def bucket(records: list[dict], maps: list[dict], theta_bps: int) -> list[dict]:
    """Records where the three labels are the same YES or NO and every calibrated confidence reaches θ."""
    out = []
    for r in records:
        os_ = [next(o for o in r["outcomes"] if o["model"] == m["model"]) for m in maps]
        labels = {o["label"] for o in os_}
        if len(labels) == 1 and labels <= set(BINARY) and all(calibrate.calibrated_bps(m, o["confidence"]) >= theta_bps for m, o in zip(maps, os_)):
            out.append(r)
    return out


def choose_theta(train: list[dict], maps: list[dict]) -> tuple[int, str]:
    for t in THETA_GRID:
        b = bucket(train, maps, t)
        if b and all(r["outcomes"][0]["label"] == r["truth"] for r in b):
            return t, f"smallest grid value with a non-empty, error-free train bucket ({len(b)} markets)"
    return THETA_FALLBACK, "no grid value gives a non-empty error-free train bucket: the most conservative grid value"


def prompt_hash(category: str) -> str:
    return hex32(keccak256((TEMPLATES / f"{category}.txt").read_bytes()))


def gate_hash(model_id_hashes: list[str], prompt: str, calibrator: str, high_conf_bps: int) -> str:
    return hex32(keccak256(b"".join(word(h) for h in model_id_hashes) + word(prompt) + word(calibrator) + word(high_conf_bps)))


def freeze(records: list[dict]) -> tuple[dict, list[dict]]:
    """The gate and the calibration maps, from the train and calibration records only."""
    records = [r for r in records if r["split"] in ("train", "calibration")]  # the holdout never enters
    train, cal = ran(records, "train"), ran(records, "calibration")
    maps = [calibrate.fit(cal, m) for m in MODELS]
    theta, rule = choose_theta(train, maps)
    ids = [k(m) for m in MODELS]
    chash = calibrate.calibrator_hash(maps)
    both = train + cal
    gate = {
        "schema": "eros-validation-gate/1",
        "derivedFrom": ["train", "calibration"],
        "data": {
            "rowsSha256": json.loads(SPLIT_FILE.read_text())["rowsSha256"],
            "splitSha256": sha256_file(SPLIT_FILE),
            "runsSha256": sha256_file(RUNS_FILE),
            "records": {"train": len([r for r in records if r["split"] == "train"]), "calibration": len([r for r in records if r["split"] == "calibration"]), "ran": len(both)},
        },
        "models": list(MODELS),
        "modelIdHashes": ids,
        "modelStats": {m: model_stats(both, m) for m in MODELS},
        "errorCorrelation": [error_correlation(both, a, b) for a, b in combinations(MODELS, 2)],
        "calibration": {"file": "calibration/maps.json", "minParents": calibrate.MIN_PARENTS, "calibratorHash": chash, "placeholder": [m["model"] for m in maps if m["breakpoints"] == [[Fraction(0), calibrate.PLACEHOLDER], [Fraction(1), calibrate.PLACEHOLDER]]]},
        "highConfBps": theta,
        "highConfRule": rule,
        "categories": {
            c: {"categoryId": k(c), "promptHash": prompt_hash(c), "gateHash": gate_hash(ids, prompt_hash(c), chash, theta)} for c in CATEGORIES
        },
    }
    return gate, maps


def main() -> None:
    if "--import" in sys.argv:
        import_runs()
        print(f"wrote {RUNS_FILE}")
        return
    gate, maps = freeze(load_runs())
    MAPS_FILE.write_text(calibrate.dumps_maps(maps))
    GATE_FILE.write_text(json.dumps(gate, indent=2) + "\n")
    print(f"wrote {MAPS_FILE} and {GATE_FILE}: highConfBps {gate['highConfBps']}, calibratorHash {gate['calibration']['calibratorHash']}")


if __name__ == "__main__":
    main()
