# Launch demo: an agent edits a vertical short in CapCut (about 90 s of video)

## Before you record (5 minutes)

1. Assets (all generated, no licence questions):
   ```sh
   cd ~/capcut-mcp-work/capcut-mcp
   sh scripts/make-demo-assets.sh demo     # needs ffmpeg (brew install ffmpeg); makes demo/clip.mp4 + demo/music.m4a
   ls demo                                 # clip.mp4  demo.srt  music.m4a
   ```
   - `clip.mp4`: 10 s, 1080x1920, colour test pattern (ffmpeg `testsrc2`). Use your own vertical clip if you want
     (MP4/MOV; keep it in `~/capcut-mcp-work`, not in Downloads/Desktop/Documents).
   - `demo.srt`: 4 English captions (in the repo).
   - `music.m4a`: 20 s chord pad synthesized by ffmpeg `aevalsrc`. Royalty-free because we made it.
2. CapCut has at least one project it made itself (INSTALL-macOS.md step 1). `MCP Demo Short` from the test run
   also counts.
3. **Quit CapCut** (Cmd+Q). The server refuses to write while CapCut runs.
4. MCP server registered in Grok Bot / Cursor (INSTALL-macOS.md step 5). Start a new chat.
5. Screen recording: Cmd+Shift+5 → record entire screen. Hide notifications (Focus mode on).

## Recording

**Scene 1: the ask (≈20 s).** Type this prompt exactly:

> Make a vertical short in CapCut called "Launch Short" from ~/capcut-mcp-work/capcut-mcp/demo/clip.mp4.
> Add the title "Made by an AI agent", the subtitles from ~/capcut-mcp-work/capcut-mcp/demo/demo.srt and
> background music from ~/capcut-mcp-work/capcut-mcp/demo/music.m4a at low volume with a fade.
> Add it to my CapCut project list. Show me the plan first, then write it.

(Agents need absolute paths: if yours does not expand `~`, write `/Users/<you>/...`.)

**Scene 2: the plan (≈15 s).** The agent calls `capcut_make_short` (dry run). Show the plan on screen:
1080x1920, 10 s, 4 tracks (video, title, subtitles, music 0.3 volume, 1 s fades), template "CapCut 9.5.0".
Say "write it". The agent calls it again with `dry_run: false` → `"written": true`, index `appended`.

**Scene 3: CapCut (≈40 s).**
1. Open CapCut. If a "Pro" pop-up shows, close it (top-left red dot of the pop-up).
2. Scroll to **Projects**: "Launch Short — 00:10" is there. Click it.
3. Show the timeline: 2 text tracks (title + 4 subtitle cues), the clip, the music track with the fade shape.
   The player shows the 9:16 canvas with "Made by an AI agent". Close CapCut's tip bubbles ("Got it" / "Not now").
4. Press Play (button under the player). Captions change at 0.5 s, 2.8 s, 5.2 s, 7.6 s; title shows for 3 s;
   music fades in and out.

**Scene 4: close (≈10 s).** Optional: Export in CapCut (top right) to show the final MP4.

## If something goes wrong

| Symptom | Fix |
|---|---|
| Tool says "CapCut is running" | Quit CapCut (Cmd+Q), ask the agent to retry |
| Plan has a `warning` about no CapCut-made project | Create an empty project in CapCut, quit, retry |
| Project not in the list | Quit and reopen CapCut; or ask the agent to run again with `register_in_index: true` on a new name |
| "Draft already exists" | Use a new name, or delete the old project inside CapCut |
| Media offline / relink | Source file was in Downloads/Desktop/Documents; move it to `~/capcut-mcp-work` and redo |

Read-only diagnosis: `zsh scripts/inspect-capcut.sh | pbcopy` and paste it to the agent.
