---
name: capcut
description: >-
  Use when the user wants to build or inspect a CapCut desktop project from an
  agent: make a vertical short (1080x1920) from a clip with title, SRT subtitles
  and background music; list or read local CapCut drafts; place clips, audio,
  text; change canvas/fps/duration. Not for rendering the MP4 (the user exports
  in CapCut) or for CapCut cloud/web.
---
# CapCut drafts (capcut-mcp)

Tools work on draft folders inside `CAPCUT_DRAFTS_ROOT` (normally CapCut's own
drafts folder). Times are seconds. Paths are absolute.

1. Read first: `capcut_list_drafts`. It shows each project, its CapCut version, and
   whether it is empty.
2. Every write tool is a dry run unless `dry_run: false`. Show the plan (or a
   one-line summary of it) before the real write. Check `warning` in the plan.
3. A short in one call: `capcut_make_short` with `name` (new project),
   `clip_path`, `title`, `srt_path` or `srt_text`, `music_path`
   (volume 0.3 and 1 s fades by default), and `register_in_index: true` so CapCut
   lists it. `sub_style` and `title_style` take the same fields as `capcut_style_text`.
   Then repeat with `dry_run: false`.
4. CapCut 9.x needs version markers from a project CapCut made itself. The
   default `template_draft: "auto"` finds one. If the plan warns that none was
   found, ask the user to create one empty project in CapCut and quit CapCut.
5. CapCut must be closed for a real write (the tool refuses otherwise). After the
   write, the user opens CapCut and clicks the project.
6. Step by step tools: `capcut_create_draft`, `capcut_add_clip`,
   `capcut_add_audio`, `capcut_add_text`, `capcut_add_subtitles`,
   `capcut_set_timeline`, `capcut_read_draft`. Segments on one track must not
   overlap; use another `track` name to layer.
7. A cut list in one call: `capcut_add_cuts` with `keep` ranges (a range may
   include `x`, `y` and `scale`). Pass the source SRT to remap it. `srt_out` writes
   that SRT for YouTube CC (never overwrites; `place_subtitles: false` skips burned-in
   captions). `max_words`/`max_chars` make short caption cards on the draft, not in
   the file. Fix one piece with `capcut_remove_segment` (`ripple: true` closes the
   gap on that track).
8. `capcut_add_clip` takes `fade_in_s` / `fade_out_s` (same fades as `capcut_set_clip`).
   `capcut_add_subtitles` takes `x` (-1..1, default 0). `capcut_export_chapters`
   turns `capcut_add_markers` into a YouTube `HH:MM:SS Title` list.

Never invent media paths, durations, or SRT text. Ask the user. The tools do not
decrypt drafts and do not contact CapCut servers.
