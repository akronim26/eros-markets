# Oracle progress

Append one row when a task in `tasks/*.md` is set to `done`. Never edit or delete a row; a fix is a
new row. `check_tasks.py` fails when a `done` task has no row here.

| Date (UTC) | Task | Commit | Check exit | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-02 | O00.1 | (this commit) | 0 | Foundry 1.8.3 (cae51ad); four submodules at the §12.2a commits; `forge config` clean for default and ci |
| 2026-10-02 | O00.2 | (this commit) | 0 | solc 0.8.16 + 0.8.30 via auto-detect; UMA OOv3 13,579 B runtime; 2/2 smoke tests pass; `./out` read permission added (ADJ-28) |
