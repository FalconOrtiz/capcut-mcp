#!/bin/zsh
# inspect-capcut.sh - READ-ONLY report of the CapCut desktop install and its draft folders.
# It writes nothing: no files, no settings. Safe to run while CapCut is open.
# Works in zsh (macOS default) and bash; uses no globs, so no "no matches found" errors.
# Usage:  zsh scripts/inspect-capcut.sh [drafts_root]  |  pbcopy      (then paste the report)
# JSON is read with node if installed, else macOS JavaScript for Automation (osascript -l JavaScript).

root="${1:-${CAPCUT_DRAFTS_ROOT:-$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft}}"

say() { printf '%s\n' "$*"; }
hr() { say "------------------------------------------------------------"; }

JS='
function readText(p) {
  if (typeof $ !== "undefined" && $.NSString) {
    var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
    return (!s || s.isNil()) ? null : ObjC.unwrap(s);
  }
  try { return require("fs").readFileSync(p, "utf8"); } catch (e) { return null; }
}
function main(argv) {
  var mode = argv[0], file = argv[1], raw = readText(file), j;
  if (raw === null) return "    (unreadable as UTF-8 text: encrypted or binary)";
  raw = raw.replace(/^\uFEFF/, "");
  try { j = JSON.parse(raw); } catch (e) { return "    (NOT plain JSON: encrypted or broken; first chars " + JSON.stringify(raw.slice(0, 12)) + ")"; }
  var out = [], put = function (k, v) { out.push("    " + k + ": " + (typeof v === "object" ? JSON.stringify(v) : String(v))); };
  var keys = Object.keys(j);
  if (mode === "index") {
    put("top-level keys", keys.join(", "));
    keys.forEach(function (k) {
      if (!Array.isArray(j[k])) return;
      put(k + " entries", j[k].length);
      j[k].forEach(function (e, i) {
        if (!e || typeof e !== "object") return;
        put("  [" + i + "]", { draft_name: e.draft_name, draft_fold_path: e.draft_fold_path, draft_json_file: e.draft_json_file,
          tm_duration: e.tm_duration, draft_new_version: e.draft_new_version, draft_is_invisible: e.draft_is_invisible });
      });
      if (j[k][0] && typeof j[k][0] === "object") put("entry field names", Object.keys(j[k][0]).join(", "));
    });
  } else if (mode === "meta") {
    ["draft_name", "draft_id", "draft_json_file", "draft_fold_path", "draft_root_path", "draft_new_version", "draft_cover", "tm_duration"].forEach(function (k) { if (k in j) put(k, j[k]); });
    if (Array.isArray(j.draft_materials)) put("draft_materials (type:count)", j.draft_materials.map(function (g) { return g.type + ":" + (g.value ? g.value.length : 0); }).join(" "));
    put("field count", keys.length);
  } else if (mode === "project") {
    put("main_timeline_id", j.main_timeline_id);
    put("timelines", (j.timelines || []).map(function (t) { return t.id + (t.is_marked_delete ? " (deleted)" : ""); }).join(", "));
    put("keys", keys.join(", "));
  } else {
    var p = j.platform || {}, lp = j.last_modified_platform || {};
    put("id", j.id); put("name", j.name);
    put("version", j.version); put("new_version", j.new_version);
    put("platform", { app_source: p.app_source, app_version: p.app_version, os: p.os, os_version: p.os_version });
    put("last_modified_platform.app_version", lp.app_version);
    put("canvas_config", j.canvas_config); put("fps", j.fps); put("duration_us", j.duration);
    put("tracks", (j.tracks || []).map(function (t) { return t.type + "(" + (t.segments || []).length + ")"; }).join(" ") || "none");
    var m = j.materials || {}, used = Object.keys(m).filter(function (k) { return Array.isArray(m[k]) && m[k].length; });
    put("materials keys", Object.keys(m).length + " (non-empty: " + (used.join(", ") || "none") + ")");
    put("top-level keys (" + keys.length + ")", keys.join(", "));
  }
  return out.join("\n");
}'

json() { # json <mode> <file>   (node first: the tested path; osascript JXA as fallback)
  if command -v node >/dev/null 2>&1; then
    node -e "$JS"' console.log(main(process.argv.slice(1)));' "$1" "$2" 2>&1
  elif command -v osascript >/dev/null 2>&1; then
    osascript -l JavaScript -e "$JS"' function run(argv) { return main(argv); }' "$1" "$2" 2>&1
  else
    say "    (no node or osascript to read JSON)"
  fi
}

firstbytes() { head -c 16 "$1" 2>/dev/null | od -An -tx1 | tr -s ' ' | sed 's/^ //'; }

listdir() { # one line per entry: type size name (hidden entries included)
  find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | sort | while IFS= read -r f; do
    if [ -d "$f" ]; then say "    [dir]  $(basename "$f")/"; else say "    [file] $(basename "$f")  ($(wc -c < "$f" | tr -d ' ') bytes)"; fi
  done
}

timeline_files() { # print each draft timeline document found in a folder, with versions
  for name in draft_info.json draft_content.json template-2.tmp; do
    if [ -f "$1/$name" ]; then
      say "  $2$name  first bytes: $(firstbytes "$1/$name")"
      json timeline "$1/$name"
    fi
  done
}

say "CapCut inspector (read only)   $(date '+%Y-%m-%d %H:%M %Z')"
hr
say "System"
if command -v sw_vers >/dev/null 2>&1; then say "  macOS $(sw_vers -productVersion) build $(sw_vers -buildVersion), arch $(uname -m)"; else say "  $(uname -sm) (not macOS)"; fi
if command -v node >/dev/null 2>&1; then say "  node $(node --version) at $(command -v node)"; else say "  node: not found"; fi

hr
say "CapCut app"
found_app=0
for app in "/Applications/CapCut.app" "$HOME/Applications/CapCut.app"; do
  if [ -d "$app" ]; then
    found_app=1
    plist="$app/Contents/Info.plist"
    say "  $app"
    if command -v plutil >/dev/null 2>&1; then
      for key in CFBundleShortVersionString CFBundleVersion CFBundleIdentifier LSMinimumSystemVersion; do
        say "    $key: $(plutil -extract "$key" raw -o - "$plist" 2>/dev/null || say '?')"
      done
    else
      say "    (plutil not available)"
    fi
    if [ -d "$app/Contents/_MASReceipt" ]; then say "    installed from: Mac App Store (sandboxed)"; else say "    installed from: direct download (no App Store receipt)"; fi
  fi
done
[ "$found_app" = 1 ] || say "  CapCut.app not found in /Applications or ~/Applications"
if command -v mdfind >/dev/null 2>&1; then
  other="$(mdfind 'kMDItemFSName == "CapCut*.app"c' 2>/dev/null | grep -v '^/Applications/CapCut.app$' | head -5)"
  [ -n "$other" ] && say "  other CapCut apps (Spotlight):" && say "$other" | sed 's/^/    /'
fi
if command -v pgrep >/dev/null 2>&1; then
  if pgrep -x CapCut >/dev/null 2>&1; then say "  CapCut is RUNNING (quit it before the MCP writes)"; else say "  CapCut is not running"; fi
fi

hr
say "Drafts root: $root"
if [ ! -d "$root" ]; then
  say "  DOES NOT EXIST."
  say "  Other com.lveditor.draft folders under ~/Movies:"
  find "$HOME/Movies" -maxdepth 6 -type d -name com.lveditor.draft 2>/dev/null | sed 's/^/    /'
  exit 0
fi
listdir "$root"

hr
say "root_meta_info.json (CapCut project list)"
if [ -f "$root/root_meta_info.json" ]; then
  say "  first bytes: $(firstbytes "$root/root_meta_info.json")"
  json index "$root/root_meta_info.json"
else
  say "  not present"
fi

find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | while IFS= read -r d; do
  n="$(basename "$d")"
  case "$n" in .*) continue ;; esac
  hr
  say "Draft folder: $n"
  listdir "$d"
  if [ -f "$d/draft_meta_info.json" ]; then say "  draft_meta_info.json"; json meta "$d/draft_meta_info.json"; fi
  timeline_files "$d" ""
  if [ -d "$d/Timelines" ]; then
    say "  Timelines/ tree:"
    find "$d/Timelines" -maxdepth 2 2>/dev/null | sort | sed "s|^$d/||; s/^/    /"
    if [ -f "$d/Timelines/project.json" ]; then
      say "  Timelines/project.json"
      json project "$d/Timelines/project.json"
      find "$d/Timelines" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | while IFS= read -r t; do
        timeline_files "$t" "Timelines/$(basename "$t")/"
      done
    fi
  fi
done
hr
say "End of report. Nothing was written."
