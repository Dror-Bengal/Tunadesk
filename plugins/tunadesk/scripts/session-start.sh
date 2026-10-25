#!/bin/bash
# SessionStart: put the desk briefing (inbox, ranked next tasks, portfolio) into Claude's context.
# Never blocks a session: if the desk is unreachable, say so in one line and move on.
cat >/dev/null  # hook input is not needed
. "$(dirname "$0")/common.sh"
tunadesk_load_config || exit 0
if BRIEF=$(curl -fsS -m 5 -H "Authorization: Bearer $TD_TOKEN" "$TD_URL/api/briefing.md" 2>/dev/null); then
  printf '%s\n\n%s\n' "$BRIEF" "(Tunadesk briefing loaded automatically at session start. Follow the Tunadesk protocol: claim before working, post updates, log decisions, complete or hand off.)"
else
  echo "Tunadesk desk at $TD_URL is not reachable right now; continue working and update it later."
fi
exit 0
