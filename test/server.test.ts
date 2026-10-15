// Run: node --test test/server.test.ts   (Node >= 22.18)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, parseSrt, probeMedia } from "../server.ts";
import { featureTools } from "../features.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "capcut-mcp-"))); // macOS: /var -> /private/var
const ROOT = join(tmp, "drafts"), OUT = join(tmp, "capcut"), MEDIA = join(tmp, "media");
for (const d of [ROOT, OUT, MEDIA]) mkdirSync(d);
process.env.CAPCUT_DRAFTS_ROOT = ROOT;
process.env.CAPCUT_EXPORT_ROOT = OUT;
process.env.CAPCUT_TARGET_OS = "windows"; // same default layout on every OS; the macOS layout test switches it
process.env.CAPCUT_ALLOW_RUNNING = "1"; // tests write to a temp folder, never to CapCut's own
writeFileSync(join(MEDIA, "clip.mp4"), Buffer.alloc(1024, 1));
writeFileSync(join(MEDIA, "song.mp3"), Buffer.alloc(512, 2));
const SRT = "1\r\n00:00:00,000 --> 00:00:01,500\r\nHola\r\n\r\n2\r\n00:00:01,500 --> 00:00:03,000\r\nque tal\r\nlinea 2\r\n";

let n = 0;
function call(name: string, args: Record<string, unknown>) {
  const r = handle({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } });
  const text = r.result.content[0].text;
  return { isError: !!r.result.isError, text, data: r.result.isError ? null : JSON.parse(text) };
}
const draftJson = (name: string, root = ROOT, file = "draft_content.json") => JSON.parse(readFileSync(join(root, name, file), "utf8"));

// Minimal ISO-BMFF file: ftyp + moov(mvhd, trak(tkhd)) with a 90-degree matrix (phone video stored landscape).
function box(type: string, ...parts: Buffer[]) { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); }
function mp4(seconds: number, w: number, h: number, rotated: boolean) {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const tkhd = Buffer.alloc(84);
  if (rotated) { tkhd.writeInt32BE(0, 40); tkhd.writeInt32BE(65536, 44); } else tkhd.writeInt32BE(65536, 40);
  tkhd.writeUInt32BE(w * 65536, 76); tkhd.writeUInt32BE(h * 65536, 80);
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("mdat", Buffer.alloc(64)), box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd)))]);
}
function wav(seconds: number, rate = 8000) {
  const data = rate * 2 * seconds, b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + data, 4); b.write("WAVEfmt ", 8, "latin1"); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1"); b.writeUInt32LE(data, 40); return b;
}
writeFileSync(join(MEDIA, "phone.mp4"), mp4(4.5, 1920, 1080, true));
writeFileSync(join(MEDIA, "music.wav"), wav(2));

test("SRT parser handles CRLF, multi-line cues, and bad timing", () => {
  const cues = parseSrt(SRT);
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[0, 1.5, "Hola"], [1.5, 3, "que tal\nlinea 2"]]);
  assert.throws(() => parseSrt("1\n00:00:02,000 --> 00:00:01,000\nx\n"));
});

test("create is dry-run by default, then writes a 1080x1920 draft", () => {
  const dry = call("capcut_create_draft", { name: "Short 1" });
  assert.equal(dry.data.dry_run, true);
  assert.equal(existsSync(join(ROOT, "Short 1")), false);
  const real = call("capcut_create_draft", { name: "Short 1", dry_run: false });
  assert.equal(real.data.written, true);
  for (const f of ["draft_content.json", "draft_info.json", "draft_meta_info.json"]) assert.ok(existsSync(join(ROOT, "Short 1", f)), f);
  assert.deepEqual(draftJson("Short 1").canvas_config, { width: 1080, height: 1920, ratio: "9:16" });
  assert.equal(call("capcut_list_drafts", {}).data.count, 1);
  assert.equal(call("capcut_create_draft", { name: "Short 1", dry_run: false }).isError, true, "no overwrite");
});

test("inputs are validated: path traversal, unknown args, ranges, missing files", () => {
  assert.match(call("capcut_read_draft", { draft: "../etc" }).text, /folder name/);
  assert.match(call("capcut_create_draft", { name: "a/b" }).text, /folder name/);
  assert.match(call("capcut_read_draft", { draft: "Short 1", evil: 1 }).text, /Unknown argument/);
  assert.match(call("capcut_create_draft", { name: "X", fps: 29 }).text, /fps/);
  assert.match(call("capcut_add_clip", { draft: "Short 1", path: "relative.mp4", start_s: 0, duration_s: 1 }).text, /absolute/);
  assert.match(call("capcut_add_clip", { draft: "Short 1", path: join(MEDIA, "nope.mp4"), start_s: 0, duration_s: 1 }).text, /does not exist/);
  assert.match(call("capcut_add_text", { draft: "Short 1", text: "x", start_s: 0, duration_s: 1, color: "red" }).text, /#RRGGBB/);
});

test("clip, text, subtitles: dry-run changes nothing, real write builds the timeline", () => {
  const before = readFileSync(join(ROOT, "Short 1", "draft_content.json"), "utf8");
  const dry = call("capcut_add_clip", { draft: "Short 1", path: join(MEDIA, "clip.mp4"), start_s: 0, duration_s: 3 });
  assert.equal(dry.data.dry_run, true);
  assert.equal(readFileSync(join(ROOT, "Short 1", "draft_content.json"), "utf8"), before);

  assert.equal(call("capcut_add_clip", { draft: "Short 1", path: join(MEDIA, "clip.mp4"), start_s: 0, duration_s: 3, dry_run: false }).data.written, true);
  assert.match(call("capcut_add_clip", { draft: "Short 1", path: join(MEDIA, "clip.mp4"), start_s: 2, duration_s: 1, dry_run: false }).text, /Overlaps/);
  call("capcut_add_clip", { draft: "Short 1", path: join(MEDIA, "song.mp3"), start_s: 0, duration_s: 3, volume: 0.5, dry_run: false });
  call("capcut_add_text", { draft: "Short 1", text: "Mira esto", start_s: 0, duration_s: 1.5, dry_run: false });
  const sub = call("capcut_add_subtitles", { draft: "Short 1", srt_text: SRT, dry_run: false });
  assert.equal(sub.data.cues, 2);

  const d = draftJson("Short 1");
  assert.equal(d.duration, 3_000_000);
  const video = d.tracks.find((t: any) => t.type === "video");
  assert.deepEqual(video.segments[0].target_timerange, { start: 0, duration: 3_000_000 });
  const audio = d.tracks.find((t: any) => t.type === "audio");
  assert.equal(audio.segments[0].clip, null, "audio clip must be null");
  assert.equal(d.tracks.filter((t: any) => t.type === "text").length, 2);
  const vmat = d.materials.videos[0];
  assert.ok(existsSync(vmat.path) && vmat.path.startsWith(join(ROOT, "Short 1", "assets")), "media copied into draft");
  const meta = JSON.parse(readFileSync(join(ROOT, "Short 1", "draft_meta_info.json"), "utf8"));
  assert.ok(meta.draft_materials[0].value.some((e: any) => e.id === vmat.local_material_id), "media registered and linked");
  assert.deepEqual(JSON.parse(d.materials.texts[0].content).styles[0].range, [0, 9]);
  assert.ok(existsSync(join(ROOT, "Short 1", "draft_content.json.bak")), "backup before overwrite");
  assert.equal(readFileSync(join(ROOT, "Short 1", "draft_info.json"), "utf8"), readFileSync(join(ROOT, "Short 1", "draft_content.json"), "utf8"));
});

test("set_timeline refuses to cut segments and updates canvas", () => {
  assert.match(call("capcut_set_timeline", { draft: "Short 1", duration_s: 1, dry_run: false }).text, /shorter/);
  const r = call("capcut_set_timeline", { draft: "Short 1", duration_s: 5, width: 1080, height: 1350, dry_run: false });
  assert.equal(r.data.after.canvas.ratio, "4:5");
  assert.equal(draftJson("Short 1").duration, 5_000_000);
});

test("set_timeline color_space matches the CapCut 9.5 UI diff", () => {
  assert.match(call("capcut_set_timeline", { draft: "Short 1", color_space: "rec999", dry_run: false }).text, /color_space/);
  const r = call("capcut_set_timeline", { draft: "Short 1", color_space: "rec2100_hlg", dry_run: false });
  assert.equal(r.data.after.color_space, "rec2100_hlg");
  let d = draftJson("Short 1");
  assert.equal(d.color_space, 67);
  for (const sg of d.tracks.find((t: any) => t.type === "video").segments) assert.equal(sg.hdr_settings.mode, 2);
  call("capcut_set_timeline", { draft: "Short 1", color_space: "rec2100_pq", dry_run: false });
  d = draftJson("Short 1"); assert.equal(d.color_space, 2084);
  call("capcut_set_timeline", { draft: "Short 1", color_space: "rec709_sdr", dry_run: false });
  d = draftJson("Short 1"); assert.equal(d.color_space, 0);
  assert.equal(d.tracks.find((t: any) => t.type === "video").segments[0].hdr_settings.mode, 1);
});

test("export copies into CAPCUT_EXPORT_ROOT, repoints media, never overwrites", () => {
  assert.equal(call("capcut_export_draft", { draft: "Short 1" }).data.dry_run, true);
  assert.equal(existsSync(join(OUT, "Short 1")), false);
  call("capcut_export_draft", { draft: "Short 1", dry_run: false });
  const d = draftJson("Short 1", OUT);
  assert.ok(d.materials.videos[0].path.startsWith(join(OUT, "Short 1")));
  assert.ok(existsSync(d.materials.videos[0].path));
  assert.match(call("capcut_export_draft", { draft: "Short 1", dry_run: false }).text, /already exists/);
});

test("encrypted and app-timeline drafts are read-safe and write-refused", () => {
  mkdirSync(join(ROOT, "Enc"));
  writeFileSync(join(ROOT, "Enc", "draft_content.json"), Buffer.from([0x8a, 0x01, 0xff, 0x00]));
  const enc = call("capcut_list_drafts", {}).data.drafts.find((x: any) => x.folder === "Enc");
  assert.equal(enc.encrypted, true);
  assert.match(call("capcut_read_draft", { draft: "Enc" }).text, /does not decrypt/);
  call("capcut_create_draft", { name: "App", dry_run: false });
  mkdirSync(join(ROOT, "App", "Timelines"));
  assert.match(call("capcut_add_text", { draft: "App", text: "x", start_s: 0, duration_s: 1, dry_run: false }).text, /Timelines/);
});

test("template_draft copies app markers and sidecars, not timeline content", () => {
  const t = join(ROOT, "Empty From App");
  mkdirSync(join(t, "Timelines"), { recursive: true });
  const app = { id: "X", name: "Empty From App", duration: 9, fps: 30, version: 360000, platform: { app_source: "cc", app_version: "9.3.0", os: "mac" },
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" }, tracks: [{ id: "t", type: "video", segments: [{}] }], materials: { videos: [{ id: "m" }], flowers: [{}] } };
  writeFileSync(join(t, "draft_info.json"), JSON.stringify(app));
  writeFileSync(join(t, "draft_meta_info.json"), JSON.stringify({ draft_name: "Empty From App", draft_id: "X", custom_field: 7 }));
  writeFileSync(join(t, "draft_settings"), "[General]\n");
  call("capcut_create_draft", { name: "From Tmpl", template_draft: "Empty From App", dry_run: false });
  const d = draftJson("From Tmpl", ROOT, "draft_info.json");
  assert.equal(existsSync(join(ROOT, "From Tmpl", "draft_content.json")), false, "file layout follows the template");
  assert.deepEqual(d.platform, app.platform);
  assert.equal(d.version, 360000);
  assert.deepEqual(d.tracks, []);
  assert.deepEqual(d.materials.flowers, []);
  assert.equal(d.canvas_config.ratio, "9:16");
  assert.ok(existsSync(join(ROOT, "From Tmpl", "draft_settings")));
  assert.equal(existsSync(join(ROOT, "From Tmpl", "Timelines")), false);
  const meta = JSON.parse(readFileSync(join(ROOT, "From Tmpl", "draft_meta_info.json"), "utf8"));
  assert.equal(meta.custom_field, 7);
  assert.equal(meta.draft_name, "From Tmpl");
});

test("probeMedia reads MP4 length and rotated size, and WAV length", () => {
  assert.deepEqual(probeMedia(join(MEDIA, "phone.mp4")), { duration_s: 4.5, width: 1080, height: 1920 });
  assert.deepEqual(probeMedia(join(MEDIA, "music.wav")), { duration_s: 2 });
  assert.deepEqual(probeMedia(join(MEDIA, "song.mp3")), {}, "unknown formats give nothing, not a guess");
});

test("add_audio: music track, volume, fades; refuses video and too-long ranges", () => {
  call("capcut_create_draft", { name: "Audio", template_draft: "none", dry_run: false });
  assert.match(call("capcut_add_audio", { draft: "Audio", path: join(MEDIA, "phone.mp4") }).text, /audio file/);
  assert.match(call("capcut_add_audio", { draft: "Audio", path: join(MEDIA, "music.wav"), duration_s: 3 }).text, /longer than the file/);
  assert.match(call("capcut_add_audio", { draft: "Audio", path: join(MEDIA, "music.wav"), fade_in_s: 1.5, fade_out_s: 1 }).text, /fade/);
  const r = call("capcut_add_audio", { draft: "Audio", path: join(MEDIA, "music.wav"), volume: 0.3, fade_in_s: 0.5, fade_out_s: 0.5, dry_run: false });
  assert.equal(r.data.duration_s, 2, "length read from the WAV header");
  const d = draftJson("Audio");
  const t = d.tracks.find((x: any) => x.type === "audio");
  assert.equal(t.name, "music");
  assert.equal(t.segments[0].volume, 0.3);
  const fade = d.materials.audio_fades[0];
  assert.deepEqual([fade.fade_in_duration, fade.fade_out_duration, fade.type], [500_000, 500_000, "audio_fade"]);
  assert.ok(t.segments[0].extra_material_refs.includes(fade.id));
});

test("make_short (new draft, macOS layout): one call, dry-run first, then clip + title + subs + music", () => {
  process.env.CAPCUT_TARGET_OS = "mac";
  try {
    const args = { name: "Demo", template_draft: "none", clip_path: join(MEDIA, "phone.mp4"), title: "3 tips", music_path: join(MEDIA, "music.wav"),
      srt_text: SRT + "\n3\n00:00:09,000 --> 00:00:10,000\nafter the end\n" };
    const dry = call("capcut_make_short", args);
    assert.equal(dry.data.dry_run, true, dry.text);
    assert.equal(existsSync(join(ROOT, "Demo")), false);
    assert.equal(dry.data.duration_s, 4.5);
    assert.equal(dry.data.steps.subtitles.dropped_after_end, 1);
    assert.match(call("capcut_make_short", { ...args, draft: "Audio" }).text, /exactly one/);
    const real = call("capcut_make_short", { ...args, dry_run: false });
    assert.equal(real.data.written, true, real.text);
    assert.equal(existsSync(join(ROOT, "Demo", "draft_content.json")), false, "macOS: draft_info.json only");
    const d = draftJson("Demo", ROOT, "draft_info.json");
    assert.equal(d.duration, 4_500_000);
    assert.equal(d.materials.videos[0].width, 1080);
    assert.equal(d.materials.videos[0].height, 1920);
    assert.deepEqual(d.tracks.map((t: any) => `${t.type}:${t.name}`), ["video:main", "text:text", "text:subtitles", "audio:music"]);
    const music = d.tracks[3].segments[0];
    assert.equal(music.target_timerange.duration, 2_000_000, "music no longer than the file");
    assert.equal(d.materials.audio_fades[0].fade_in_duration, 1_000_000);
    const meta = JSON.parse(readFileSync(join(ROOT, "Demo", "draft_meta_info.json"), "utf8"));
    assert.ok(meta.draft_json_file.endsWith("draft_info.json"));
    assert.equal(meta.draft_materials[0].value.length, 2, "clip and music registered");
  } finally { process.env.CAPCUT_TARGET_OS = "windows"; }
});

test("make_short fills an empty CapCut 9.x project in place: nested timeline + mirrors + index", () => {
  const p = join(ROOT, "Shell 95"), tid = "C1EFCDF2-B885-48ff-A2F8-C33A6C4F4A52";
  mkdirSync(join(p, "Timelines", tid), { recursive: true });
  const app = { id: tid, name: "", duration: 0, fps: 30, version: 360000, new_version: "171.0.0",
    platform: { app_source: "cc", app_version: "9.5.0", os: "mac" }, canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    tracks: [], materials: { videos: [], audios: [], texts: [] } };
  writeFileSync(join(p, "Timelines", "project.json"), JSON.stringify({ id: "P1", main_timeline_id: tid, timelines: [{ id: tid, is_marked_delete: false }] }));
  writeFileSync(join(p, "Timelines", tid, "draft_info.json"), JSON.stringify(app));
  writeFileSync(join(p, "draft_info.json"), JSON.stringify({ ...app, id: "ROOT-ID" }));
  writeFileSync(join(p, "template-2.tmp"), JSON.stringify(app));
  writeFileSync(join(p, "draft_meta_info.json"), JSON.stringify({ draft_name: "Shell 95", draft_id: "M1", draft_fold_path: p, draft_materials: [{ type: 0, value: [] }, { type: 1, value: [] }] }));
  writeFileSync(join(ROOT, "root_meta_info.json"), JSON.stringify({ all_draft_store: [{ draft_fold_path: "/other", draft_name: "Other", tm_duration: 7 }, { draft_fold_path: p, draft_name: "Shell 95", tm_duration: 0, extra: "kept" }], root_path: ROOT }));
  const r = call("capcut_make_short", { draft: "Shell 95", clip_path: join(MEDIA, "phone.mp4"), duration_s: 3, title: "Hola", register_in_index: true, dry_run: false });
  assert.equal(r.data.written, true, r.text);
  assert.equal(r.data.mode, "filled in place");
  assert.equal(r.data.index.action, "updated");
  assert.ok(existsSync(r.data.index.backup), "index backed up");
  for (const [f, id] of [[join("Timelines", tid, "draft_info.json"), tid], ["draft_info.json", "ROOT-ID"], ["template-2.tmp", tid]]) {
    const d = JSON.parse(readFileSync(join(p, f), "utf8"));
    assert.equal(d.id, id, `${f} keeps its own id`);
    assert.equal(d.tracks.length, 2, f);
    assert.equal(d.platform.app_version, "9.5.0");
    assert.equal(d.canvas_config.ratio, "9:16");
  }
  const idx = JSON.parse(readFileSync(join(ROOT, "root_meta_info.json"), "utf8"));
  assert.equal(idx.all_draft_store.length, 2, "other projects untouched");
  assert.equal(idx.all_draft_store[1].tm_duration, 3_000_000);
  assert.equal(idx.all_draft_store[1].extra, "kept");
  assert.equal(call("capcut_read_draft", { draft: "Shell 95" }).data.timeline_file, join("Timelines", tid, "draft_info.json"));
  assert.match(call("capcut_make_short", { draft: "Shell 95", clip_path: join(MEDIA, "phone.mp4") }).text, /not empty/);
  // A new draft with template auto copies the 9.5.0 markers, but not Timelines/.
  const c = call("capcut_create_draft", { name: "Seeded", register_in_index: true, dry_run: false });
  assert.equal(c.data.template_app_version, "9.5.0", c.text);
  assert.deepEqual(c.data.layout, ["draft_info.json", "template-2.tmp"]);
  assert.equal(existsSync(join(ROOT, "Seeded", "Timelines")), false);
  assert.equal(draftJson("Seeded", ROOT, "draft_info.json").new_version, "171.0.0");
  assert.equal(JSON.parse(readFileSync(join(ROOT, "root_meta_info.json"), "utf8")).all_draft_store.length, 3, "appended");
});

test("real CapCut 9.5.0 saved draft (sanitized fixture): nested timeline read, placeholders resolved, ids hidden, mirrors written", () => {
  const fx = join(import.meta.dirname, "fixtures", "capcut-9.5-mac-saved");
  const doc = JSON.parse(readFileSync(join(fx, "draft_info.json"), "utf8")), tid = doc.id;
  const p = join(ROOT, "Saved 95");
  mkdirSync(join(p, "Timelines", tid), { recursive: true });
  mkdirSync(join(p, "assets", "video"), { recursive: true });
  writeFileSync(join(p, "assets", "video", "clip.mp4"), "x");
  copyFileSync(join(fx, "project.json"), join(p, "Timelines", "project.json"));
  copyFileSync(join(fx, "draft_meta_info.json"), join(p, "draft_meta_info.json"));
  for (const f of ["draft_info.json", "template-2.tmp", join("Timelines", tid, "draft_info.json"), join("Timelines", tid, "template-2.tmp")]) copyFileSync(join(fx, "draft_info.json"), join(p, f));
  const r = call("capcut_read_draft", { draft: "Saved 95" }).data;
  assert.equal(r.timeline_file, join("Timelines", tid, "draft_info.json"));
  assert.equal(r.app.app_version, "9.5.0");
  assert.equal(r.app.device_id, undefined, "machine identifiers are not echoed");
  assert.deepEqual(r.tracks.map((t: any) => `${t.type}:${t.name}`), ["video:main", "text:text", "audio:music"]);
  assert.equal(r.tracks[0].segments[0].path, join(p, "assets", "video", "clip.mp4"), "placeholder path resolved");
  assert.equal(r.tracks[2].segments[0].volume, 0.3);
  const w = call("capcut_add_text", { draft: "Saved 95", text: "Follow for more", start_s: 7, duration_s: 3, track: "cta", dry_run: false });
  assert.equal(w.data.written, true, w.text);
  for (const f of ["draft_info.json", "template-2.tmp", join("Timelines", tid, "draft_info.json"), join("Timelines", tid, "template-2.tmp")]) {
    const d = JSON.parse(readFileSync(join(p, f), "utf8"));
    assert.equal(d.tracks.length, 4, f);
    assert.equal(d.platform.app_version, "9.5.0");
    assert.equal(d.materials.texts.at(-1).id, d.tracks[3].segments[0].material_id);
  }
});

test("live stdio session: initialize, tools/list, tools/call", async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "server.ts")], { env: process.env });
  const lines: any[] = [];
  let buf = "";
  child.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "capcut_read_draft", arguments: { draft: "Short 1" } } });
  child.stdin.write("not json\n");
  await new Promise((r) => setTimeout(r, 1500));
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, "capcut-mcp");
  assert.equal(lines[1].result.tools.length, 10 + Object.keys(featureTools()).length);
  assert.equal(JSON.parse(lines[2].result.content[0].text).canvas.ratio, "4:5");
  assert.equal(lines[3].error.code, -32700);
});
