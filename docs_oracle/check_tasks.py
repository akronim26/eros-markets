#!/usr/bin/env python3
"""Validator for the oracle task breakdown in docs_oracle/.

The plan (docs_oracle/eros-oracle-implementation-plan.md) is the source of truth. The breakdown
splits every plan section 13 task Onn into small tasks Onn.k, each ending with something that runs,
passes or exists. Files:

  tasks/*.md        the tasks, grouped by block (00 foundation ... 05 e2e/launch, external)
  gates.json        gates OG0-OG4: entry plan tasks, exit criteria, status, merge SHA, evidence
  adjustments.md    plan inconsistencies and the resolution used (ADJ-nn)
  traceability.md   generated: plan reference -> tasks (this script, --write-trace)
  progress.md       append-only log, one row per finished task
  evidence/         gate and task evidence

Task block format (parsed strictly):

  ### O14.2 · Halt, request, escalate and open
  - Owner: OA | OB | both | lead
  - PD: 0.75            (multiple of 0.25, or - when the plan gives no estimate)
  - Depends: O14.1, OG0 (tasks, X items, gates, DEP-n; - for none)
  - Plan: §5.4, D3, ORC-11, E1, B.1, C.2, V-C12, R-2, DEP-1, ADJ-07
  - Cut: yes | no | partial (optional note)    (plan section 13.1 hackathon cut)
  - Status: todo | doing | done | blocked
  - Files: optional, the paths the task writes
  - Build: what to write
  - Done when: the observable result
  - Check: a command that must exit 0, or "manual: ..."
  - Notes: optional (required reason when Status is blocked)

Workflow for one task: take a ready task (--next), read its plan references, set Status: doing,
tests first, run its Check, set Status: done, append a row to progress.md, run this script, commit.
A gate passes only when all tasks of its entry plan tasks are done, its exit criteria hold and its
evidence is recorded in gates.json.

Checks: field presence and values; unique IDs; per plan task, step PD adds up to the plan estimate
(per owner for shared tasks) and owners match; dependencies exist and are acyclic; every step
inherits its plan task's dependencies (exceptions must cite their ADJ entry); gates match the plan;
every leaf plan section, decision D1-D20, invariant ORC-1..15, scenario E1-E11, appendix part
B.n/C.n, open check of section 16.2 and DEP-n is covered by a task; every reference exists in the
plan or adjustments.md; status consistency; traceability.md is up to date.

Usage: python3 docs_oracle/check_tasks.py [--board | --next | --cut | --write-trace]
"""

from __future__ import annotations

import json
import re
import sys
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLAN_FILE = HERE / "eros-oracle-implementation-plan.md"
TASK_DIR = HERE / "tasks"
GATES_FILE = HERE / "gates.json"
ADJ_FILE = HERE / "adjustments.md"
TRACE_FILE = HERE / "traceability.md"
PROGRESS_FILE = HERE / "progress.md"

F = Fraction

# Plan section 13 table: owner, estimate (None = no estimate), per-owner split for shared tasks,
# dependencies (plan task IDs, gates or DEP-n).
PLAN = {
    "O00": ("both", F(1), {"OA": F(1, 2), "OB": F(1, 2)}, []),
    "O01": ("OA", F(1), None, []),
    "O02": ("OA", F(1), None, ["O00"]),
    "O10": ("OA", F(3), None, ["OG0"]),
    "O11": ("OA", F(3), None, ["O10"]),
    "O12": ("OA", F(2), None, ["O02"]),
    "O13": ("OA", F(3, 2), None, ["O02"]),
    "O14": ("OA", F(5), None, ["O10", "O11", "O12", "O13"]),
    "O15": ("OA", F(3, 2), None, ["O14"]),
    "O16": ("OA", F(3, 2), None, ["O14"]),
    "O17": ("OA", F(3), None, ["O14", "O15", "O16"]),
    "O18": ("OA", F(1, 2), None, ["O17"]),
    "O19": ("OA", F(2), None, ["O17"]),
    "O20": ("OB", F(1), None, ["OG0"]),
    "O21": ("OB", F(2), None, ["O20", "O02"]),
    "O22": ("OB", F(5, 2), None, ["O21"]),
    "O23": ("OB", F(1), None, ["O21", "OG1"]),
    "O30": ("OB", F(3, 2), None, ["OG1"]),
    "O31": ("OB", F(5, 2), None, ["O30"]),
    "O32": ("OB", F(2), None, ["O30"]),
    "O33": ("OB", F(4), None, ["O32"]),
    "O34": ("OB", F(5, 2), None, ["O30"]),
    "O35": ("OA", F(3), None, ["O30", "O20"]),
    "O36": ("OB", F(1), None, ["O31"]),
    "O37": ("OB", F(2), None, ["OG1"]),
    "O38": ("OB", F(3), None, ["O37"]),
    "O39": ("OA", F(6), None, []),
    "O40": ("both", F(3), {"OA": F(3, 2), "OB": F(3, 2)}, ["OG2", "O31", "O32", "O33", "O34", "O35", "O36", "O37", "O38"]),
    "O41": ("both", F(3, 2), {"OA": F(3, 4), "OB": F(3, 4)}, ["OG3"]),
    "O42": ("both", F(2), {"OA": F(1), "OB": F(1)}, ["DEP-1", "DEP-2"]),
    "O43": ("both", None, None, ["OG3b"]),
}

GATES = {
    "OG0": ["O01", "O02"],
    "OG1": ["O10", "O11", "O12", "O13", "O14", "O15", "O16", "O17", "O18", "O19"],
    "OG2": ["O23"],
    "OG3": ["O40"],
    "OG3b": ["O42"],
    "OG4": ["O43"],
}

# Plan section 13 effort table.
TOTALS = {"all": {"OA": F(151, 4), "OB": F(115, 4)}, "to_og3": {"OA": F(30), "OB": F(27)}}
TO_OG3_EXCLUDES = {"O39", "O41", "O42", "O43"}

# Tasks allowed to start before their plan task's dependencies, with the ADJ entry that says why.
EARLY_START = {"O19.1": "ADJ-07"}

DEPS_EXTERNAL = {f"DEP-{i}" for i in range(1, 6)}

# Leaf plan sections that are descriptive or are this breakdown itself, so no task implements them.
SECTION_EXCLUDES = {"0", "1", "2", "3.1", "13.1", "16.1"}

REQUIRED_FIELDS = ["Owner", "PD", "Depends", "Plan", "Cut", "Status", "Build", "Done when", "Check"]
OPTIONAL_FIELDS = ["Files", "Notes"]
OWNERS = {"OA", "OB", "both", "lead"}
STATUSES = {"todo", "doing", "done", "blocked"}
GATE_STATUSES = {"not_started", "in_progress", "passed"}

TASK_ID = re.compile(r"^(O\d\d\.\d+|X\d\d)$")
TASK_HEAD = re.compile(r"^### (\S+) · (.+)$")
PARENT_HEAD = re.compile(r"^## (O\d\d) · (.+)$")
PARENT_LINE = re.compile(r"^Plan §13: owner (\S+) · (.+?) · depends (.+?) · acceptance: (.+)$")
FIELD = re.compile(r"^- ([A-Za-z ]+): (.*)$")
CUT = re.compile(r"^(yes|no|partial)( \(.+\))?$")


class Problems(list):
    def add(self, msg: str) -> None:
        self.append(msg)


# ---------------------------------------------------------------------------- plan parsing


def plan_refs() -> dict:
    """Collect every reference the plan defines, from its headings and tables."""
    text = PLAN_FILE.read_text(encoding="utf-8").splitlines()
    sections, appendix = [], []
    in_code = False
    for line in text:
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = re.match(r"^#{2,3} (\d+(?:\.\d+)?[a-z]?)[. ]", line)
        if m:
            sections.append(m.group(1))
        m = re.match(r"^#{2,3} ([BC]\.\d+) ", line)
        if m:
            appendix.append(m.group(1))

    def table_ids(start: str, pattern: str) -> list:
        out, on = [], False
        for line in text:
            if line.startswith(start):
                on = True
                continue
            if on and line.startswith("#"):
                break
            if on:
                m = re.match(pattern, line)
                if m:
                    out.append(m.group(1))
        return out

    decisions = table_ids("### 4.2 ", r"^\| (D\d+) \|")
    invariants = table_ids("### 5.5 ", r"^\| (ORC-\d+) \|")
    scenarios = table_ids("### 11.3 ", r"^\| (E\d+) \|")
    checked = table_ids("### 16.1 ", r"^\| (V-[A-Z]\d+) \|")
    open_checks = table_ids("### 16.2 ", r"^\| ((?:V-[A-Z]\d+)|R-2) \|")
    leaves = [s for s in sections if not any(o.startswith(s + ".") for o in sections)]
    return {
        "sections": set(sections),
        "required_sections": [s for s in leaves if s not in SECTION_EXCLUDES],
        "appendix": appendix,
        "decisions": decisions,
        "invariants": invariants,
        "scenarios": scenarios,
        "checks_known": set(checked) | set(open_checks),
        "open_checks": open_checks,
    }


def adj_ids() -> set:
    return set(re.findall(r"^\| (ADJ-\d\d) \|", ADJ_FILE.read_text(encoding="utf-8"), re.M))


# ---------------------------------------------------------------------------- task parsing


def parse_tasks(p: Problems) -> tuple[dict, dict]:
    tasks, parents = {}, {}
    for path in sorted(TASK_DIR.glob("*.md")):
        current_parent, current = None, None
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            where = f"{path.name}:{n}"
            m = PARENT_HEAD.match(line)
            if m:
                current_parent, current = m.group(1), None
                if current_parent in parents:
                    p.add(f"{where}: plan task {current_parent} appears twice")
                parents[current_parent] = {"title": m.group(2), "file": path.name, "line": None}
                continue
            m = PARENT_LINE.match(line)
            if m and current_parent:
                parents[current_parent]["line"] = m.groups()
                continue
            if line.startswith("## "):
                current_parent, current = None, None
                continue
            m = TASK_HEAD.match(line)
            if m:
                tid = m.group(1)
                if not TASK_ID.match(tid):
                    p.add(f"{where}: bad task id {tid}")
                if tid in tasks:
                    p.add(f"{where}: duplicate task id {tid}")
                current = {"id": tid, "title": m.group(2), "file": path.name, "line": n, "parent": current_parent}
                tasks[tid] = current
                continue
            if line.startswith("### "):
                p.add(f"{where}: heading is not a task heading: {line}")
                current = None
                continue
            m = FIELD.match(line)
            if m and current is not None:
                key, val = m.group(1), m.group(2).strip()
                if key not in REQUIRED_FIELDS + OPTIONAL_FIELDS:
                    p.add(f"{where}: unknown field '{key}' in {current['id']}")
                elif key in current:
                    p.add(f"{where}: field '{key}' repeated in {current['id']}")
                else:
                    current[key] = val
    return tasks, parents


def split_list(val: str) -> list:
    return [] if val.strip() == "-" else [x.strip() for x in val.split(",") if x.strip()]


def pd_of(t: dict):
    return None if t.get("PD") == "-" else F(t["PD"])


# ---------------------------------------------------------------------------- checks


def check(tasks: dict, parents: dict, gates: dict, refs: dict, adjs: set, p: Problems) -> None:
    by_parent: dict = {}
    for tid, t in tasks.items():
        for f in REQUIRED_FIELDS:
            if not t.get(f):
                p.add(f"{tid}: missing field '{f}'")
        if t.get("Owner") and t["Owner"] not in OWNERS:
            p.add(f"{tid}: bad owner {t['Owner']}")
        if t.get("Status") and t["Status"] not in STATUSES:
            p.add(f"{tid}: bad status {t['Status']}")
        if t.get("Status") == "blocked" and not t.get("Notes"):
            p.add(f"{tid}: blocked without a Notes reason")
        if t.get("Cut") and not CUT.match(t["Cut"]):
            p.add(f"{tid}: bad Cut value {t['Cut']}")
        if t.get("PD") and t["PD"] != "-":
            try:
                v = F(t["PD"])
                if v <= 0 or (v * 4).denominator != 1:
                    p.add(f"{tid}: PD must be a positive multiple of 0.25")
            except ValueError:
                p.add(f"{tid}: bad PD {t['PD']}")
        if tid.startswith("O"):
            parent = tid.split(".")[0]
            if t["parent"] != parent:
                p.add(f"{tid}: listed under {t['parent']}, expected under {parent}")
            if parent not in PLAN:
                p.add(f"{tid}: {parent} is not a plan section 13 task")
            by_parent.setdefault(parent, []).append(t)
        elif t["parent"] is not None:
            p.add(f"{tid}: X items must not sit under a plan task heading")

    # Plan tasks: presence, header line, owners and estimates.
    for pid, (owner, pd, split, _deps) in PLAN.items():
        steps = by_parent.get(pid, [])
        if not steps:
            p.add(f"{pid}: plan task has no steps")
            continue
        head = parents.get(pid, {}).get("line")
        if not head:
            p.add(f"{pid}: missing 'Plan §13: owner … · … · depends … · acceptance: …' line")
        else:
            h_owner = {"OA+OB": "both"}.get(head[0], head[0])
            if h_owner != owner:
                p.add(f"{pid}: header owner {head[0]} != plan {owner}")
            m = re.match(r"([\d.]+)\+? PD", head[1])
            if pd is None and m:
                p.add(f"{pid}: header gives an estimate, plan gives none")
            if pd is not None and (not m or F(m.group(1)) != pd):
                p.add(f"{pid}: header estimate '{head[1]}' != plan {pd} PD")
        if pd is None:
            for s in steps:
                if s.get("PD") != "-":
                    p.add(f"{s['id']}: plan gives {pid} no estimate, so PD must be -")
            continue
        try:
            total = sum((pd_of(s) or F(0)) for s in steps)
        except (ValueError, KeyError):
            continue
        if total != pd:
            p.add(f"{pid}: steps add up to {float(total)} PD, plan says {float(pd)}")
        if split is None:
            for s in steps:
                if s.get("Owner") != owner:
                    p.add(f"{s['id']}: owner {s.get('Owner')} != plan owner {owner} of {pid}")
        else:
            for o, want in split.items():
                got = sum((pd_of(s) or F(0)) for s in steps if s.get("Owner") == o)
                if got != want:
                    p.add(f"{pid}: {o} steps add up to {float(got)} PD, plan split is {float(want)}")
            for s in steps:
                if s.get("Owner") not in split:
                    p.add(f"{s['id']}: shared task steps must be owned by OA or OB")
    for pid in parents:
        if pid not in PLAN:
            p.add(f"{pid}: heading for a task that is not in plan section 13")

    # Totals.
    for scope, want in TOTALS.items():
        for o, w in want.items():
            got = sum(
                (pd_of(t) or F(0))
                for t in tasks.values()
                if t.get("Owner") == o
                and t["id"].startswith("O")
                and (scope == "all" or t["id"].split(".")[0] not in TO_OG3_EXCLUDES)
            )
            if got != w:
                p.add(f"total {scope} {o}: {float(got)} PD, plan says {float(w)}")

    # Gates.
    if set(gates) != set(GATES):
        p.add(f"gates.json ids {sorted(gates)} != plan gates {sorted(GATES)}")
    for gid, g in gates.items():
        if g.get("entry") != GATES.get(gid):
            p.add(f"{gid}: entry {g.get('entry')} != plan {GATES.get(gid)}")
        if g.get("status") not in GATE_STATUSES:
            p.add(f"{gid}: bad status {g.get('status')}")
        if g.get("status") == "passed":
            if not g.get("merge_sha") or not g.get("evidence"):
                p.add(f"{gid}: passed without merge_sha and evidence")
            for pid in g.get("entry", []):
                for s in by_parent.get(pid, []):
                    if s.get("Status") != "done":
                        p.add(f"{gid}: passed but {s['id']} is {s.get('Status')}")

    # Dependencies.
    nodes = set(tasks) | set(gates) | DEPS_EXTERNAL
    graph = {}
    for tid, t in tasks.items():
        deps = split_list(t.get("Depends", "-"))
        for d in deps:
            if d not in nodes:
                p.add(f"{tid}: unknown dependency {d}")
        graph[tid] = [d for d in deps if d in nodes]
    for gid in gates:
        graph[gid] = [s["id"] for pid in GATES.get(gid, []) for s in by_parent.get(pid, [])]
    for d in DEPS_EXTERNAL:
        graph[d] = []

    state, order = {}, []

    def visit(n, stack):
        if state.get(n) == 2:
            return
        if state.get(n) == 1:
            p.add(f"dependency cycle: {' -> '.join(stack + [n])}")
            return
        state[n] = 1
        for d in graph.get(n, []):
            visit(d, stack + [n])
        state[n] = 2
        order.append(n)

    for n in graph:
        visit(n, [])

    closure: dict = {}
    for n in order:
        c = set()
        for d in graph.get(n, []):
            c.add(d)
            c |= closure.get(d, set())
        closure[n] = c

    for tid, t in tasks.items():
        if not tid.startswith("O"):
            continue
        parent = tid.split(".")[0]
        if tid in EARLY_START:
            if EARLY_START[tid] not in split_list(t.get("Plan", "")):
                p.add(f"{tid}: early start must cite {EARLY_START[tid]} in its Plan line")
            continue
        for q in PLAN.get(parent, (None, None, None, []))[3]:
            need = {s["id"] for s in by_parent.get(q, [])} if q in PLAN else {q}
            missing = need - closure.get(tid, set())
            if missing:
                p.add(f"{tid}: plan task {parent} depends on {q}, but {tid} does not wait for {sorted(missing)}")

    # Plan references.
    sec = refs["sections"]
    for tid, t in tasks.items():
        for r in split_list(t.get("Plan", "")):
            ok = (
                (r.startswith("§") and r[1:] in sec)
                or r in refs["decisions"]
                or r in refs["invariants"]
                or r in refs["scenarios"]
                or r in refs["appendix"]
                or r in refs["checks_known"]
                or r in DEPS_EXTERNAL
                or r in adjs
            )
            if not ok:
                p.add(f"{tid}: unknown plan reference {r}")
        for r in re.findall(r"ADJ-\d\d", " ".join(str(v) for v in t.values())):
            if r not in adjs:
                p.add(f"{tid}: {r} is not in adjustments.md")

    covered = {r for t in tasks.values() for r in split_list(t.get("Plan", ""))}
    for kind, items in required_refs(refs).items():
        for r in items:
            if r not in covered:
                p.add(f"not covered by any task: {kind} {r}")

    # Status consistency.
    progress = PROGRESS_FILE.read_text(encoding="utf-8") if PROGRESS_FILE.exists() else ""
    for tid, t in tasks.items():
        if t.get("Status") != "done":
            continue
        if not re.search(rf"^\| [^|]* \| {re.escape(tid)} \|", progress, re.M):
            p.add(f"{tid}: done but has no row in progress.md")
        for d in graph.get(tid, []):
            if d in tasks and tasks[d].get("Status") != "done":
                p.add(f"{tid}: done but dependency {d} is {tasks[d].get('Status')}")
            if d in gates and gates[d].get("status") != "passed":
                p.add(f"{tid}: done but gate {d} has not passed")


def required_refs(refs: dict) -> dict:
    return {
        "section": ["§" + s for s in refs["required_sections"]],
        "decision": refs["decisions"],
        "invariant": refs["invariants"],
        "scenario": refs["scenarios"],
        "appendix": refs["appendix"],
        "open check": refs["open_checks"],
        "dependency": sorted(DEPS_EXTERNAL),
    }


# ---------------------------------------------------------------------------- outputs


def sort_key(tid: str):
    m = re.match(r"([A-Z]+)(\d+)(?:\.(\d+))?", tid)
    return (m.group(1) != "O", int(m.group(2)), int(m.group(3) or 0))


def trace_text(tasks: dict, refs: dict) -> str:
    index: dict = {}
    for tid, t in tasks.items():
        for r in split_list(t.get("Plan", "")):
            index.setdefault(r, []).append(tid)
    titles = {
        "section": "Plan sections",
        "decision": "Decisions (plan §4.2)",
        "invariant": "Invariants (plan §5.5)",
        "scenario": "Testnet scenarios (plan §11.3)",
        "appendix": "Appendix B and C",
        "open check": "Open checks (plan §16.2)",
        "dependency": "External dependencies (plan §3.3)",
    }
    out = [
        "# Traceability",
        "",
        "Generated by `python3 docs_oracle/check_tasks.py --write-trace` from the `Plan:` lines of",
        "`tasks/*.md`. Do not edit by hand; the validator fails when this file is out of date.",
        "",
    ]
    for kind, items in required_refs(refs).items():
        out += [f"## {titles[kind]}", "", "| Reference | Tasks |", "| --- | --- |"]
        for r in items:
            out.append(f"| {r} | {', '.join(sorted(index.get(r, []), key=sort_key)) or '**none**'} |")
        out.append("")
    adj = sorted(r for r in index if r.startswith("ADJ-"))
    out += ["## Adjustments (adjustments.md)", "", "| Reference | Tasks |", "| --- | --- |"]
    for r in adj:
        out.append(f"| {r} | {', '.join(sorted(index[r], key=sort_key))} |")
    out.append("")
    return "\n".join(out)


def deps_met(t: dict, tasks: dict, gates: dict) -> bool:
    for d in split_list(t.get("Depends", "-")):
        if d in tasks and tasks[d].get("Status") != "done":
            return False
        if d in gates and gates[d].get("status") != "passed":
            return False
        if d in DEPS_EXTERNAL:
            return False
    return True


def board(tasks: dict, gates: dict) -> None:
    rows = {}
    for t in tasks.values():
        key = t["id"].split(".")[0] if t["id"].startswith("O") else "X"
        rows.setdefault(key, []).append(t)
    print(f"{'task':6} {'done':>7} {'PD done':>9}  status")
    for key in sorted(rows, key=lambda k: (k == "X", k)):
        ts = rows[key]
        done = sum(1 for t in ts if t.get("Status") == "done")
        pd_done = sum((pd_of(t) or F(0)) for t in ts if t.get("Status") == "done")
        pd_all = sum((pd_of(t) or F(0)) for t in ts)
        marks = " ".join(f"{t['id']}:{t.get('Status')}" for t in sorted(ts, key=lambda t: sort_key(t["id"])))
        print(f"{key:6} {done:>3}/{len(ts):<3} {float(pd_done):>4}/{float(pd_all):<4}  {marks}")
    print()
    for gid, g in gates.items():
        print(f"{gid:5} {g.get('status')} {g.get('merge_sha') or ''}")


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    p = Problems()
    refs = plan_refs()
    adjs = adj_ids()
    tasks, parents = parse_tasks(p)
    gates = {g["id"]: g for g in json.loads(GATES_FILE.read_text(encoding="utf-8"))["gates"]}
    check(tasks, parents, gates, refs, adjs, p)
    trace = trace_text(tasks, refs)

    if arg == "--write-trace":
        TRACE_FILE.write_text(trace, encoding="utf-8")
        print(f"wrote {TRACE_FILE.relative_to(HERE.parent)}")
    elif not TRACE_FILE.exists() or TRACE_FILE.read_text(encoding="utf-8") != trace:
        p.add("traceability.md is out of date: run with --write-trace")

    if arg == "--board":
        board(tasks, gates)
    elif arg == "--next":
        for t in sorted(tasks.values(), key=lambda t: sort_key(t["id"])):
            if t.get("Status") == "todo" and deps_met(t, tasks, gates):
                print(f"{t['id']:7} {t.get('Owner'):5} {t.get('PD'):>5}  {t['title']}")
    elif arg == "--cut":
        for t in sorted(tasks.values(), key=lambda t: sort_key(t["id"])):
            if not t.get("Cut", "no").startswith("no"):
                print(f"{t['id']:7} {t.get('Owner'):5} {t['Cut'].split()[0]:8} {t['title']}")
    elif arg not in ("", "--write-trace"):
        print(__doc__)
        return 2

    if p:
        print(f"\n{len(p)} problem(s):", file=sys.stderr)
        for m in p:
            print(f"  - {m}", file=sys.stderr)
        return 1
    n = len(tasks)
    total = sum((pd_of(t) or F(0)) for t in tasks.values())
    if arg == "":
        print(f"ok: {n} tasks, {float(total)} PD, {len(gates)} gates, every plan reference covered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
