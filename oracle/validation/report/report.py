"""The validation report, review limit and governance proposals (plan §10 steps 6-7, §14.3, task O39.6).

Reads the frozen gate, the maps and the holdout measurement and writes report/report.json and
docs_oracle/validation-report.md with every data hash and the code commit. For each category:

  OI_review = c_r / (Δp − r·T_r)   with Δp = U95 (u95Bps / 10,000), c_r = $50, r = 10%/year, T_r = 2 h  (§14.3)

exactly; reviewLimitAtoms is its floor in USDC atoms (a lower limit sends more to review). When Δp ≤ r·T_r there is
no finite limit. A setCategory(categoryId, gateHash, u95Bps, N, true) call is prepared only for a category with
u95Bps ≤ 200 (Δp_max 2%) and N ≥ 150 (N_min); each is the registry calldata a Timelock operation carries
(script/GovernanceOp.sol builds and proposes operations from calls).

  python3 -m report.report        # writes report/report.json, report/crypto-price.json and docs_oracle/validation-report.md
"""

from __future__ import annotations

import json
import subprocess
from fractions import Fraction
from pathlib import Path

from gate.gate import CRYPTO, PILOT, ROOT, Run, load_runs, sha256_file
from gate.keccak import keccak256, word
from measure.bound import BPS
from measure.measure import out_file
from split.split import SPLIT_FILE

HERE = Path(__file__).resolve().parent
OUT = HERE / "report.json"


def report_file(run: Run) -> Path:
    return OUT if run is PILOT else HERE / f"{run.name}.json"
DOC = ROOT.parent.parent / "docs_oracle" / "validation-report.md"
C_R = Fraction(50)  # review cost, USD
R_TR = Fraction(1, 10) * Fraction(2 * 3600, 365 * 86400)  # r·T_r: 10%/year for 2 h = 1/43,800
DELTA_PMAX_BPS, N_MIN = 200, 150
ATOMS = 10**6
SET_CATEGORY = keccak256(b"setCategory(bytes32,bytes32,uint16,uint32,bool)")[:4]


def oi_review(u95_bps: int) -> Fraction | None:
    """c_r / (Δp − r·T_r) in USD, or None when Δp ≤ r·T_r (no finite limit)."""
    dp = Fraction(u95_bps, BPS)
    return None if dp <= R_TR else C_R / (dp - R_TR)


def set_category_calldata(category_id: str, gate_hash: str, u95: int, n: int) -> str:
    return "0x" + (SET_CATEGORY + word(category_id) + word(gate_hash) + word(u95) + word(n) + word(True)).hex()


def usd(x: Fraction | None) -> str:
    if x is None:
        return "no finite limit"
    cents = (x.numerator * 100) // x.denominator
    return f"${cents // 100:,}.{cents % 100:02d}"


def build(gate: dict, measure: dict, commit: str, run: Run = PILOT) -> dict:
    cats = {}
    for c, m in measure["categories"].items():
        oi = oi_review(m["u95Bps"])
        proposal = None
        if m["u95Bps"] <= DELTA_PMAX_BPS and m["N"] >= N_MIN:
            g = gate["categories"][c]
            proposal = {"to": "MarketRegistry", "call": f"setCategory({g['categoryId']}, {g['gateHash']}, {m['u95Bps']}, {m['N']}, true)", "data": set_category_calldata(g["categoryId"], g["gateHash"], m["u95Bps"], m["N"])}
        cats[c] = {**m, "oiReviewUsd": usd(oi), "reviewLimitAtoms": None if oi is None else str((oi * ATOMS).numerator // (oi * ATOMS).denominator), "setCategory": proposal}
    dataset = ROOT / "dataset"
    pinned = (
        {"rowsSha256": json.loads(SPLIT_FILE.read_text())["rowsSha256"], "rawTarSha256": json.loads((dataset / "snapshot.json").read_text())["sha256"],
         "manifestSha256": json.loads((dataset / "snapshot.json").read_text())["manifestSha256"]}
        if run is PILOT else run.dataset()
    )
    return {
        "schema": "eros-validation-report/1",
        **({"run": run.name} if run is not PILOT else {}),
        "codeCommit": commit,
        "data": {
            **pinned,
            "splitSha256": sha256_file(SPLIT_FILE),
            "runsSha256": sha256_file(run.runs_file),
            "gateSha256": sha256_file(run.gate_file),
            "mapsSha256": sha256_file(run.maps_file),
            "measureSha256": sha256_file(out_file(run)),
        },
        "gate": {k: gate[k] for k in ("models", "modelIdHashes", "highConfBps", "highConfRule")} | {"calibratorHash": gate["calibration"]["calibratorHash"]},
        "thresholds": {"deltaPmaxBps": DELTA_PMAX_BPS, "nMin": N_MIN, "reviewCostUsd": str(C_R), "rTimesTr": str(R_TR)},
        "categories": cats,
        "proposals": [{"category": c, **v["setCategory"]} for c, v in cats.items() if v["setCategory"]],
        "errorCorrelation": measure["errorCorrelation"],
        "watchdog": measure["watchdog"],
    }


def section(rep: dict, gate: dict, runs: list[dict], title: str, about: str) -> list[str]:
    spent = sum(Fraction(r["costInr"]) for r in runs)
    ran = [r for r in runs if r["status"] == "RUN"]
    asked = sum(1 for r in ran for o in r["outcomes"] if o["model"].startswith("aicredits:") and o["label"] != "SKIPPED")
    lines = [
        f"## {title}",
        "",
        about.format(sampled=len(runs), ran=len(ran), spent=f"₹{float(spent):.2f}", asked=asked),
        "",
        "### Data and code",
        "",
        f"- Code commit: `{rep['codeCommit']}`",
    ]
    lines += [f"- {k}: `{v}`" for k, v in rep["data"].items()]
    lines += [
        "",
        "Raw pulls and rows stay local (ADJ-39); the hashes above pin them. The split is by parent, frozen before any tuning (O39.2).",
        "",
        "### Frozen gate (train and calibration splits only)",
        "",
        f"- Models: {', '.join(f'`{m}`' for m in gate['models'])}",
        f"- θ_hi (highConfBps): {gate['highConfBps']} — {gate['highConfRule']}",
        f"- calibratorHash: `{gate['calibration']['calibratorHash']}`"
        + (f" (placeholder 0.49 maps for {len(gate['calibration']['placeholder'])} of 3 models: fewer than {gate['calibration']['minParents']} parents with known answers)" if gate["calibration"]["placeholder"] else ""),
        "",
        "| Model | Answers | Known (YES/NO/INVALID) | Correct | NOT_YET | ABSTAIN |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    lines += [f"| `{m}` | {s['markets']} | {s['known']} | {s['correct']} | {s['notYet']} | {s['abstain']} |" for m, s in gate["modelStats"].items()]
    lines += [
        "",
        "### Holdout, per category",
        "",
        "| Category | Holdout markets | Put to the panel | Bucket markets | N (parents) | k | U95 | u95Bps | OI_review | Passes |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for c, v in rep["categories"].items():
        lines.append(f"| {c} | {v['holdoutRecords']} | {v['ran']} | {v['bucketMarkets']} | {v['N']} | {v['k']} | {v['u95']} | {v['u95Bps']} | {v['oiReviewUsd']} | {'yes' if v['passes'] else 'no'} |")
    w = rep["watchdog"]
    lines += [
        "",
        "U95 = BetaInv(0.95; k+1, N−k) (Clopper–Pearson), exact, rounded up to a basis point; N = 0 bounds nothing (100%).",
        f"OI_review = c_r / (Δp − r·T_r) with c_r = $50, r·T_r = 10%/year × 2 h = {rep['thresholds']['rTimesTr']}, Δp = U95.",
        "",
        "### Error correlation and the watchdog",
        "",
        "- Pairwise error correlation φ (markets where both models gave a known label): "
        + "; ".join(f"{e['models'][0].split(':')[1].split('@')[0]} × {e['models'][1].split(':')[1].split('@')[0]}: n = {e['n']}, φ² = {e['phiSquared'] if e['phiSquared'] is not None else 'undefined'}" for e in rep["errorCorrelation"]),
        f"- Watchdog miss rate f on the panel's own holdout errors: {w['f'] if w['f'] is not None else 'undefined'} ({w['panelErrors']} panel errors, {w['misses']} missed)",
        "",
        "### Governance",
        "",
    ]
    if rep["proposals"]:
        lines += [f"- {p['category']}: `{p['call']}` — calldata `{p['data']}`. Run as a Timelock operation with `script/SetCategory.s.sol` (CATEGORY_ID, GATE_HASH, U95_BPS, SAMPLE_N)." for p in rep["proposals"]]
    else:
        lines.append("No category meets U95 ≤ 2% and N ≥ 150, so no `setCategory` operation is prepared.")
    return lines + [""]


CRYPTO_ABOUT = (
    "Run for ADJ-47: Kalshi's crypto price-threshold markets (\"<asset> price at <time>: <strike> or above\"), from their own hashed pull, "
    "judged on Binance's 1-minute candles for the resolution minute (fetched now, but historical candles do not change). "
    "Gemini is Gemini 3.5 Flash-Lite through AICredits, asked only when the two free models agree on YES or NO outside the calibration split. "
    "{sampled} sampled markets, {ran} put to the panel, {asked} paid Gemini calls, {spent} spent. "
    "Errors are counted against Kalshi's official result, which follows the CF Benchmarks index, not Binance: a market near its strike can differ, which counts against the panel."
)
PILOT_ABOUT = (
    "Pilot for ADJ-46: {sampled} sampled markets, {ran} with fetchable evidence put to the panel, {spent} spent on model calls. "
    "The evidence for each historical market is a snapshot, taken now, of the pages its rules cite. Those pages show the current state (a homepage, the latest release), not the resolved result, so the panel mostly answered NOT_YET and no category came near the 150 unique parents its bucket needs."
)


def markdown(reports: list[tuple[dict, dict, list[dict], str, str]]) -> str:
    proposals = [p for rep, *_ in reports for p in rep["proposals"]]
    lines = [
        "# Layer 2 validation report",
        "",
        "Plan §10, task O39.6. Generated by `oracle/validation/report/report.py` from each run's frozen gate, calibration maps and",
        "holdout measurement; every number below is recomputed from the committed files by the validation tests.",
        "",
        "## Result",
        "",
        f"**Categories validated for the auto path: {len(proposals)}"
        + (f" ({', '.join(p['category'] for p in proposals)}).** Each has a `setCategory` operation below; until it is executed through the Timelock every Layer 2 result keeps going to the committee (plan §8.6)."
           if proposals else ".** No `setCategory` Timelock operation is proposed; every Layer 2 result keeps going to the committee (plan §8.6), which is how the oracle launches."),
        "With no category validated, `reviewLimitAtoms` stays at the placeholder $1,668 (plan §10 step 7: raised only from a measured U95)." if not proposals else "",
        "",
    ]
    for rep, gate, runs, title, about in reports:
        lines += section(rep, gate, runs, title, about)
    lines += CRYPTO_ATTEMPT
    return "\n".join(lines).rstrip("\n") + "\n"


CRYPTO_ATTEMPT = [
    "## Crypto-price attempt (ADJ-47): stopped after two trial markets",
    "",
    "A separate run tried to validate a `crypto-price` category on Kalshi's settled \"<asset> price at <time>: <strike> or above\" markets "
    "(their own hashed pull: 258 parents, 123 in the holdout, below the 150 the gate needs) with Binance's 1-minute candles as evidence and "
    "Gemini 3.5 Flash-Lite as the paid model. It was stopped by the team after two trials of the same market (₹0.29): the historical rules name "
    "the CF Benchmarks index, which cannot be fetched, and say the market resolves No when that data is unavailable, so a careful model "
    "(GPT-OSS) refused the Binance substitute, one (Gemini Flash-Lite) misread the candles, and only Kimi answered the obvious YES. With the "
    "rules and the evidence naming different sources, almost no market could reach a unanimous answer. No gate was frozen for it.",
    "",
    "Crypto rarely needs Layer 2 at all: a crypto market listed on Eros names a price API in its FeedSpec (for example Binance's klines "
    "endpoint), and Layer 1 resolves it from that API deterministically. It falls back to Layer 2 only when that API fails for the whole "
    "Layer 1 timeout, which is rare. Sports is the recommended category for a future Layer 2 validation: a final score is the same fact on "
    "every source, so evidence from a free historical API (ESPN's scoreboard, MLB's stats API) does not contradict rules that name the league.",
    "",
]


RUN_TEXT = {"crypto-price": ("Run 2: crypto-price (ADJ-47)", CRYPTO_ABOUT), "pilot": ("Run 1: seven-category pilot (ADJ-46)", PILOT_ABOUT)}


def main() -> None:
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    reports = []
    for run in (CRYPTO, PILOT):
        if not run.gate_file.exists():
            continue
        gate = json.loads(run.gate_file.read_text())
        rep = build(gate, json.loads(out_file(run).read_text()), commit, run)
        report_file(run).write_text(json.dumps(rep, indent=2) + "\n")
        reports.append((rep, gate, load_runs(run.runs_file), *RUN_TEXT[run.name]))
    DOC.write_text(markdown(reports))
    print(f"wrote {', '.join(str(report_file(r)) for r in (CRYPTO, PILOT) if r.gate_file.exists())} and {DOC}")


if __name__ == "__main__":
    main()
