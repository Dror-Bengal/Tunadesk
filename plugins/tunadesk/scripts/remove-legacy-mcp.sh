#!/bin/bash
# One-time cleanup after installing the Tunadesk plugin: remove the "tunadesk" MCP server that the older
# setup scripts registered directly in ~/.claude.json (the plugin now provides it). Keeps a backup.
CFG="$HOME/.claude.json"
[ -f "$CFG" ] || { echo "No $CFG — nothing to clean."; exit 0; }
grep -q '"tunadesk"' "$CFG" || { echo "No legacy tunadesk server found — nothing to clean."; exit 0; }
cp "$CFG" "$CFG.backup-$(date +%Y%m%d%H%M%S)"
CFG="$CFG" osascript -l JavaScript >/dev/null <<'JS'
ObjC.import("Foundation");
const path = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("CFG"));
const cfg = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)));
if (cfg.mcpServers) delete cfg.mcpServers.tunadesk;
for (const p of Object.values(cfg.projects || {})) if (p && p.mcpServers) delete p.mcpServers.tunadesk;
$(JSON.stringify(cfg, null, 2)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
JS
echo "✓ Removed the legacy tunadesk MCP entry (backup saved next to $CFG). Quit and reopen Claude."
