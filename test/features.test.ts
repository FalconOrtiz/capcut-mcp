// Run: node --test test/features.test.ts   (Node >= 22.18). Tests for the feature-map tools (v0.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkCues, handle, mustQuitCapCut } from "../server.ts";
import { remapCues } from "../features.ts";
import { curveAverage, curveHandles } from "../features.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "capcut-mcp-f-")));
const ROOT = join(tmp, "drafts"), MEDIA = join(tmp, "media");
for (const d of [ROOT, MEDIA]) mkdirSync(d);
process.env.CAPCUT_DRAFTS_ROOT = ROOT;
process.env.CAPCUT_TARGET_OS = "windows";
process.env.CAPCUT_ALLOW_RUNNING = "1";
writeFileSync(join(MEDIA, "clip.mp4"), Buffer.alloc(1024, 1));
writeFileSync(join(MEDIA, "song.mp3"), Buffer.alloc(512, 2));

let n = 0;
function call(name: string, args: Record<string, unknown>) {
  const r = handle({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } });
  const text = r.result.content[0].text;
  return { isError: !!r.result.isError, text, data: r.result.isError ? null : JSON.parse(text) };
}
const draft = (name: string) => JSON.parse(readFileSync(join(ROOT, name, "draft_content.json"), "utf8"));
const mk = (name: string) => call("capcut_create_draft", { name, template_draft: "none", dry_run: false });
const r2 = (r: { isError: boolean; text: string }) => assert.equal(r.isError, false, r.text);
const clip = (d: string, start_s: number, duration_s: number, extra: object = {}) =>
  call("capcut_add_clip", { draft: d, path: join(MEDIA, "clip.mp4"), media_duration_s: 60, start_s, duration_s, dry_run: false, ...extra });

test("times snap to the frame grid by start and end, so back-to-back 3.75 s clips at 30 fps do not overlap", () => {
  mk("Snap");
  for (let i = 0; i < 4; i++) { const r = clip("Snap", i * 3.75, 3.75); assert.equal(r.isError, false, r.text); }
  const segs = draft("Snap").tracks[0].segments;
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1].target_timerange;
    assert.equal(prev.start + prev.duration, segs[i].target_timerange.start, "no gap, no overlap");
  }
  assert.equal(segs[3].target_timerange.start + segs[3].target_timerange.duration, 15_000_000);
});

test("running guard: only drafts CapCut knows (Timelines/ or listed in the index) or index writes need CapCut closed", () => {
  mk("Fresh");
  assert.equal(mustQuitCapCut(join(ROOT, "Fresh"), false, false), false, "never opened by CapCut");
  assert.equal(mustQuitCapCut(join(ROOT, "Brand New"), true, false), false, "new folder");
  assert.equal(mustQuitCapCut(join(ROOT, "Fresh"), false, true), true, "index write: CapCut owns root_meta_info.json");
  mkdirSync(join(ROOT, "Opened", "Timelines"), { recursive: true });
  assert.equal(mustQuitCapCut(join(ROOT, "Opened"), false, false), true);
  writeFileSync(join(ROOT, "root_meta_info.json"), JSON.stringify({ all_draft_store: [{ draft_fold_path: join(ROOT, "Fresh") }] }));
  assert.equal(mustQuitCapCut(join(ROOT, "Fresh"), false, false), true, "listed in CapCut's project list");
});

test("register_draft writes the current duration into root_meta_info.json (dry-run first)", () => {
  mk("Reg");
  clip("Reg", 0, 2);
  assert.equal(call("capcut_register_draft", { draft: "Reg" }).data.dry_run, true);
  const r = call("capcut_register_draft", { draft: "Reg", dry_run: false });
  assert.equal(r.data.index.action, "appended", r.text);
  const e = JSON.parse(readFileSync(join(ROOT, "root_meta_info.json"), "utf8")).all_draft_store.find((x: any) => x.draft_fold_path === join(ROOT, "Reg"));
  assert.equal(e.tm_duration, 2_000_000);
});

test("template auto-detection also searches CAPCUT_TEMPLATE_ROOT", () => {
  const other = join(tmp, "capcut-root"), t = join(other, "Empty");
  mkdirSync(join(t, "Timelines"), { recursive: true });
  writeFileSync(join(t, "draft_info.json"), JSON.stringify({ id: "E", fps: 30, version: 360000, new_version: "187.0.0", platform: { app_version: "9.5.0" }, canvas_config: { width: 1080, height: 1920 }, tracks: [], materials: {} }));
  process.env.CAPCUT_TEMPLATE_ROOT = other;
  try {
    const r = call("capcut_create_draft", { name: "Seeded Elsewhere", dry_run: false });
    assert.equal(r.data.template_app_version, "9.5.0", r.text);
    assert.equal(JSON.parse(readFileSync(join(ROOT, "Seeded Elsewhere", "draft_info.json"), "utf8")).new_version, "187.0.0");
  } finally { delete process.env.CAPCUT_TEMPLATE_ROOT; }
});

const SRT = "1\n00:00:00,000 --> 00:00:01,500\nque tal\n\n2\n00:00:01,500 --> 00:00:03,000\nmira esto tal cual\n";
const texts = (d: any, track: string) => {
  const t = d.tracks.find((x: any) => x.type === "text" && x.name === track);
  return t.segments.map((s: any) => d.materials.texts.find((m: any) => m.id === s.material_id));
};

test("style_text: stroke, shadow and background box on every cue; dry-run first; CapCut 9.5 field names", () => {
  mk("Style");
  call("capcut_add_subtitles", { draft: "Style", srt_text: SRT, dry_run: false });
  const before = readFileSync(join(ROOT, "Style", "draft_content.json"), "utf8");
  const args = { draft: "Style", track: "subtitles", stroke_color: "#000000", stroke_width: 40, shadow: { color: "#000000", alpha: 0.6, distance: 12, angle: 30, smoothing: 40 },
    bg_color: "#101010", bg_alpha: 0.6, bg_round_radius: 0.2, bg_style: 2, bg_height: 0.2, bg_width: 0.25, bg_offset_x: -0.4, bg_offset_y: 0.4, bold: true, max_width: 0.7, alignment: "center" };
  const dry = call("capcut_style_text", args);
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(dry.data.segments, 2);
  assert.equal(readFileSync(join(ROOT, "Style", "draft_content.json"), "utf8"), before);
  assert.equal(call("capcut_style_text", { ...args, dry_run: false }).data.written, true);
  for (const m of texts(draft("Style"), "subtitles")) {
    assert.equal(m.border_color, "#000000");
    assert.equal(m.border_width, 0.08, "UI 40 -> 0.08 (UI diff 9.5.0)");
    assert.equal(m.has_shadow, true);
    assert.equal(m.shadow_color, "#000000");
    assert.equal(m.background_color, "#101010");
    assert.equal(m.background_alpha, 0.6);
    assert.equal(m.background_style, 2);
    // values as CapCut 9.5.0 wrote them for the same UI inputs (session 4 UI diff)
    assert.equal(m.background_height, 0.2); assert.equal(m.background_width, 0.25);
    assert.equal(m.background_horizontal_offset, -0.4); assert.equal(m.background_vertical_offset, 0.4);
    assert.ok(Math.abs(m.shadow_smoothing - 1.2) < 1e-9);
    assert.ok(Math.abs(m.shadow_point.x - 1.8706148721743878) < 1e-5 && Math.abs(m.shadow_point.y - 1.08) < 1e-5);
    assert.equal(m.line_max_width, 0.7);
    assert.equal(m.force_apply_line_max_width, true);
    assert.equal(m.alignment, 1);
    assert.equal(m.check_flag, 7 | 8 | 16 | 32);
    const st = JSON.parse(m.content).styles[0];
    assert.equal(st.bold, true);
    assert.deepEqual(st.strokes, [{ width: 0.08, mode: 0, content: { solid: { color: [0, 0, 0] }, render_type: "solid" } }]);
    assert.equal(st.shadows[0].distance, 12);
    assert.ok(Math.abs(st.shadows[0].diffuse - 0.0666666701436) < 1e-6);
  }
});

test("style_text: word highlight splits styles into UTF-16 ranges; only the cue at start_s when given", () => {
  call("capcut_style_text", { draft: "Style", track: "subtitles", highlight: [{ word: "tal", color: "#F8D508" }], dry_run: false });
  const [a, b] = texts(draft("Style"), "subtitles").map((m: any) => JSON.parse(m.content));
  assert.deepEqual(a.styles.map((s: any) => s.range), [[0, 4], [4, 7]]);
  assert.deepEqual(a.styles[1].fill.content.solid.color, [248 / 255, 213 / 255, 8 / 255]);
  assert.deepEqual(a.styles[1].strokes, a.styles[0].strokes, "highlight keeps the stroke");
  assert.deepEqual(b.styles.map((s: any) => s.range), [[0, 10], [10, 13], [13, 18]]);
  const one = call("capcut_style_text", { draft: "Style", track: "subtitles", start_s: 1.5, color: "#FF0000" });
  assert.equal(one.data.segments, 1);
  assert.match(call("capcut_style_text", { draft: "Style", track: "nope", bold: true }).text, /No text track/);
  assert.match(call("capcut_style_text", { draft: "Style", track: "subtitles", font_path: "/no/such.ttf" }).text, /does not exist/);
  assert.match(call("capcut_style_text", { draft: "Style", track: "subtitles", stroke_width: 101 }).text, /stroke_width/);
});

test("set_clip: transform, canvas background and blend mode on a video segment (dry-run first)", () => {
  mk("Clip");
  clip("Clip", 0, 4); clip("Clip", 4, 2);
  assert.equal(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, scale: 1.3 }).data.dry_run, true);
  const r = call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, scale: 1.3, x: 0.2, y: -0.1, rotation: 5, alpha: 0.8,
    background: { type: "color", color: "#101010" }, blend_mode: "screen", dry_run: false });
  assert.equal(r.data.written, true, r.text);
  const d = draft("Clip"), s = d.tracks[0].segments[0];
  assert.deepEqual(s.clip.scale, { x: 1.3, y: 1.3 });
  assert.deepEqual(s.clip.transform, { x: 0.2, y: -0.1 });
  assert.equal(s.clip.rotation, 5);
  assert.equal(s.clip.alpha, 0.8);
  assert.equal(s.uniform_scale.value, 1.3);
  const canvas = d.materials.canvases.find((c: any) => s.extra_material_refs.includes(c.id));
  assert.deepEqual([canvas.type, canvas.color], ["canvas_color", "#101010ff"]);
  const mix = d.materials.effects.find((e: any) => s.extra_material_refs.includes(e.id));
  assert.deepEqual([mix.type, mix.effect_id, mix.resource_id, mix.name, mix.path, mix.third_resource_id], ["mix_mode", "871339", "6758325170760323597", "Pantalla",
    "/Applications/CapCut.app/Contents/MacOS/../Resources/MixMode/d9c1d4ca7ab91df4f48d12b339f2da88", ""], "as CapCut 9.5.0 writes Pantalla (UI diff 2026-10-04)");
  call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, background: { type: "blur", blur: 0.375 }, blend_mode: "normal", dry_run: false });
  const d2 = draft("Clip"), s2 = d2.tracks[0].segments[0];
  const c2 = d2.materials.canvases.find((c: any) => s2.extra_material_refs.includes(c.id));
  assert.deepEqual([c2.type, c2.blur], ["canvas_blur", 0.375]);
  assert.equal(d2.materials.effects.some((e: any) => s2.extra_material_refs.includes(e.id)), false, "normal removes the blend ref");
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, blend_mode: "glow" }).text, /blend_mode/);
});

test("set_clip: speed shortens the timeline length, keeps the source range, refuses overlaps", () => {
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, speed: 0.5 }).text, /Overlaps/);
  const r = call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 4, speed: 2, dry_run: false });
  assert.equal(r.isError, false, r.text);
  const d = draft("Clip"), s = d.tracks[0].segments[1];
  assert.deepEqual([s.target_timerange.duration, s.source_timerange.duration, s.speed], [1_000_000, 2_000_000, 2]);
  const sp = d.materials.speeds.find((x: any) => s.extra_material_refs.includes(x.id));
  assert.equal(sp.speed, 2);
  assert.equal(d.duration, 5_000_000);
});

test("set_clip: audio fades on audio and video segments (video keeps a copy on materials.videos[]), denoise, basic adjust", () => {
  call("capcut_add_audio", { draft: "Clip", path: join(MEDIA, "song.mp3"), media_duration_s: 30, duration_s: 5, dry_run: false });
  const r = call("capcut_set_clip", { draft: "Clip", track: "music", start_s: 0, fade_in_s: 0.5, fade_out_s: 1, volume: 0.25, dry_run: false });
  assert.equal(r.isError, false, r.text);
  const d = draft("Clip"), s = d.tracks.find((t: any) => t.name === "music").segments[0];
  const f = d.materials.audio_fades.filter((x: any) => s.extra_material_refs.includes(x.id));
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].fade_in_duration, f[0].fade_out_duration, s.volume], [500_000, 1_000_000, 0.25]);
  r2(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, fade_in_s: 1, fade_out_s: 1.5, denoise: true, adjust: { exposure: 50, saturation: -50, temperature: 0 }, dry_run: false }));
  const d2 = draft("Clip"), v = d2.tracks[0].segments[0], refs = (k: string) => (d2.materials[k] ?? []).filter((x: any) => v.extra_material_refs.includes(x.id));
  const [vf] = refs("audio_fades"), [dn] = refs("realtime_denoises");
  assert.deepEqual([vf.fade_in_duration, vf.fade_out_duration], [1_000_000, 1_500_000]);
  assert.deepEqual(d2.materials.videos.find((m: any) => m.id === v.material_id).audio_fade, vf, "copy on the video material");
  assert.deepEqual([dn.is_denoise, dn.denoise_rate, dn.sami_name], [true, 0.85, "denoise_v2"]);
  assert.deepEqual(refs("effects").map((e: any) => [e.type, e.value, e.resource_id]), [["brightness", 1, "7501974767453474064"], ["saturation", -1, "7501974767453474064"]]);
  r2(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, denoise: false, adjust: { exposure: 0 }, dry_run: false }));
  assert.equal(draft("Clip").materials.realtime_denoises.length, 0);
  assert.equal(draft("Clip").materials.effects.filter((e: any) => e.type === "brightness").length, 0);
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, adjust: { hue: 3 } }).text, /Unknown adjust key/);
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "music", start_s: 0, scale: 2 }).text, /video/);
});

test("set_clip: stabilization level, audio channel copy and shape mask with CapCut 9.5.0 units (session 4 UI diff)", () => {
  r2(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, stabilize: 3, audio_channel: "right_to_left",
    mask: { shape: "rectangle", x: 100 / 960, y: -2 / 540, width: 400 / 1920, height: 300 / 1080, rotation: 30, feather: 40, round_corner: 20, invert: true }, dry_run: false }));
  const d = draft("Clip"), s = d.tracks[0].segments[0], refs = (k: string) => (d.materials[k] ?? []).filter((x: any) => s.extra_material_refs.includes(x.id));
  assert.equal(d.materials.videos.find((m: any) => m.id === s.material_id).stable.stable_level, 3);
  assert.deepEqual(refs("sound_channel_mappings").map((c: any) => [c.audio_channel_mapping, c.is_config_open]), [[2, true]]);
  const [m] = refs("common_mask");
  assert.deepEqual([m.type, m.resource_type, m.resource_id], ["mask", "rectangle", "7374021450748924432"]);
  // config exactly as CapCut wrote it for X 100, Y -2, 400x300 px, 30 deg, feather 40, corners 20, invert
  assert.deepEqual(m.config, { width: 0.20833333333333334, height: 0.2777777777777778, centerX: 0.10416666666666667, centerY: -0.003703703703703704,
    rotation: 30, feather: 0.4, expansion: 0, roundCorner: 0.2, invert: true, aspectRatio: 1 });
  r2(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, mask: { shape: "heart" }, dry_run: false }));
  const d2 = draft("Clip");
  assert.deepEqual(d2.materials.common_mask.map((x: any) => [x.resource_type, x.config.aspectRatio, x.config.width, x.config.height]), [["heart", 1.1148148148, 0.28, 0.5]], "one mask per clip, CapCut defaults");
  r2(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, mask: null, stabilize: 0, dry_run: false }));
  assert.equal(draft("Clip").materials.common_mask.length, 0);
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, mask: { shape: "brush" } }).text, /mask.shape/);
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "main", start_s: 0, stabilize: 1.5 }).text, /stabilize/);
  assert.match(call("capcut_set_clip", { draft: "Clip", track: "music", start_s: 0, mask: { shape: "circle" } }).text, /video/);
});

test("add_keyframes: one keyframe list per property on the segment, times relative to its start; replaces the old list", () => {
  mk("Kf");
  clip("Kf", 2, 4);
  const args = { draft: "Kf", track: "main", start_s: 2, property: "scale", points: [{ t_s: 4, value: 1.2 }, { t_s: 0, value: 1 }] };
  assert.equal(call("capcut_add_keyframes", args).data.dry_run, true);
  assert.equal(call("capcut_add_keyframes", { ...args, dry_run: false }).data.written, true);
  call("capcut_add_keyframes", { ...args, points: [{ t_s: 0, value: 1 }, { t_s: 2, value: 1.5 }], dry_run: false });
  const s = draft("Kf").tracks[0].segments[0];
  assert.equal(s.common_keyframes.length, 1, "same property replaced");
  const k = s.common_keyframes[0];
  assert.equal(k.property_type, "UNIFORM_SCALE");
  assert.deepEqual(k.keyframe_list.map((p: any) => [p.time_offset, p.values]), [[0, [1]], [2_000_000, [1.5]]]);
  assert.equal(k.keyframe_list[0].curveType, "Line");
  call("capcut_add_keyframes", { draft: "Kf", track: "main", start_s: 2, property: "position_x", points: [{ t_s: 0, value: 0 }, { t_s: 1, value: 0.5 }], dry_run: false });
  assert.deepEqual(draft("Kf").tracks[0].segments[0].common_keyframes.map((x: any) => x.property_type), ["UNIFORM_SCALE", "KFTypePositionX"]);
  assert.match(call("capcut_add_keyframes", { ...args, points: [{ t_s: 5, value: 1 }] }).text, /inside the segment/);
  assert.match(call("capcut_add_keyframes", { ...args, property: "loudness" }).text, /property/);
});

test("duck_music: volume keyframes dip under each SRT cue and ramp back; close cues merge", () => {
  mk("Duck");
  call("capcut_add_audio", { draft: "Duck", path: join(MEDIA, "song.mp3"), media_duration_s: 60, duration_s: 10, volume: 0.3, dry_run: false });
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nhola\n\n2\n00:00:02,300 --> 00:00:03,000\nque tal\n\n3\n00:00:06,000 --> 00:00:07,000\nfin\n";
  assert.equal(call("capcut_duck_music", { draft: "Duck", srt_text: srt }).data.dry_run, true);
  const r = call("capcut_duck_music", { draft: "Duck", srt_text: srt, under: 0.1, ramp_s: 0.25, dry_run: false });
  assert.equal(r.data.speech_ranges, 2, r.text);
  const s = draft("Duck").tracks[0].segments[0];
  assert.equal(s.volume, 1, "level lives in the keyframes");
  const k = s.common_keyframes.find((x: any) => x.property_type === "KFTypeVolume");
  const fr = (t: number) => Math.round(Math.round(t * 30) * (1e6 / 30));
  assert.deepEqual(k.keyframe_list.map((p: any) => [p.time_offset, p.values[0]]),
    [[0, 0.3], [0.75, 0.3], [1, 0.1], [3, 0.1], [3.25, 0.3], [5.75, 0.3], [6, 0.1], [7, 0.1], [7.25, 0.3]].map(([t, v]) => [fr(t), v]));
});

test("export_srt: writes a text track as SRT for YouTube CC; never overwrites", () => {
  const out = join(tmp, "cc.srt");
  assert.equal(call("capcut_export_srt", { draft: "Style", out_path: out }).data.dry_run, true);
  assert.equal(existsSync(out), false);
  const r = call("capcut_export_srt", { draft: "Style", out_path: out, dry_run: false });
  assert.equal(r.data.cues, 2, r.text);
  assert.equal(readFileSync(out, "utf8"), "1\n00:00:00,000 --> 00:00:01,500\nque tal\n\n2\n00:00:01,500 --> 00:00:03,000\nmira esto tal cual\n");
  assert.match(call("capcut_export_srt", { draft: "Style", out_path: out, dry_run: false }).text, /exists/);
  assert.match(call("capcut_export_srt", { draft: "Style", out_path: "rel.srt" }).text, /absolute/);
});

test("UI-diff tools: transition on the left clip, clip filter, animations, markers, volume_db (shapes from CapCut 9.5.0 saves)", () => {
  mk("Fx");
  clip("Fx", 0, 5); clip("Fx", 5, 5);
  const T = "6724845717472416269";
  const dry = call("capcut_add_transition", { draft: "Fx", start_s: 0, resource_id: T });
  assert.equal(dry.data?.dry_run, true, dry.text);
  assert.equal(call("capcut_add_transition", { draft: "Fx", start_s: 5, resource_id: T, dry_run: false }).isError, true, "no clip after the last one");
  assert.equal(call("capcut_add_transition", { draft: "Fx", start_s: 0, resource_id: T, duration_s: 3, dry_run: false }).isError, true, "longer than half a clip");
  let r = call("capcut_add_transition", { draft: "Fx", start_s: 0, resource_id: T, name: "Combinar", dry_run: false });
  assert.equal(r.isError, false, r.text); assert.match(r.data.warning, /cache/);
  r = call("capcut_add_transition", { draft: "Fx", start_s: 0, resource_id: "7679652398452755719", duration_s: 2.5, dry_run: false });
  assert.equal(r.data.replaced, true, r.text);
  let d = draft("Fx"), [s0, s1] = d.tracks[0].segments;
  assert.equal(d.materials.transitions.length, 1);
  const tr = d.materials.transitions[0];
  assert.equal(tr.duration, 2_500_000); assert.equal(tr.is_overlap, true); assert.equal(tr.resource_id, tr.effect_id);
  assert.ok(s0.extra_material_refs.includes(tr.id)); assert.ok(!s1.extra_material_refs.includes(tr.id));

  r = call("capcut_add_filter", { draft: "Fx", start_s: 5, resource_id: "7668224318974823701", intensity: 30, dry_run: false });
  assert.equal(r.isError, false, r.text);
  d = draft("Fx");
  const f = d.materials.effects.find((m: any) => m.type === "filter");
  assert.equal(f.value, 0.3); assert.ok(d.tracks[0].segments[1].extra_material_refs.includes(f.id));

  call("capcut_add_animation", { draft: "Fx", track: "main", start_s: 0, kind: "in", resource_id: "6740868384637850120", dry_run: false });
  r = call("capcut_add_animation", { draft: "Fx", track: "main", start_s: 0, kind: "out", resource_id: "7229983825080619522", duration_s: 0.9, dry_run: false });
  assert.deepEqual(r.data.animations, ["in", "out"], r.text);
  assert.equal(call("capcut_add_animation", { draft: "Fx", track: "main", start_s: 0, kind: "loop", resource_id: "7672949037338791182", dry_run: false }).isError, true);
  d = draft("Fx");
  const anims = d.materials.material_animations.find((m: any) => d.tracks[0].segments[0].extra_material_refs.includes(m.id)).animations;
  assert.equal(anims[1].start, 5_000_000 - 900_000); assert.equal(anims[1].material_type, "video");
  r = call("capcut_add_animation", { draft: "Fx", track: "main", start_s: 0, kind: "group", resource_id: "7229983825080619522", dry_run: false });
  assert.deepEqual(r.data.animations, ["group"], "combo replaces in/out");

  r = call("capcut_add_markers", { draft: "Fx", markers: [{ t_s: 4, title: "Outro" }, { t_s: 1 }], dry_run: false });
  assert.equal(r.data.total, 2, r.text);
  d = draft("Fx");
  assert.deepEqual(d.time_marks.mark_items.map((m: any) => [m.time_range.start, m.color]), [[1_000_000, "#00c1cd"], [4_000_000, "#00c1cd"]]);

  call("capcut_add_audio", { draft: "Fx", path: join(MEDIA, "song.mp3"), media_duration_s: 60, duration_s: 4, dry_run: false });
  for (const [db, gain] of [[-20, 0.1], [6, 1.995262], [20, 10], [-60, 0]]) {
    r = call("capcut_set_clip", { draft: "Fx", track: "music", start_s: 0, volume_db: db, dry_run: false });
    assert.equal(r.isError, false, r.text);
    assert.equal(draft("Fx").tracks.find((t: any) => t.type === "audio").segments[0].volume, gain, `${db} dB`);
  }
});

test("effects, adjustment layer and track reorder: render_index 11000+n, track_render_index = track position (CapCut 9.5.0 UI diff)", () => {
  mk("Lay");
  clip("Lay", 0, 10); clip("Lay", 0, 5, { track: "ov1" }); clip("Lay", 0, 5, { track: "ov2" });
  const BODY = "7688574067632377106", SCENE = "7434872753355756048";
  assert.equal(call("capcut_add_effect", { draft: "Lay", resource_id: SCENE, start_s: 1 }).data.dry_run, true);
  r2(call("capcut_add_effect", { draft: "Lay", resource_id: SCENE, start_s: 6, params: { effects_adjust_speed: 0.31 }, dry_run: false }));
  let r = call("capcut_add_effect", { draft: "Lay", kind: "body", resource_id: BODY, start_s: 1, duration_s: 3, dry_run: false });
  r2(r); assert.match(r.data.note, /algorithm_artifact_path/);
  assert.equal(call("capcut_add_effect", { draft: "Lay", resource_id: SCENE, start_s: 2, dry_run: false }).isError, true, "overlap on the same effect track");
  let d = draft("Lay"), et = d.tracks.find((t: any) => t.type === "effect");
  const byStart = et.segments.map((s: any) => [s.target_timerange.start, s.render_index, s.source_timerange]);
  assert.deepEqual(byStart, [[1_000_000, 11001, null], [6_000_000, 11000, null]]);
  assert.deepEqual(d.materials.video_effects.map((m: any) => [m.type, m.apply_target_type, m.adjust_params.length]), [["video_effect", 2, 1], ["face_effect", 2, 0]]);
  r2(call("capcut_add_adjustment_layer", { draft: "Lay", start_s: 0, duration_s: 4, adjust: { temperature: 25 }, dry_run: false }));
  d = draft("Lay");
  const at = d.tracks.find((t: any) => t.type === "adjust"), as = at.segments[0];
  assert.equal(d.materials.placeholders.find((p: any) => p.id === as.material_id).name, "Ajustar1");
  assert.equal(d.config.adjust_max_index, 2); assert.equal(as.enable_adjust, true);
  assert.equal(d.materials.effects.find((e: any) => as.extra_material_refs.includes(e.id)).value, 0.5);
  d.tracks.forEach((t: any, i: number) => t.segments.forEach((s: any) => assert.equal(s.track_render_index, i, t.type)));
  r = call("capcut_reorder_track", { draft: "Lay", type: "video", name: "ov2", position: 1, dry_run: false });
  r2(r); assert.deepEqual(r.data.order, ["main", "ov2", "ov1"]);
  d = draft("Lay");
  assert.deepEqual(d.tracks.filter((t: any) => t.type === "video").map((t: any) => t.name), ["main", "ov2", "ov1"]);
  d.tracks.forEach((t: any, i: number) => t.segments.forEach((s: any) => assert.equal(s.track_render_index, i)));
  assert.match(call("capcut_reorder_track", { draft: "Lay", type: "video", name: "ov1", position: 0 }).text, /main/);
  assert.match(call("capcut_reorder_track", { draft: "Lay", type: "video", name: "main", position: 2 }).text, /main/);
});

test("LUT, all 15 adjust sliders and keyframe easing (CapCut 9.5.0 UI diff session 3)", () => {
  mk("Lut");
  clip("Lut", 0, 6);
  const cube = join(MEDIA, "warm.cube");
  writeFileSync(cube, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  let r = call("capcut_set_clip", { draft: "Lut", track: "main", start_s: 0, lut: { path: cube, intensity: 50 }, dry_run: false });
  r2(r); assert.match(r.data.lut_warning, /Resources\/Lut/);
  let d = draft("Lut"), s = d.tracks[0].segments[0];
  const lut = d.materials.effects.find((e: any) => e.type === "lut");
  assert.deepEqual([lut.name, lut.value, lut.resource_id, lut.path.split(";")[0], s.enable_lut], ["warm.cube", 0.5, "7501974767453474064", cube, true]);
  assert.ok(s.extra_material_refs.includes(lut.id));
  assert.match(call("capcut_set_clip", { draft: "Lut", track: "main", start_s: 0, lut: { path: join(MEDIA, "clip.mp4") } }).text, /cube/);
  r2(call("capcut_set_clip", { draft: "Lut", track: "main", start_s: 0, lut: null, dry_run: false }));
  assert.equal(draft("Lut").materials.effects.filter((e: any) => e.type === "lut").length, 0);

  r2(call("capcut_add_adjustment_layer", { draft: "Lut", start_s: 0, duration_s: 3, lut: { path: cube },
    adjust: { tint: 10, contrast: 11, highlights: 12, whites: 14, brilliance: 16, sharpen: 21, clarity: 22, grain: 23, fade: 24, vignette: 25 }, dry_run: false }));
  d = draft("Lut");
  const as = d.tracks.find((t: any) => t.type === "adjust").segments[0];
  const got = Object.fromEntries(d.materials.effects.filter((e: any) => as.extra_material_refs.includes(e.id)).map((e: any) => [e.type, e.value]));
  assert.deepEqual(got, { tone: 0.2, contrast: 0.22, highlight: 0.24, white: 0.28, light_sensation: 0.32, sharpen: 0.21, clear: 0.22, particle: 0.23, fade: 0.24, vignetting: 0.5, lut: 1 });
  assert.match(call("capcut_add_adjustment_layer", { draft: "Lut", start_s: 4, adjust: { grain: -5 } }).text, /grain/);

  const kf = { draft: "Lut", track: "main", start_s: 0, property: "position_x", points: [{ t_s: 0.8, value: 0 }, { t_s: 4.766667, value: 0.15625 }] };
  r2(call("capcut_add_keyframes", { ...kf, ease: "in_out", dry_run: false }));
  d = draft("Lut");
  const [a, b] = d.tracks[0].segments[0].common_keyframes[0].keyframe_list;
  assert.deepEqual([a.curveType, a.right_control.x, b.left_control.x, a.graphID], ["FreeCurveInOut", 1666000, -1666000, ""]);
  assert.deepEqual(d.keyframe_graph_list.map((g: any) => [g.id, g.resource_id]), [[b.graphID, "7418178875479298577"]]);
  r2(call("capcut_add_keyframes", { ...kf, ease: "in", dry_run: false }));
  d = draft("Lut");
  const [c, e] = d.tracks[0].segments[0].common_keyframes[0].keyframe_list;
  assert.deepEqual([c.right_control.x, e.left_control.x, d.keyframe_graph_list.length], [1666000, 0, 1], "old graph entry dropped");
  assert.match(call("capcut_add_keyframes", { ...kf, ease: "bounce" }).text, /ease/);
});

test("style_text wordart: texture fill, effectStyle and text_effect from the cached effectStyle.json (CapCut 9.5.0 UI diff sessions 2/4)", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/capcut-9.5.0-ui-diff.json", import.meta.url), "utf8"));
  const ud = join(tmp, "User Data"), root = join(ud, "Projects", "com.lveditor.draft"), id = "7678508573365751057";
  const folder = join(ud, "Cache", "effect", id, "90abc020602bfaca99adff9dca09d36f");
  mkdirSync(root, { recursive: true }); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "effectStyle.json"), JSON.stringify({ fill: fx.wordart_effect_style_fill.fill }));
  process.env.CAPCUT_DRAFTS_ROOT = root;
  try {
    mk("Art");
    r2(call("capcut_add_subtitles", { draft: "Art", srt_text: SRT, dry_run: false }));
    const before = readFileSync(join(root, "Art", "draft_content.json"), "utf8");
    const dry = call("capcut_style_text", { draft: "Art", track: "subtitles", wordart: id });
    assert.equal(dry.data?.dry_run, true, dry.text);
    assert.equal(readFileSync(join(root, "Art", "draft_content.json"), "utf8"), before, "dry-run writes nothing");
    r2(call("capcut_style_text", { draft: "Art", track: "subtitles", wordart: id, dry_run: false }));
    r2(call("capcut_style_text", { draft: "Art", track: "subtitles", wordart: id, dry_run: false })); // re-apply replaces, no duplicates
    const art = () => JSON.parse(readFileSync(join(root, "Art", "draft_content.json"), "utf8"));
    let d = art();
    const want = fx.wordart_text_style.style, abs = (p: string) => p.replace("$USER_DATA", ud);
    const effects = d.materials.effects.filter((x: any) => x.type === "text_effect" && x.effect_id === id);
    assert.equal(effects.length, 2, "one text_effect per cue");
    assert.deepEqual(effects.map((x: any) => [x.resource_id, x.path, x.value, x.sub_type]), Array(2).fill([id, abs(fx.text_effect_wordart[0].path), 1, "none"]));
    for (const s of d.tracks.find((t: any) => t.name === "subtitles").segments) {
      assert.equal(s.extra_material_refs.filter((r: string) => effects.some((e: any) => e.id === r)).length, 1);
      const m = d.materials.texts.find((x: any) => x.id === s.material_id), st = JSON.parse(m.content).styles[0];
      assert.equal(m.use_effect_default_color, true);
      assert.deepEqual(st.effectStyle, { path: abs(want.effectStyle.path), id });
      const tex = st.fill.content.texture;
      assert.deepEqual([st.fill.content.render_type, tex.range, tex.path], ["texture", want.fill.content.texture.range, abs(want.fill.content.texture.path)]);
      assert.ok(Math.abs(tex.scale - want.fill.content.texture.scale) < 1e-6);
    }
    r2(call("capcut_style_text", { draft: "Art", track: "subtitles", wordart: null, dry_run: false }));
    d = art();
    assert.equal(d.materials.effects.filter((x: any) => x.type === "text_effect" && x.effect_id === id).length, 0, "Restablecer removes the material and refs");
    assert.equal(JSON.parse(d.materials.texts[0].content).styles[0].effectStyle, undefined);
    assert.match(call("capcut_style_text", { draft: "Art", track: "subtitles", wordart: "7000000000000000001" }).text, /not in the local CapCut cache/);
    assert.match(call("capcut_style_text", { draft: "Art", track: "subtitles", wordart: id, stroke_width: 40 }).text, /stroke/);
  } finally { process.env.CAPCUT_DRAFTS_ROOT = ROOT; }
});

test("speed curve: CapCut average = 1 / sum(dx / mean(y)) for every UI-diff sample; presets, custom points, null; dry-run first", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/capcut-9.5.0-ui-diff.json", import.meta.url), "utf8"));
  for (const c of fx.speed_curves) {
    const v = curveAverage(c.points);
    assert.ok(Math.abs(c.step.startsWith("session1") ? c.source_us / c.target_us - c.speed : v - c.speed) < 2e-6, `${c.step}: ${v} vs ${c.speed}`);
    assert.equal(Math.round((c.source_us / 1e6 / v) * 30) / 30 * 1e6 | 0, Math.round(c.target_us / (1e6 / 30)) * (1e6 / 30) | 0, `${c.step}: frame-snapped target`);
  }
  mk("Curve");
  r2(clip("Curve", 0, 8));
  r2(clip("Curve", 20, 2));
  const len = () => draft("Curve").tracks[0].segments[0].target_timerange.duration;
  assert.equal(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, curve: "montage" }).data.dry_run, true);
  assert.equal(len(), 8_000_000, "dry-run writes nothing");
  const want = Object.fromEntries(fx.speed_curves.filter((c: any) => c.source_us === 8_000_000).map((c: any) => [c.step, c]));
  for (const [curve, step] of [["montage", "montaje"], ["hero", "heroe"], ["bullet", "bala"], ["jump_cut", "corte"], ["flash_in", "flashin"], ["flash_out", "flashout"]]) {
    r2(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, curve, dry_run: false }));
    const d = draft("Curve"), s = d.tracks[0].segments[0], sp = d.materials.speeds.find((x: any) => s.extra_material_refs.includes(x.id));
    assert.equal(s.target_timerange.duration, want[step].target_us, curve);
    assert.deepEqual([sp.mode, sp.curve_speed.id, sp.curve_speed.name, sp.curve_speed.speed_points.map((p: any) => [p.x, p.y])], [1, want[step].id, want[step].name, want[step].points]);
    assert.ok(Math.abs(sp.speed - want[step].speed) < 2e-6 && sp.speed === s.speed);
  }
  r2(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, points: want["141b"].points, dry_run: false }));
  assert.equal(len(), 5_600_000, "custom 1-1-4-1-1 -> 1.4286x");
  assert.equal(draft("Curve").materials.speeds.filter((x: any) => x.curve_speed).length, 1, "one speed material per clip");
  r2(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, curve: null, dry_run: false }));
  const d = draft("Curve"), sp = d.materials.speeds.find((x: any) => d.tracks[0].segments[0].extra_material_refs.includes(x.id));
  assert.deepEqual([len(), sp.mode, sp.curve_speed, sp.speed], [8_000_000, 0, null, 1]);
  assert.match(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, points: [[0, 0.3], [1, 0.3]] }).text, /Overlaps/, "26.7 s would cover the clip at 20 s");
  assert.match(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, points: [[0, 1], [0.5, 20], [1, 1]] }).text, /0.1-10/);
  assert.match(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, points: [[0, 1], [0.7, 1], [0.6, 1], [1, 1]] }).text, /increase/);
  assert.match(call("capcut_set_speed_curve", { draft: "Curve", start_s: 0, curve: "warp" }).text, /curve must be/);
});

test("feature map: summary counts match the rows; every impossible row says why", () => {
  const j = JSON.parse(readFileSync(new URL("../docs/capcut_features.json", import.meta.url), "utf8"));
  const ins = j.features.filter((f: any) => f.status !== "out_of_scope"), c: Record<string, number> = { yes: 0, partial: 0, no: 0, impossible: 0 };
  for (const f of ins) { assert.ok(f.mcp_support in c, f.name); c[f.mcp_support]++; if (f.mcp_support === "impossible") assert.ok(f.impossible_reason, f.name); }
  assert.deepEqual(j.summary.mcp_support, c);
  assert.equal(j.summary.unknown, c.no);
  assert.equal(j.summary.in_scope, ins.length);
});

test("set_clip: flip, crop, curves (reproduces the CapCut-saved handles), color wheels, HSL red", () => {
  r2(mk("Grade")); r2(clip("Grade", 0, 4));
  const fx = JSON.parse(readFileSync(new URL("./fixtures/capcut-9.5.0-ui-diff.json", import.meta.url), "utf8")).color_curves_luma.luma;
  const got = curveHandles(fx.map((p: any) => [p.anchor.x, p.anchor.y]));
  got.forEach((p: any, i: number) => for_each_close(p, fx[i]));
  const before = JSON.stringify(draft("Grade"));
  const args = { draft: "Grade", track: "main", start_s: 0, flip: { horizontal: true }, crop: { left: 0.1, bottom: 0.2 },
    curves: { luma: [[0, 0], [0.58, 0.73], [1, 1]] }, color_wheels: { lift: { red: 0.03, blue: 0.06 }, intensity: 1 }, hsl: { red: { hue: -100, saturation: 100 } } };
  r2(call("capcut_set_clip", args)); assert.equal(JSON.stringify(draft("Grade")), before); // dry-run writes nothing
  r2(call("capcut_set_clip", { ...args, dry_run: false }));
  const d = draft("Grade"), s = d.tracks[0].segments[0], v = d.materials.videos[0];
  assert.deepEqual(s.clip.flip, { horizontal: true, vertical: false });
  assert.deepEqual([v.crop.upper_left_x, v.crop.upper_left_y, v.crop.lower_right_x, v.crop.lower_right_y], [0.1, 0, 1, 0.8]);
  const cc = d.materials.color_curves[0], cw = d.materials.primary_color_wheels[0], h = d.materials.hsl[0];
  assert.ok([cc.id, cw.id, h.id].every((id) => s.extra_material_refs.includes(id)));
  assert.deepEqual([cc.luma.length, cc.red.length, cc.panel], [3, 0, "adjust_collection"]);
  assert.deepEqual([cw.lift.red, cw.lift.blue, cw.gain.red, cw.intensity], [0.03, 0.06, 0, 1]);
  assert.deepEqual([h.hsl_color_type, h.hue, h.saturation, h.lightness, h.custom_color], [1, -100, 100, 0, "#FFE64444"]);
  assert.deepEqual([s.enable_hsl, s.enable_color_curves, s.enable_color_wheels], [true, true, true]);
  r2(call("capcut_set_clip", { draft: "Grade", track: "main", start_s: 0, curves: null, color_wheels: null, hsl: { red: null }, crop: null, dry_run: false }));
  const e = draft("Grade");
  assert.deepEqual([e.materials.color_curves.length, e.materials.primary_color_wheels.length, e.materials.hsl.length, e.materials.videos[0].crop.lower_right_y], [0, 0, 0, 1]);
  assert.match(call("capcut_set_clip", { draft: "Grade", track: "main", start_s: 0, hsl: { teal: { hue: 10 } } }).text, /must be one of/);
  r2(call("capcut_set_clip", { draft: "Grade", track: "main", start_s: 0, hsl: { orange: { hue: 11 }, magenta: { lightness: -5 } }, dry_run: false }));
  const hs = draft("Grade").materials.hsl;
  assert.deepEqual(hs.map((h: any) => [h.hsl_color_type, h.custom_color, h.hue, h.lightness]), [[2, "#FFE69444", 11, 0], [8, "#FFE644E6", 0, -5]]);
  assert.match(call("capcut_set_clip", { draft: "Grade", track: "main", start_s: 0, curves: { luma: [[0.5, 0], [0.2, 1]] } }).text, /ascend/);
  assert.match(call("capcut_set_clip", { draft: "Grade", track: "main", start_s: 0, crop: { left: 0.6, right: 0.5 } }).text, /nothing/);
});
function for_each_close(a: any, b: any) {
  for (const k of ["anchor", "left_control", "right_control"]) for (const c of ["x", "y"]) assert.ok(Math.abs(a[k][c] - b[k][c]) < 1e-6, `${k}.${c} ${a[k][c]} vs ${b[k][c]}`);
}

test("add_sticker on a sticker track (+ sticker animation); set_clip voice_filter on audio and video clips", () => {
  r2(mk("Stk")); r2(clip("Stk", 0, 5));
  const before = JSON.stringify(draft("Stk"));
  let r = call("capcut_add_sticker", { draft: "Stk", resource_id: "7233770810731810053", start_s: 1, duration_s: 2, x: 0.5, y: 0.4, scale: 0.6 });
  r2(r); assert.equal(JSON.stringify(draft("Stk")), before); assert.match(r.data.warning, /artistEffect/);
  r2(call("capcut_add_sticker", { draft: "Stk", resource_id: "7233770810731810053", start_s: 1, duration_s: 2, x: 0.5, y: 0.4, scale: 0.6, dry_run: false }));
  r2(call("capcut_add_animation", { draft: "Stk", track: "stickers", start_s: 1, kind: "in", resource_id: "7598471787764141329", dry_run: false }));
  let d = draft("Stk");
  const t = d.tracks.find((x: any) => x.type === "sticker"), s = t.segments[0], m = d.materials.stickers[0];
  assert.deepEqual([t.name, s.render_index, s.material_id, m.sticker_id, m.type, s.clip.scale.x, s.clip.transform.x, s.target_timerange.duration], ["stickers", 14001, m.id, "7233770810731810053", "sticker", 0.6, 0.5, 2000000]);
  assert.equal(d.materials.material_animations.find((x: any) => s.extra_material_refs.includes(x.id)).animations[0].material_type, "sticker");
  call("capcut_add_audio", { draft: "Stk", path: join(MEDIA, "song.mp3"), media_duration_s: 30, start_s: 0, duration_s: 4, track: "music", dry_run: false });
  r2(call("capcut_set_clip", { draft: "Stk", track: "music", start_s: 0, voice_filter: { resource_id: "7495602511638842625", name: "Voz llena", strength: 0.7 }, dry_run: false }));
  r2(call("capcut_set_clip", { draft: "Stk", track: "main", start_s: 0, voice_filter: { resource_id: "7320193577613529602", name: "Dulce" }, dry_run: false }));
  d = draft("Stk");
  const [ea, ev] = d.materials.audio_effects;
  assert.deepEqual([ea.third_resource_id, ea.audio_adjust_params[0].value, ea.category_id, ev.third_resource_id], ["0", 0.7, "sound_effect", "7320193577613529602"]);
  assert.ok(d.materials.audios[0].check_flag & 2); assert.ok(d.materials.videos[0].check_flag & 2048);
  r2(call("capcut_set_clip", { draft: "Stk", track: "music", start_s: 0, voice_filter: null, dry_run: false }));
  assert.equal(draft("Stk").materials.audio_effects.length, 1);
});

test("style_text bubble: text_shape effect with third_resource_id, replace and remove", () => {
  r2(mk("Bub")); r2(call("capcut_add_text", { draft: "Bub", text: "hola", start_s: 0, duration_s: 2, track: "t", dry_run: false }));
  const b = { resource_id: "7446995323060227333", third_resource_id: "6844049416047825415" };
  const before = JSON.stringify(draft("Bub"));
  let r = call("capcut_style_text", { draft: "Bub", track: "t", bubble: b }); r2(r); assert.equal(JSON.stringify(draft("Bub")), before); assert.match(r.data.warning, /cache/);
  r2(call("capcut_style_text", { draft: "Bub", track: "t", bubble: b, dry_run: false }));
  r2(call("capcut_style_text", { draft: "Bub", track: "t", bubble: { resource_id: "7446994129516596485", third_resource_id: "6844049416047825415" }, dry_run: false }));
  let d = draft("Bub"), s = d.tracks[0].segments[0], e = d.materials.effects.filter((x: any) => x.type === "text_shape");
  assert.equal(e.length, 1); assert.ok(s.extra_material_refs.includes(e[0].id));
  assert.deepEqual([e[0].resource_id, e[0].third_resource_id, e[0].sub_type, e[0].category_id], ["7446994129516596485", "6844049416047825415", "manual_stretch", "bubble"]);
  r2(call("capcut_style_text", { draft: "Bub", track: "t", bubble: null, dry_run: false }));
  assert.equal(draft("Bub").materials.effects.filter((x: any) => x.type === "text_shape").length, 0);
  assert.match(call("capcut_style_text", { draft: "Bub", track: "t", bubble: { resource_id: "7446995323060227333" } }).text, /third_resource_id/);
});

test("style_text: underline, letter/line spacing (x0.05), text glow (bloom, check_flag 64)", () => {
  r2(mk("Glow")); r2(call("capcut_add_text", { draft: "Glow", text: "hola", start_s: 0, duration_s: 2, track: "t", dry_run: false }));
  r2(call("capcut_style_text", { draft: "Glow", track: "t", underline: true, letter_spacing: 5, line_spacing: 8, glow: { style: "neon", color: "#FF0000", strength: 70 }, dry_run: false }));
  let d = draft("Glow"), m = d.materials.texts[0], c = JSON.parse(m.content), s = d.tracks[0].segments[0];
  const g = d.materials.effects.find((e: any) => e.type === "bloom");
  assert.deepEqual([m.underline, c.styles[0].underline, m.letter_spacing, m.line_spacing, !!(m.check_flag & 64)], [true, true, 0.25, 0.4, true]);
  assert.deepEqual([g.resource_id, g.panel_id, g.bloom_params.color, g.bloom_params.strength, g.bloom_params.range, s.extra_material_refs.includes(g.id)], ["7194814295517958657", "text_glow", "#FF0000", 0.7, 0.4, true]);
  r2(call("capcut_style_text", { draft: "Glow", track: "t", glow: null, letter_spacing: -3, dry_run: false }));
  d = draft("Glow"); m = d.materials.texts[0];
  assert.deepEqual([d.materials.effects.filter((e: any) => e.type === "bloom").length, !!(m.check_flag & 64), m.letter_spacing], [0, false, -0.15]);
  assert.match(call("capcut_style_text", { draft: "Glow", track: "t", glow: { style: "fire" } }).text, /neon/);
});

test("compound_clip: segments move into materials.drafts[combination] + subdraft files (CapCut 9.5.0 shape)", () => {
  mk("Comp");
  clip("Comp", 0, 2); clip("Comp", 2, 2); clip("Comp", 4, 2);
  assert.equal(call("capcut_compound_clip", { draft: "Comp", track: "main", start_s: 2, end_s: 6 }).data.dry_run, true);
  assert.equal(call("capcut_compound_clip", { draft: "Comp", track: "main", start_s: 7, end_s: 8, dry_run: false }).isError, true);
  const r = call("capcut_compound_clip", { draft: "Comp", track: "main", start_s: 2, end_s: 6, dry_run: false });
  assert.equal(r.data.segments_grouped, 2, r.text);
  const d = draft("Comp"), segs = d.tracks[0].segments;
  assert.equal(segs.length, 2);
  const m = d.materials.videos.find((v: any) => v.id === segs[1].material_id);
  assert.deepEqual([m.path, m.extra_type_option, m.material_name], ["", 2, "Clip combinado1"]);
  const c = d.materials.drafts.find((x: any) => x.id === segs[1].extra_material_refs[0]);
  assert.equal(c.type, "combination");
  assert.equal(c.draft.tracks[0].segments.length, 2);
  assert.equal(c.draft.tracks[0].segments[0].target_timerange.start, 0);
  assert.equal(c.draft.duration, 4_000_000);
  assert.equal(c.draft.materials.videos.length, 2);
  assert.equal(d.materials.videos.length, 2, "grouped media leave the main list");
  assert.ok(existsSync(c.draft_file_path) && existsSync(c.draft_config_path));
  assert.deepEqual(JSON.parse(readFileSync(c.draft_file_path, "utf8")).id, c.draft.id);
  assert.equal(d.config.combination_max_index, 1);
});

test("insert_preset: a saved element becomes a compound clip named '<name>##<id>' with its own subdraft (CapCut 9.5.0 UI diff)", () => {
  const PR = join(tmp, "presets"), pd = join(PR, "Presets", "Mi preset", "preset_draft");
  mkdirSync(pd, { recursive: true });
  process.env.CAPCUT_PRESETS_ROOT = PR;
  const src = draft("Comp"), seg = structuredClone(src.tracks[0].segments[1]);
  seg.target_timerange.start = 0;
  const p = { ...src, tracks: [{ ...src.tracks[0], segments: [seg] }] };
  p.materials.drafts[0].draft.materials.videos[0].path = "##_presetpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##/Resources/x.mp4";
  writeFileSync(join(pd, "draft_content.json"), JSON.stringify(p));
  writeFileSync(join(PR, "Presets", "Mi preset", "Mi preset.json"), JSON.stringify({ id: "243AF3B4-C6EF-4CEC-A477-045B060F933E", name: "Mi preset" }));
  mk("Pre"); clip("Pre", 0, 2);
  assert.match(call("capcut_insert_preset", { draft: "Pre", preset: "Nope", start_s: 2, dry_run: false }).text, /Available: Mi preset/);
  assert.match(call("capcut_insert_preset", { draft: "Pre", preset: "Mi preset", start_s: 1, dry_run: false }).text, /Overlaps/);
  const r = call("capcut_insert_preset", { draft: "Pre", preset: "Mi preset", start_s: 2, dry_run: false });
  assert.equal(r.data.duration_s, 4, r.text);
  const d = draft("Pre"), s = d.tracks[0].segments[1];
  const m = d.materials.videos.find((v: any) => v.id === s.material_id);
  assert.deepEqual([m.material_name, m.extra_type_option, s.target_timerange.start], ["Mi preset##243AF3B4-C6EF-4CEC-A477-045B060F933E", 2, 2_000_000]);
  const c = d.materials.drafts.find((x: any) => x.id === s.extra_material_refs[0]);
  assert.notEqual(c.draft.id, src.materials.drafts[0].draft.id);
  assert.equal(c.draft.materials.videos[0].path, join(PR, "Resources", "x.mp4"));
  assert.ok(existsSync(c.draft_file_path) && c.draft_file_path.startsWith(join(ROOT, "Pre", "subdraft")));
  delete process.env.CAPCUT_PRESETS_ROOT;
});

test("copy_text_template: template + its texts/effects get fresh ids, new time and new text", () => {
  mk("TT");
  const f = join(ROOT, "TT", "draft_content.json"), d0 = draft("TT");
  d0.materials.texts = [{ id: "T1", type: "text", content: JSON.stringify({ text: "BAM!", styles: [{ range: [0, 4], size: 10 }] }) }];
  d0.materials.effects = [{ id: "E1", type: "text_effect", effect_id: "" }];
  d0.materials.material_animations = [{ id: "A1", type: "sticker_animation", animations: [] }];
  d0.materials.text_templates = [{ id: "TPL", type: "text_template", name: "Readable EN BAM!", resource_id: "7599479427805793544",
    text_info_resources: [{ id: "R1", text_material_id: "T1", extra_material_refs: ["E1"], attach_info: { start_time: 0, duration: 1599987 } }], non_text_info_resources: [] }];
  d0.tracks.push({ id: "TR", type: "text", name: "text", segments: [{ id: "S1", material_id: "TPL", extra_material_refs: ["A1", "E1"], target_timerange: { start: 1_000_000, duration: 1_600_000 }, source_timerange: null }] });
  d0.duration = 2_600_000;
  writeFileSync(f, JSON.stringify(d0));
  assert.match(call("capcut_copy_text_template", { draft: "TT", from_start_s: 5, start_s: 3, dry_run: false }).text, /No text template/);
  const r = call("capcut_copy_text_template", { draft: "TT", from_start_s: 1, start_s: 3, text: "WOW", dry_run: false });
  assert.equal(r.data.materials_copied, 3, r.text);
  const d = draft("TT"), t2 = d.materials.text_templates[1], s = d.tracks.find((t: any) => t.name === "text_templates").segments[0];
  assert.equal(s.material_id, t2.id);
  assert.notEqual(t2.id, "TPL");
  assert.equal(s.target_timerange.start, 3_000_000);
  const tx = d.materials.texts.find((x: any) => x.id === t2.text_info_resources[0].text_material_id);
  assert.deepEqual(JSON.parse(tx.content), { text: "WOW", styles: [{ range: [0, 3], size: 10 }] });
  assert.ok(d.materials.effects.some((e: any) => e.id === t2.text_info_resources[0].extra_material_refs[0] && e.id !== "E1"));
  assert.equal(d.materials.texts.length, 2);
});

// ---------- editing gaps: SRT re-chunking, batch cuts + SRT remap, remove_segment, make_short parity ----------
const onGrid = (us: number, fps: number) => us === Math.round(Math.round(us * fps / 1e6) * (1e6 / fps));
const mkFps = (name: string, fps: number) => r2(call("capcut_create_draft", { name, fps, template_draft: "none", dry_run: false }));
const segs = (d: any, type: string, name: string) => d.tracks.find((t: any) => t.type === type && t.name === name).segments
  .map((s: any) => [s.target_timerange.start, s.target_timerange.duration, s.source_timerange.start]);

test("chunkCues: max words / chars, time by chars or words, boundaries on the 30 and 60 fps grid, upper, punch words alone", () => {
  const cue = [{ start: 1, end: 3, text: "esto es\nmuy importante hoy" }];
  for (const fps of [30, 60]) {
    const c = chunkCues(cue, { maxWords: 2 }, fps);
    assert.deepEqual(c.map((x) => x.text), ["esto es", "muy importante", "hoy"]);
    assert.equal(c[0].start, 1); assert.equal(c[2].end, 3);
    for (let i = 0; i < c.length; i++) {
      assert.ok(Number.isInteger(Math.round(c[i].start * fps * 1e6) / 1e6), "start on the frame grid");
      if (i) assert.equal(c[i].start, c[i - 1].end, "back to back");
    }
    // by chars: 6 + 13 + 3 = 22 letters over 2 s -> first card ~0.545 s; by words: 2/5 of 2 s = 0.8 s
    assert.equal(c[0].end, Math.round((1 + 2 * 6 / 22) * fps) / fps);
    assert.equal(chunkCues(cue, { maxWords: 2, by: "words" }, fps)[0].end, Math.round(1.8 * fps) / fps);
  }
  assert.deepEqual(chunkCues(cue, { maxChars: 10 }, 30).map((x) => x.text), ["esto es", "muy", "importante", "hoy"]);
  assert.deepEqual(chunkCues(cue, { maxWords: 3, upper: true, punch: ["Importante"] }, 30).map((x) => x.text), ["ESTO ES MUY", "IMPORTANTE", "HOY"]);
  assert.deepEqual(chunkCues([{ start: 0, end: 0.05, text: "a b c d" }], { maxWords: 1 }, 30).map((x) => x.text), ["a b c d"], "too short for one frame per card: kept whole");
});

test("add_subtitles max_words/upper at 60 fps: cards back to back on the 1/60 s grid; dry-run first", () => {
  mkFps("Chunk60", 60);
  const args = { draft: "Chunk60", srt_text: SRT, max_words: 2, upper: true, punch_words: ["mira"] };
  const dry = call("capcut_add_subtitles", args);
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(dry.data.cues, 4); assert.equal(dry.data.source_cues, 2);
  r2(call("capcut_add_subtitles", { ...args, dry_run: false }));
  const d = draft("Chunk60"), s = segs(d, "text", "subtitles");
  assert.deepEqual(texts(d, "subtitles").map((m: any) => JSON.parse(m.content).text), ["QUE TAL", "MIRA", "ESTO TAL", "CUAL"]);
  for (let i = 0; i < s.length; i++) { assert.ok(onGrid(s[i][0], 60) && onGrid(s[i][0] + s[i][1], 60)); if (i) assert.equal(s[i][0], s[i - 1][0] + s[i - 1][1]); }
  assert.equal(s[3][0] + s[3][1], 3_000_000);
  assert.match(call("capcut_add_subtitles", { draft: "Chunk60", srt_text: SRT, split_by: "syllables" }).text, /split_by/);
  mkFps("Gap60", 60);
  r2(call("capcut_add_subtitles", { draft: "Gap60", srt_text: SRT, max_words: 1, min_gap_s: 0.1, dry_run: false }));
  const g = segs(draft("Gap60"), "text", "subtitles");
  assert.equal(g.length, 6);
  for (let i = 1; i < g.length; i++) { assert.ok(g[i][0] - (g[i - 1][0] + g[i - 1][1]) >= 100_000, `gap before card ${i}`); assert.ok(onGrid(g[i - 1][0] + g[i - 1][1], 60)); }
});

test("remapCues: shift through the time map, merge a cue across a cut, drop cues inside cuts or under one frame", () => {
  const map = [{ in_s: 2, out_s: 4, at_s: 0 }, { in_s: 6, out_s: 8, at_s: 2 }];
  const r = remapCues([{ start: 2.5, end: 3, text: "a" }, { start: 3.5, end: 6.5, text: "b" }, { start: 4.2, end: 5.8, text: "cut" }, { start: 7.99, end: 9, text: "sliver" }], map, 30);
  assert.deepEqual(r.cues, [{ start: 0.5, end: 1, text: "a" }, { start: 1.5, end: 2.5, text: "b" }]);
  assert.equal(r.dropped, 2);
});

for (const fps of [30, 60]) test(`add_cuts at ${fps} fps: keep ranges back to back, cut = complement, SRT remapped, dry-run first`, () => {
  const name = `Cuts${fps}`;
  mkFps(name, fps);
  const srt = "1\n00:00:02,500 --> 00:00:03,000\nuno\n\n2\n00:00:03,500 --> 00:00:06,500\ndos cruza\n\n3\n00:00:04,200 --> 00:00:05,800\ncortado\n";
  const base = { draft: name, path: join(MEDIA, "clip.mp4"), media_duration_s: 10 };
  const dry = call("capcut_add_cuts", { ...base, keep: [[2, 4], [6, 8.01]], srt_text: srt });
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.deepEqual(dry.data.time_map.map((m: any) => m.at_s), [0, 2]);
  assert.equal(dry.data.subtitles.cues, 2); assert.equal(dry.data.subtitles.dropped_in_cuts, 1);
  assert.equal(draft(name).tracks.length, 0, "dry-run wrote nothing");
  r2(call("capcut_add_cuts", { ...base, keep: [[2, 4], [6, 8.01]], srt_text: srt, dry_run: false }));
  const d = draft(name), v = segs(d, "video", "main"), f = 1e6 / fps;
  assert.equal(v.length, 2);
  assert.deepEqual(v[0], [0, 2_000_000, 2_000_000]);
  assert.equal(v[1][0], 2_000_000); assert.equal(v[1][2], 6_000_000);
  assert.equal(v[1][1], Math.round(Math.round(2.01 * fps) * f), "out snapped to the frame grid");
  for (const [s, du] of v) assert.ok(onGrid(s, fps) && onGrid(s + du, fps));
  assert.deepEqual(segs(d, "text", "subtitles").map((x: any) => [x[0], x[1]]), [[500_000, 500_000], [1_500_000, 1_000_000]]);
  assert.equal(d.materials.videos.length, 2, "one material per segment, one copied file");
  const c = call("capcut_add_cuts", { ...base, cut: [[0, 2], [4, 6], [8, 10]], track: "b", start_s: 10 });
  assert.deepEqual(c.data.time_map, [{ in_s: 2, out_s: 4, at_s: 10 }, { in_s: 6, out_s: 8, at_s: 12 }]);
  assert.match(call("capcut_add_cuts", { ...base, keep: [[2, 4], [3, 5]] }).text, /overlap|ascending/);
  assert.match(call("capcut_add_cuts", { ...base, keep: [[2, 4]], cut: [[0, 1]] }).text, /exactly one/);
});

test("remove_segment: removes clip + orphan materials; ripple closes the gap on that track only; dry-run first", () => {
  mkFps("Rm", 60);
  for (const [s, du] of [[0, 2], [2, 1.5], [3.5, 2]]) clip("Rm", s, du);
  r2(call("capcut_add_subtitles", { draft: "Rm", srt_text: "1\n00:00:04,000 --> 00:00:05,000\nhola\n", dry_run: false }));
  const dry = call("capcut_remove_segment", { draft: "Rm", track: "main", start_s: 2, ripple: true });
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(segs(draft("Rm"), "video", "main").length, 3);
  const r = call("capcut_remove_segment", { draft: "Rm", track: "main", start_s: 2, ripple: true, dry_run: false });
  r2(r);
  assert.equal(r.data.segments_moved, 1);
  const d = draft("Rm");
  assert.deepEqual(segs(d, "video", "main").map((x: any) => [x[0], x[1]]), [[0, 2_000_000], [2_000_000, 2_000_000]]);
  assert.deepEqual(segs(d, "text", "subtitles").map((x: any) => x[0]), [4_000_000], "other tracks do not move");
  assert.equal(d.materials.videos.length, 2, "orphan video material removed");
  assert.equal(d.materials.speeds.length, 2 + 1, "2 clips + 1 subtitle keep their companions");
  assert.equal(d.duration, 5_000_000);
  r2(call("capcut_remove_segment", { draft: "Rm", track: "main", start_s: 0, dry_run: false }));
  assert.deepEqual(segs(draft("Rm"), "video", "main").map((x: any) => x[0]), [2_000_000], "no ripple: gap stays");
  assert.match(call("capcut_remove_segment", { draft: "Rm", track: "main", start_s: 9 }).text, /No segment/);
});

test("make_short parity: sub_* style, title_y/title_color, chunking and separate music fades", () => {
  mkFps("PShort", 60);
  const r = call("capcut_make_short", { draft: "PShort", clip_path: join(MEDIA, "clip.mp4"), clip_media_duration_s: 4, srt_text: SRT, max_words: 2, upper: true,
    sub_font_size: 12, sub_color: "#FF5C00", sub_y: -0.2, title: "hook", title_y: 0.7, title_color: "#FFD400",
    music_path: join(MEDIA, "song.mp3"), music_media_duration_s: 30, music_fade_in_s: 0, music_fade_out_s: 1.5, dry_run: false });
  r2(r);
  const d = draft("PShort");
  const sub = texts(d, "subtitles");
  assert.deepEqual(sub.map((m: any) => JSON.parse(m.content).text), ["QUE TAL", "MIRA ESTO", "TAL CUAL"]);
  assert.deepEqual([sub[0].font_size, sub[0].text_color], [12, "#FF5C00"]);
  assert.equal(d.tracks.find((t: any) => t.name === "subtitles").segments[0].clip.transform.y, -0.2);
  const title = d.tracks.find((t: any) => t.name === "text").segments[0];
  assert.equal(title.clip.transform.y, 0.7); assert.equal(texts(d, "text")[0].text_color, "#FFD400");
  assert.deepEqual([d.materials.audio_fades[0].fade_in_duration, d.materials.audio_fades[0].fade_out_duration], [0, 1_500_000]);
});

test("add_subtitles x: horizontal position like add_text; default stays centred", () => {
  mkFps("SubX", 30);
  const dry = call("capcut_add_subtitles", { draft: "SubX", srt_text: SRT, x: 0.25, y: -0.12 });
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(dry.data.x, 0.25);
  assert.equal(draft("SubX").tracks.length, 0);
  r2(call("capcut_add_subtitles", { draft: "SubX", srt_text: SRT, x: 0.25, y: -0.12, dry_run: false }));
  const segs = draft("SubX").tracks.find((t: any) => t.name === "subtitles").segments;
  assert.ok(segs.length >= 1);
  for (const s of segs) assert.deepEqual(s.clip.transform, { x: 0.25, y: -0.12 });
  mkFps("SubX0", 60);
  r2(call("capcut_add_subtitles", { draft: "SubX0", srt_text: SRT, dry_run: false }));
  assert.equal(draft("SubX0").tracks.find((t: any) => t.name === "subtitles").segments[0].clip.transform.x, 0);
  assert.match(call("capcut_add_subtitles", { draft: "SubX", srt_text: SRT, x: 1.5 }).text, /x must be/);
});

for (const fps of [30, 60]) test(`add_clip fades at ${fps} fps: same audio_fades writer as set_clip, video copy on materials.videos[]`, () => {
  const name = `Fade${fps}`;
  mkFps(name, fps);
  const fin = Math.round(Math.round(0.016 * fps) * (1e6 / fps)); // 0 at 30 fps (under one frame), 1 frame at 60
  const dry = call("capcut_add_clip", { draft: name, path: join(MEDIA, "clip.mp4"), media_duration_s: 10, duration_s: 2, fade_in_s: 0.016, fade_out_s: 0.5 });
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(draft(name).tracks?.length ?? 0, 0);
  r2(call("capcut_add_clip", { draft: name, path: join(MEDIA, "clip.mp4"), media_duration_s: 10, duration_s: 2, fade_in_s: 0.016, fade_out_s: 0.5, dry_run: false }));
  const d = draft(name), s = d.tracks[0].segments[0];
  const [f] = d.materials.audio_fades.filter((x: any) => s.extra_material_refs.includes(x.id));
  assert.deepEqual([f.type, f.fade_type, f.fade_in_duration, f.fade_out_duration], ["audio_fade", 0, fin, 500_000]);
  assert.deepEqual(d.materials.videos.find((m: any) => m.id === s.material_id).audio_fade, f);
  r2(call("capcut_add_clip", { draft: name, path: join(MEDIA, "song.mp3"), media_duration_s: 30, duration_s: 2, start_s: 2, fade_in_s: 0.5, fade_out_s: 0.25, dry_run: false }));
  const d2 = draft(name), a = d2.tracks.find((t: any) => t.type === "audio").segments[0];
  const [af] = d2.materials.audio_fades.filter((x: any) => a.extra_material_refs.includes(x.id));
  const fout = Math.round(Math.round(0.25 * fps) * (1e6 / fps)); // 0.25 s is 8 frames at 30 fps, 15 at 60
  assert.deepEqual([af.fade_in_duration, af.fade_out_duration], [500_000, fout]);
  assert.equal(d2.materials.videos.find((m: any) => m.audio_fade && m.audio_fade.id === af.id), undefined, "audio clips do not copy audio_fade onto a video material");
  assert.match(call("capcut_add_clip", { draft: name, path: join(MEDIA, "clip.mp4"), media_duration_s: 10, start_s: 4, duration_s: 1, fade_in_s: 0.6, fade_out_s: 0.6 }).text, /longer than the clip/);
});

for (const fps of [30, 60]) test(`export_chapters at ${fps} fps: HH:MM:SS from frame-snapped markers, 00:00:00 inserted, optional chapters.txt`, () => {
  const name = `Ch${fps}`;
  mkFps(name, fps);
  assert.match(call("capcut_export_chapters", { draft: name }).text, /marker/i);
  // 10.988 s snaps to 11.0 s at 30 fps and to 10.983 s at 60 fps. The stamp is the second that contains that frame.
  r2(call("capcut_add_markers", { draft: name, markers: [{ t_s: 3661.2, title: "Hour" }, { t_s: 10.988, title: "Beat" }], dry_run: false }));
  r2(call("capcut_set_timeline", { draft: name, duration_s: 3671, dry_run: false }));
  const want = fps === 30
    ? "00:00:00 Start\n00:00:11 Beat\n01:01:01 Hour\n"
    : "00:00:00 Start\n00:00:10 Beat\n01:01:01 Hour\n";
  const dry = call("capcut_export_chapters", { draft: name, out_path: join(tmp, `chapters-${fps}.txt`) });
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(dry.data.text, want);
  assert.equal(dry.data.inserted_zero, true);
  assert.equal(existsSync(join(tmp, `chapters-${fps}.txt`)), false);
  const w = call("capcut_export_chapters", { draft: name, out_path: join(tmp, `chapters-${fps}.txt`), dry_run: false });
  r2(w);
  assert.equal(readFileSync(join(tmp, `chapters-${fps}.txt`), "utf8"), want);
  assert.match(call("capcut_export_chapters", { draft: name, out_path: join(tmp, `chapters-${fps}.txt`), dry_run: false }).text, /exists/);
  assert.match(call("capcut_export_chapters", { draft: name, out_path: "chapters.txt" }).text, /absolute/);
  const textOnly = call("capcut_export_chapters", { draft: name, zero_title: "Cold open" });
  assert.equal(textOnly.data.text, want.replace("Start", "Cold open"));
  assert.equal(textOnly.data.dry_run, undefined);
  mkFps(`Ch0${fps}`, fps);
  r2(call("capcut_add_markers", { draft: `Ch0${fps}`, markers: [{ t_s: 0, title: "Cold open" }, { t_s: 90.5, title: "Mid" }, { t_s: 180, title: "End" }], dry_run: false }));
  r2(call("capcut_set_timeline", { draft: `Ch0${fps}`, duration_s: 190, dry_run: false }));
  const atZero = call("capcut_export_chapters", { draft: `Ch0${fps}` });
  assert.equal(atZero.data.text, "00:00:00 Cold open\n00:01:30 Mid\n00:03:00 End\n");
  assert.equal(atZero.data.inserted_zero, false);
});

test("export_chapters rejects lists YouTube will not use", () => {
  const bad = (name: string, markers: object[], duration_s: number, pattern: RegExp) => {
    mkFps(name, 30);
    r2(call("capcut_add_markers", { draft: name, markers, dry_run: false }));
    r2(call("capcut_set_timeline", { draft: name, duration_s, dry_run: false }));
    const r = call("capcut_export_chapters", { draft: name, out_path: join(tmp, `${name}.txt`), dry_run: false });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, pattern);
    assert.equal(existsSync(join(tmp, `${name}.txt`)), false, "invalid list is not written");
  };
  bad("ChFew", [{ t_s: 0, title: "Open" }, { t_s: 20, title: "Mid" }], 40, /at least 3/);
  bad("ChGap", [{ t_s: 0, title: "Open" }, { t_s: 10, title: "Mid" }, { t_s: 15, title: "Late" }], 40, /10 seconds apart/);
  bad("ChSame", [{ t_s: 0, title: "Open" }, { t_s: 10.1, title: "A" }, { t_s: 10.8, title: "B" }, { t_s: 30, title: "End" }], 50, /00:00:10 and 00:00:10 are 0s apart/);
  bad("ChTail", [{ t_s: 0, title: "Open" }, { t_s: 10, title: "Mid" }, { t_s: 20, title: "End" }], 25, /last YouTube chapter/);
  const dry = call("capcut_export_chapters", { draft: "ChTail" });
  assert.equal(dry.isError, true);
  assert.match(dry.text, /last YouTube chapter/);
});

for (const fps of [30, 60]) test(`add_cuts speaker-follow at ${fps} fps: keep x/y/scale uses the set_clip writer; a plain pair stays at scale 1`, () => {
  const name = `Turn${fps}`;
  mkFps(name, fps);
  const keep = [
    { in_s: 0, out_s: 2, scale: 3.1605, x: 1.225, y: 0 },
    [2, 4.016],
    { in_s: 5, out_s: 6, x: -1.14, scale: 3.1605 },
  ];
  const args = { draft: name, path: join(MEDIA, "clip.mp4"), media_duration_s: 10, keep };
  const dry = call("capcut_add_cuts", args);
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(draft(name).tracks.length, 0);
  r2(call("capcut_add_cuts", { ...args, dry_run: false }));
  const v = draft(name).tracks.find((t: any) => t.name === "main").segments;
  assert.equal(v.length, 3);
  assert.deepEqual(v[0].clip.scale, { x: 3.1605, y: 3.1605 });
  assert.equal(v[0].uniform_scale.value, 3.1605);
  assert.deepEqual(v[0].clip.transform, { x: 1.225, y: 0 });
  assert.deepEqual(v[1].clip.scale, { x: 1, y: 1 });
  assert.deepEqual(v[1].clip.transform, { x: 0, y: 0 });
  assert.deepEqual(v[2].clip.scale, { x: 3.1605, y: 3.1605 });
  assert.deepEqual(v[2].clip.transform, { x: -1.14, y: 0 });
  for (const s of v) assert.ok(onGrid(s.target_timerange.start, fps) && onGrid(s.target_timerange.start + s.target_timerange.duration, fps));
  assert.equal(v[1].target_timerange.duration, fps === 30 ? 2_000_000 : 2_016_667, "4.016 s snaps to 2.000 s at 30 fps and 2.016667 s at 60 fps");
  assert.match(call("capcut_add_cuts", { ...args, keep: [{ in_s: 0, out_s: 1, rotation: 5 }] }).text, /Unknown keep field/);
  assert.match(call("capcut_add_cuts", { draft: name, path: join(MEDIA, "song.mp3"), media_duration_s: 30, keep: [{ in_s: 0, out_s: 1, x: 0.2 }] }).text, /video/);
});

for (const fps of [30, 60]) test(`add_cuts srt_out at ${fps} fps: remapped SRT snaps to the frame grid, dry-run writes nothing, never overwrites`, () => {
  const name = `Cc${fps}`;
  mkFps(name, fps);
  const srt = "1\n00:00:02,016 --> 00:00:03,016\nhola mundo\n\n2\n00:00:04,200 --> 00:00:05,800\ncortado\n";
  const out = join(tmp, `cc-${fps}.srt`);
  const want = fps === 30
    ? "1\n00:00:00,000 --> 00:00:01,000\nhola mundo\n"
    : "1\n00:00:00,017 --> 00:00:01,017\nhola mundo\n";
  const base = { draft: name, path: join(MEDIA, "clip.mp4"), media_duration_s: 10, keep: [[2, 4], [6, 8]], srt_text: srt, srt_out: out, place_subtitles: false };
  const dry = call("capcut_add_cuts", base);
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.equal(existsSync(out), false);
  assert.ok(dry.data.would_write.includes(out));
  assert.equal(dry.data.srt_out.preview, want);
  assert.equal(dry.data.srt_out.dropped_in_cuts, 1);
  assert.equal(dry.data.subtitles, undefined);
  assert.equal(draft(name).tracks.length, 0);
  r2(call("capcut_add_cuts", { ...base, dry_run: false }));
  assert.equal(readFileSync(out, "utf8"), want);
  assert.equal(draft(name).tracks.some((t: any) => t.type === "text"), false, "place_subtitles false leaves the draft caption-free");
  mkFps(`CcAgain${fps}`, fps);
  assert.match(call("capcut_add_cuts", { ...base, draft: `CcAgain${fps}`, dry_run: false }).text, /exists/);
  assert.match(call("capcut_add_cuts", { ...base, draft: `CcAgain${fps}`, srt_out: "rel.srt" }).text, /absolute/);
  assert.match(call("capcut_add_cuts", { ...base, draft: `CcAgain${fps}`, srt_out: join(tmp, "no-such-dir", "x.srt") }).text, /Folder does not exist/);
  const cards = `CcCard${fps}`;
  mkFps(cards, fps);
  const out2 = join(tmp, `cc-cards-${fps}.srt`);
  r2(call("capcut_add_cuts", { draft: cards, path: join(MEDIA, "clip.mp4"), media_duration_s: 10, keep: [[2, 4]], srt_text: srt, srt_out: out2, max_words: 1, dry_run: false }));
  assert.equal(readFileSync(out2, "utf8"), want, "the file is the remapped cue, not the short cards");
  assert.deepEqual(texts(draft(cards), "subtitles").map((m: any) => JSON.parse(m.content).text), ["hola", "mundo"]);
});

test("make_short passes sub_style and title_style through the style_text writer", () => {
  mkFps("Styled", 60);
  const args = { draft: "Styled", clip_path: join(MEDIA, "clip.mp4"), clip_media_duration_s: 4, srt_text: SRT, title: "hook",
    sub_style: { bold: true, stroke_color: "#000000", stroke_width: 40, highlight: [{ word: "mira", color: "#F8D508" }] },
    title_style: { italic: true, bold: true } };
  const dry = call("capcut_make_short", args);
  assert.equal(dry.data.dry_run, true, dry.text);
  assert.ok(dry.data.steps.subtitles.style.segments >= 1);
  assert.equal(dry.data.steps.title.style.segments, 1);
  assert.equal(draft("Styled").tracks.length, 0);
  r2(call("capcut_make_short", { ...args, dry_run: false }));
  const d = draft("Styled"), sub = texts(d, "subtitles");
  assert.equal(sub[0].border_width, 0.08);
  assert.equal(JSON.parse(sub[0].content).styles[0].bold, true);
  const mira = JSON.parse(sub.find((m: any) => JSON.parse(m.content).text.includes("mira")).content);
  assert.ok(mira.styles.length > 1);
  assert.deepEqual(mira.styles[0].fill.content.solid.color, [248 / 255, 213 / 255, 8 / 255]);
  const title = JSON.parse(texts(d, "text")[0].content).styles[0];
  assert.equal(title.bold, true);
  assert.equal(title.italic, true);
  mkFps("StyledBad", 30);
  const clipArgs = { draft: "StyledBad", clip_path: join(MEDIA, "clip.mp4"), clip_media_duration_s: 4 };
  assert.match(call("capcut_make_short", { ...clipArgs, srt_text: SRT, sub_style: { nope: true } }).text, /Unknown sub_style field/);
  assert.match(call("capcut_make_short", { ...clipArgs, title_style: { bold: true } }).text, /title_style needs a title/);
  assert.match(call("capcut_make_short", { ...clipArgs, sub_style: { bold: true } }).text, /sub_style needs/);
  assert.equal(draft("StyledBad").tracks.length, 0);
});
