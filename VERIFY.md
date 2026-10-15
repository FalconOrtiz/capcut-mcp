# VERIFY — capcut-mcp v0.2.0

Date: 2026-10-03.

## A. Real Mac, end to end — PASS

Machine: Apple Silicon Mac, macOS 26.6.2, arm64. CapCut 9.5.0 (`com.lemon.lvoverseas`, direct download).
Node v22.22.1 (Homebrew). Work folder `~/capcut-mcp-work`. CapCut was closed for every write.

| # | Step | Evidence | Result |
|---|---|---|---|
| A1 | Read-only inspector before the write | `zsh scripts/inspect-capcut.sh` → CapCut 9.5.0 found, drafts root found, `root_meta_info.json` 1 entry (`<scratch-project>`, an empty project CapCut made) | PASS |
| A2 | Backup of `root_meta_info.json` | manual copy in `~/capcut-mcp-work/backups/` + tool backup `root_meta_info.json.capcut-mcp-1791039305239.bak` next to it | PASS |
| A3 | `capcut_make_short` dry run | plan: new draft "MCP Demo Short", template `<scratch-project>` (9.5.0), layout `draft_info.json` + `template-2.tmp`, 1080x1920, 10 s; clip 10 s 1080x1920 (read from MP4), title 3 s, 4 subtitle cues, music 10 of 20 s, volume 0.3, fades 1 s; nothing written | PASS |
| A4 | Same call, `dry_run:false`, `register_in_index:true` (16:55) | `"written": true`, index `appended`; folder + `assets/video/clip.mp4` + `assets/audio/music.m4a` | PASS |
| A5 | CapCut lists the project | screenshot `evidence-01-project-listed.png`: "MCP Demo Short 3.7M \| 00:10" | PASS |
| A6 | Project opens, timeline complete | `evidence-02-timeline-opened.png`: no error dialog; 9:16 player shows title; tracks: subtitles (4 cues), title, clip.mp4 00:00:10:00, music.m4a with fade shape; Details: aspect 9:16 | PASS |
| A7 | Playback | `evidence-03-playing.png` (≈3 s: caption 2 "The agent wrote a CapCut draft through MCP", pause icon, audio meter green), `evidence-04-playing-later.png` (≈6 s: caption 3) | PASS |
| A8 | Round trip: quit CapCut, inspect | CapCut saved the draft: added `Timelines/<id>/`, kept 7 segments, volume 0.3, both fades, 9:16; rewrote media paths to `##_draftpath_placeholder_…##/assets/...` | PASS |
| A9 | MCP reads the CapCut-saved draft | `capcut_read_draft` → `timeline_file: Timelines/<id>/draft_info.json`, `writable: true`, placeholder paths resolved | PASS |
| A10 | Test suite on the Mac | `node --test test/server.test.ts` → 14/14 pass (final code, server.ts sha256 `74d87022…be5ff`, same file as pushed) | PASS |

Screenshots (2940x1912) are on the verification machine: `<internal>/capcut-mcp-shots/evidence-0{1,2,3,4}-*.png`,
and on the Mac in `~/capcut-mcp-work/`.

Note on A4–A9: the draft was written by the build before three small follow-up changes (placeholder-path
resolution, hiding `device_id`/`hard_disk_id`/`mac_address` in read output, three more donor files on the skip list).
Those changes are covered by tests 13 and 12 and by A9/A10, not by a second CapCut open.

## B. Box (Linux) checks — PASS

| # | Check | Command | Result |
|---|---|---|---|
| B1 | Syntax | `node --check server.ts` | PASS |
| B2 | `plugin.json`, `mcp.json` vs agent-plugins 1.0.0 schemas | jsonschema (Draft 2020-12) | PASS |
| B3 | Tests | `npm test` (Node 22.18.0) | PASS 14/14 |
| B4 | Inspector in zsh and bash | `zsh`/`bash scripts/inspect-capcut.sh` on a fake root (encrypted file, Timelines/, odd names) → same output, exit 0, no files changed | PASS |
| B5 | Probe vs ffprobe | `clip.mp4` 10 s 1080x1920, `music.m4a` 20 s, rotated phone MP4 640x360+90° → 360x640 | PASS |
| B6 | Secret scan | `gitleaks dir .` | PASS, no leaks |
| B7 | Privacy | no device ids / home user names in the repo; fixture ids are zeros | PASS |
| B8 | Local plugin copy | `~/.cursor/plugins/local/capcut-mcp` → initialize + tools/list = 10 tools | PASS |

`npm test` covers: SRT parser; create (dry run, write, no overwrite); validation (traversal, unknown args, ranges,
missing files); clip/text/subtitles; set_timeline; export; encrypted and broken `Timelines/` drafts refused; template
copy (layout follows template, no `Timelines/`); media probe (MP4 rotation, WAV); `capcut_add_audio` (track, volume,
fades, length checks); `capcut_make_short` new draft in macOS layout (one call, cue past the end dropped, music
clipped to file length); fill-in-place of a 9.x project (nested + root + `template-2.tmp` written, each keeps its id,
index entry updated with backup, other entries kept, auto template seeds 9.5.0 markers); the real CapCut 9.5.0 saved
draft (sanitized fixture); live stdio session (10 tools, parse error −32700).

## C. Mac checklist (repeat after a CapCut update or on a new Mac)

- [ ] `node --version` ≥ 22.18
- [ ] `node --test test/server.test.ts` → pass 14
- [ ] `zsh scripts/inspect-capcut.sh` → note CapCut version; at least one project with `platform.app_version`
- [ ] CapCut closed (`pgrep -x CapCut` prints nothing)
- [ ] `capcut_make_short` dry run: no `warning`, `template_app_version` = installed CapCut version
- [ ] Real write with `register_in_index:true` → `written: true`, index `appended`, backup file exists
- [ ] Open CapCut → project listed with the right duration → opens without an error dialog
- [ ] Timeline shows video, title, subtitles, music; Play shows captions changing and audio meter moving
- [ ] Quit CapCut → `capcut_read_draft` still shows all segments

## D. Not verified

- Windows CapCut. Layout logic is unit-tested only.
- Other CapCut builds (8.x, 9.x other than 9.5.0, 10.x). 10.x is reported to reject tool-written drafts.
- Fill-in-place (`capcut_make_short draft:<empty project>`) opened in real CapCut: unit-tested on the 9.5.0 layout,
  not opened in CapCut (the template project `<scratch-project>` was left untouched on purpose).
- Audio heard by a person (only the level meter was seen). Export to MP4 inside CapCut.
- Registration in Grok Bot / Cursor on the Mac (the demo calls used a JSON-RPC driver, `call.mjs`).
- Whether CapCut lists a draft without `register_in_index` (always used `true` here).
