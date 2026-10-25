#!/bin/bash
# Stop: if this session edited files and has not updated the desk since, ask Claude to do it before ending the turn.
# Cheap and local: reads the session transcript, no model call. Never nags twice in a row (stop_hook_active),
# never nags when the desk is unreachable, and only after a few edits (TUNADESK_NUDGE_EDITS, default 3).
INPUT=$(cat)
case "$INPUT" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
. "$(dirname "$0")/common.sh"
tunadesk_load_config || exit 0
TRANSCRIPT=$(printf '%s' "$INPUT" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

EDIT_RE='"name"[[:space:]]*:[[:space:]]*"(Edit|Write|MultiEdit|NotebookEdit)"'
DESK_RE='"name"[[:space:]]*:[[:space:]]*"mcp__[A-Za-z0-9_]*tunadesk[A-Za-z0-9_]*__(comment|complete_task|handoff_task|create_task|update_task|claim_task|release_task|log_decision|update_project|add_brief_note|move_task|onboarding_report|report_usage)"'
LAST_DESK=$(grep -nE "$DESK_RE" "$TRANSCRIPT" | tail -1 | cut -d: -f1)
LAST_DESK=${LAST_DESK:-0}
EDITS=$(grep -nE "$EDIT_RE" "$TRANSCRIPT" | awk -F: -v d="$LAST_DESK" '$1 > d' | wc -l | tr -d ' ')
[ "$EDITS" -ge "${TUNADESK_NUDGE_EDITS:-3}" ] || exit 0
curl -fsS -m 2 -o /dev/null "$TD_URL/api/health" 2>/dev/null || exit 0

# Ask Claude to continue with a reason (documented Stop decision control); exit 0 so no hook error is shown.
REASON="Tunadesk: you changed files ($EDITS edits) since your last update on the desk. Before ending this turn, update it: comment on the task you worked on with what changed (or complete_task / handoff_task if it is finished or ready for someone else); if there is no task for this work yet, create_task (assign yourself) and comment; log_decision for any non-obvious choice. Keep it short. If this work truly does not belong on the desk, reply with one line saying why and end the turn."
printf '{"decision":"block","reason":"%s"}\n' "$REASON"
exit 0
