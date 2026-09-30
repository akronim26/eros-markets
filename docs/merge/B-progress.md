# Person B progress (resume point for a new session)

Branch `feat/risk`. Solo mode (see `B-assumptions.md` P-1). Status words:

- `lane-pass (stand-ins)`: the task's exact acceptance command ran on the committed tree and
  exited 0, using B stand-ins/mocks for A or counterparts. Not `accepted`: no gate is recorded.
- `lane-pass (pure)`: exit 0 with no stand-in involved.
- `needs-merge`: the command cannot run as written until A's files exist; a stand-in command ran.
- `blocked`: cannot be completed on this branch; reason given.

Evidence: `docs/merge/B-evidence/<TASK>.json` (command, exit code, commit, output tail).

| Task | Status | Task commit | Acceptance command exit | Notes |
|---|---|---|---|---|
