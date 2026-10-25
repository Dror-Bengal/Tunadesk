#!/bin/bash
# Shared by the Tunadesk hooks: find the desk URL and this agent's token.
# Order: the plugin's settings (exported by Claude Code), plain env vars, then ~/.tunadesk/agent.env.
tunadesk_load_config() {
  TD_URL="${CLAUDE_PLUGIN_OPTION_DESK_URL:-${TUNADESK_URL:-}}"
  TD_TOKEN="${CLAUDE_PLUGIN_OPTION_AGENT_TOKEN:-${TUNADESK_TOKEN:-}}"
  if { [ -z "$TD_URL" ] || [ -z "$TD_TOKEN" ]; } && [ -f "$HOME/.tunadesk/agent.env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.tunadesk/agent.env"
    TD_URL="${TD_URL:-${TUNADESK_URL:-}}"
    TD_TOKEN="${TD_TOKEN:-${TUNADESK_TOKEN:-}}"
  fi
  TD_URL="${TD_URL%/}"
  [ -n "$TD_URL" ] && [ -n "$TD_TOKEN" ]
}
