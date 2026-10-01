#!/usr/bin/env bash
# B-lane task closer (provisional). Commits the staged task files, reruns the task's exact
# acceptance command on the committed tree via b-evidence.sh, appends a row to
# docs/merge/B-progress.md and commits the evidence. Usage:
#   provisional/scripts/b-task.sh <TASK> "<commit subject>" "<status>" "<notes>" -- <command...>
# <status> is written as given only when the command exits 0; otherwise the row says FAILED.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK="$1"; SUBJECT="$2"; STATUS="$3"; NOTES="$4"; shift 4
[ "$1" = "--" ] && shift
CMD="$*"
cd "$ROOT"
git commit -q -m "$TASK: $SUBJECT

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || { echo "nothing staged for $TASK"; exit 2; }
SHA="$(git rev-parse --short HEAD)"
"$ROOT/provisional/scripts/b-evidence.sh" "$TASK" "$STATUS" -- "$CMD"
CODE=$?
ROW_STATUS="$STATUS"
[ $CODE -ne 0 ] && ROW_STATUS="FAILED (exit $CODE)"
echo "| $TASK | $ROW_STATUS | $SHA | $CODE | $NOTES |" >> docs/merge/B-progress.md
git add docs/merge/B-progress.md docs/merge/B-evidence/"$TASK".json docs/merge/B-evidence/"$TASK".log
git commit -q -m "$TASK: record acceptance evidence (exit $CODE)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
exit $CODE
