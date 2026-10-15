# Install capcut-mcp on macOS

Tested on: Apple Silicon Mac, macOS 26.6.2, arm64, CapCut 9.5.0 (International), Node 22.22.1.

## 1. CapCut

1. Install CapCut desktop from https://www.capcut.com (direct download).
2. Open CapCut once, sign in if you want, click **Create project**, then quit (Cmd+Q).
   This empty project gives the version markers that CapCut 9.x wants in new drafts.
3. Default drafts folder: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`.
   If you changed it in CapCut settings, use your folder below.

## 2. Node 22.18 or newer

Check first: `node --version`. If it prints v22.18 or newer, skip this step.

- Official installer: https://nodejs.org → "LTS" macOS installer (`.pkg`, universal: Apple Silicon and Intel).
  It installs `/usr/local/bin/node`.
- Or Homebrew: `brew install node@22` (keg-only: the binary is `/opt/homebrew/opt/node@22/bin/node`).

No `npm install` is needed. The server has zero dependencies and no build step.

## 3. Get the server

```sh
mkdir -p ~/capcut-mcp-work && cd ~/capcut-mcp-work
git clone https://github.com/FalconOrtiz/capcut-mcp.git
cd capcut-mcp && npm test
```

(Or download a ZIP from GitHub and unzip it to `~/capcut-mcp-work/capcut-mcp`.)

Keep the work folder outside `~/Desktop`, `~/Documents`, `~/Downloads`: those need macOS privacy permission.

## 4. Check the CapCut install (read only)

```sh
zsh ~/capcut-mcp-work/capcut-mcp/scripts/inspect-capcut.sh | pbcopy
```

Paste the report to your agent. It shows CapCut version, drafts folder, project list, and the version fields of
every draft. It writes nothing.

## 5. Register the MCP server

Use the absolute path of node (GUI apps often do not see Homebrew's PATH):

```sh
command -v node     # e.g. /usr/local/bin/node or /opt/homebrew/opt/node@22/bin/node
```

**Cursor**: add to `~/.cursor/mcp.json` (create it if missing):

```json
{
  "mcpServers": {
    "capcut": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/<you>/capcut-mcp-work/capcut-mcp/server.ts"],
      "env": {
        "CAPCUT_DRAFTS_ROOT": "/Users/<you>/Movies/CapCut/User Data/Projects/com.lveditor.draft"
      }
    }
  }
}
```

**Grok Bot** (or any MCP client): add a local **stdio** server with the same three values:
command = the node path, args = the `server.ts` path, env `CAPCUT_DRAFTS_ROOT` = the drafts folder.

**As an Agent Plugin**: the repo root is a plugin (`plugin.json`, `mcp.json`, `skills/capcut/SKILL.md`).
`mcp.json` runs `node server.ts` in the plugin folder; set `CAPCUT_DRAFTS_ROOT` in the client environment
(if unset, the macOS default folder above is used).

Optional variables:

| Variable | Use |
|---|---|
| `CAPCUT_EXPORT_ROOT` | Only for `capcut_export_draft` from a staging folder |
| `CAPCUT_TARGET_OS` | `mac` or `windows`: draft file layout (default: this computer) |
| `CAPCUT_ALLOW_RUNNING=1` | Allow writes while CapCut runs (not recommended: CapCut overwrites on save) |

## 6. Smoke test without an agent

```sh
cd ~/capcut-mcp-work/capcut-mcp
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capcut_list_drafts","arguments":{}}}' | node server.ts
```

You see your CapCut projects as JSON. Next: DEMO-SCRIPT.md.
