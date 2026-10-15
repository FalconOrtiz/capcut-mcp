// capcut-mcp v0.3 feature tools. Field names and evidence: docs/CAPCUT_FEATURE_MAP.md and docs/capcut_features.json.
// Same rules as server.ts: dry-run by default, path confinement, .bak before overwrite, no decryption, no network.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  type Args, type Json, type Loaded, DRAFT, DRY, INDEX, T, US, assertNewFile, assertWritable, bool, capcutRunning, color, draftDir, dryRun, fail, finish,
  CHUNK_PROPS, companions, endOf, load, mediaFile, num, opMedia, parseSrt, placeCues, probeMedia, readSrt, registerIndex, segment, span, stageNewFile, str, toS, toUs, trackFor, writeAudioFade,
} from "./server.ts";

const HEX = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const solid = (hex: string, alpha = 1) => ({ alpha: 1, content: { render_type: "solid", solid: { alpha, color: rgb(hex) } } });

/** Segments of one named track; with start_s, only the segment that starts there (half-frame tolerance). */
function segmentsOf(l: Loaded, type: string, track: string, a: Args): Json[] {
  const t = l.draft.tracks.find((x: Json) => x.type === type && x.name === track) ?? fail(`No ${type} track named "${track}"`);
  if (a.start_s === undefined) return t.segments;
  const fps = l.draft.fps || 30, at = toUs(num(a, "start_s", 0, 86_400), fps);
  const hit = t.segments.filter((s: Json) => Math.abs(s.target_timerange.start - at) <= US / fps / 2);
  if (hit.length === 0) fail(`No segment starts at ${a.start_s}s on ${type} track "${track}"`);
  return hit;
}

/** Highlight words: split [0, len) into ranges; ranges are UTF-16 code units (JS string indexes), as CapCut stores them. */
export function highlightRanges(text: string, words: { word: string; color: string }[]): [number, number, string | null][] {
  const marks: (string | null)[] = Array(text.length).fill(null), low = text.toLowerCase();
  for (const { word, color } of words) {
    const w = word.toLowerCase();
    for (let i = low.indexOf(w); w && i >= 0; i = low.indexOf(w, i + w.length)) {
      const edge = (j: number) => j < 0 || j >= low.length || !/[\p{L}\p{N}]/u.test(low[j]);
      if (edge(i - 1) && edge(i + w.length)) marks.fill(color, i, i + w.length); // whole words only
    }
  }
  const out: [number, number, string | null][] = [];
  for (let i = 0; i < text.length; i++) {
    if (out.length && out[out.length - 1][2] === marks[i]) out[out.length - 1][1] = i + 1; else out.push([i, i + 1, marks[i]]);
  }
  return out;
}

function opStyleText(l: Loaded, a: Args): Json {
  const segs = segmentsOf(l, "text", str(a, "track", 100), a);
  const has = (k: string) => a[k] !== undefined;
  const strokeW = has("stroke_width") ? Math.round(num(a, "stroke_width", 0, 100) * 2000) / 1e6 : undefined; // UI 0-100 -> 0-0.2 (UI diff 9.5.0: 40 -> 0.08, 60 -> 0.12)
  const strokeC = has("stroke_color") || strokeW !== undefined ? color(a, "stroke_color", "#000000") : undefined;
  let shadow: Json;
  if (has("shadow")) {
    const s = (a.shadow ?? {}) as Args;
    if (typeof s !== "object" || Array.isArray(s)) fail("shadow must be an object");
    for (const k of Object.keys(s)) if (!["color", "alpha", "distance", "angle", "smoothing"].includes(k)) fail(`Unknown shadow field: ${k}`);
    shadow = { color: color(s, "color", "#000000"), alpha: num(s, "alpha", 0, 1, 0.8), distance: num(s, "distance", 0, 100, 5), angle: num(s, "angle", -180, 180, -45), smoothing: num(s, "smoothing", 0, 100, 15) };
  }
  // Background box, UI diff 9.5.0: % sliders / 100; offsets (UI% - 50) / 50, so 0 is centred.
  const bg = has("bg_color") ? { color: color(a, "bg_color", "#000000"), alpha: num(a, "bg_alpha", 0, 1, 1), style: num(a, "bg_style", 1, 2, 1), radius: num(a, "bg_round_radius", 0, 1, 0),
    width: num(a, "bg_width", 0, 1, 0.14), height: num(a, "bg_height", 0, 1, 0.14), x: num(a, "bg_offset_x", -1, 1, 0), y: num(a, "bg_offset_y", -1, 1, 0) } : undefined;
  if (!bg && ["bg_alpha", "bg_style", "bg_round_radius", "bg_width", "bg_height", "bg_offset_x", "bg_offset_y"].some(has)) fail("bg_* fields need bg_color");
  let font: string | undefined;
  if (has("font_path")) {
    font = str(a, "font_path", 4096);
    if (!isAbsolute(font) || !existsSync(font) || !statSync(font).isFile()) fail(`font_path does not exist or is not an absolute file path: ${font}`);
    if (![".ttf", ".otf", ".ttc"].includes(extname(font).toLowerCase())) fail("font_path must be a .ttf, .otf or .ttc file");
  }
  const words = has("highlight") ? (Array.isArray(a.highlight) ? a.highlight : fail("highlight must be a list")) as Args[] : undefined;
  const hl = words?.map((w) => ({ word: str(w, "word", 100), color: color(w, "color", "#F8D508") }));
  const align = has("alignment") ? ({ left: 0, center: 1, right: 2 } as Json)[a.alignment as string] ?? fail("alignment must be left, center or right") : undefined;
  const size = has("font_size") ? num(a, "font_size", 1, 100) : undefined;
  const fill = has("color") ? color(a, "color", "#FFFFFF") : undefined;
  const maxW = has("max_width") ? num(a, "max_width", 0.1, 1) : undefined;
  const bold = has("bold") ? bool(a, "bold", false) : undefined, italic = has("italic") ? bool(a, "italic", false) : undefined;
  const underline = has("underline") ? bool(a, "underline", false) : undefined;
  const letterSp = has("letter_spacing") ? Math.round(num(a, "letter_spacing", -100, 100) * 5e4) / 1e6 : undefined; // UI diff 9.5.0: UI 5 -> 0.25, -3 -> -0.15
  const lineSp = has("line_spacing") ? Math.round(num(a, "line_spacing", -100, 100) * 5e4) / 1e6 : undefined; // UI 8 -> 0.4, 4 -> 0.2
  let glow: Json; // UI diff 9.5.0 'Brillo': materials.effects[type=bloom, panel_id text_glow], text check_flag |= 64
  if (has("glow") && a.glow !== null) {
    const g = a.glow && typeof a.glow === "object" && !Array.isArray(a.glow) ? a.glow as Args : fail("glow must be {style?: neon|rays, color?, strength?: 0-100, range?: 0-100} or null");
    for (const k of Object.keys(g)) if (!["style", "color", "strength", "range"].includes(k)) fail(`Unknown glow field: ${k}`);
    const st = GLOW[(g.style ?? "neon") as string] ?? fail("glow.style must be neon (free) or rays (Pro)");
    glow = { id: st[0], name: st[1], color: color(g, "color", "#000000"), strength: num(g, "strength", 0, 100, 50) / 100, range: num(g, "range", 0, 100, 40) / 100 };
  }
  const art = has("wordart") ? wordArt(l, a.wordart) : undefined;
  let bubble: Json; // UI diff 9.5.0 (sessions 2, 4): materials.effects[type=text_shape, sub_type manual_stretch, category bubble]; third_resource_id from the CapCut resource list
  if (has("bubble") && a.bubble !== null) {
    const b = a.bubble && typeof a.bubble === "object" && !Array.isArray(a.bubble) ? a.bubble as Args : fail("bubble must be {resource_id, third_resource_id} or null");
    const id = rid(b), third = str(b, "third_resource_id", 25);
    if (!/^[0-9]{6,25}$/.test(third)) fail("bubble.third_resource_id must be digits (see verified_ids.text_bubbles in docs/capcut_features.json)");
    bubble = { id, third, path: cachedEffect(l, id) };
  }
  if (art && strokeC) fail("CapCut disables the stroke while WordArt is on: drop stroke_* or wordart");
  const mats = new Map(l.draft.materials.texts.map((m: Json) => [m.id, m]));
  for (const s of segs) {
    const m: Json = mats.get(s.material_id) ?? fail("text segment without a text material");
    const c = JSON.parse(m.content);
    const base = { ...c.styles[0] };
    if (art !== undefined) applyWordArt(l, s, m, base, art);
    if (size !== undefined) { base.size = size; m.font_size = size; }
    if (fill) { base.fill = solid(fill); m.text_color = fill; }
    if (bold !== undefined) base.bold = bold;
    if (italic !== undefined) base.italic = italic;
    if (underline !== undefined) { base.underline = underline; m.underline = underline; }
    if (letterSp !== undefined) m.letter_spacing = letterSp;
    if (lineSp !== undefined) m.line_spacing = lineSp;
    if (has("glow")) {
      const d = l.draft, old = new Set((d.materials.effects ??= []).filter((x: Json) => x.type === "bloom" && s.extra_material_refs.includes(x.id)).map((x: Json) => x.id));
      s.extra_material_refs = s.extra_material_refs.filter((r: string) => !old.has(r)); d.materials.effects = d.materials.effects.filter((x: Json) => !old.has(x.id));
      if (glow) {
        const e = { id: randomUUID(), effect_id: glow.id, resource_id: glow.id, third_resource_id: "", name: glow.name, report_name: "", type: "bloom", sub_type: "none", path: cachedEffect(l, glow.id),
          value: 0, visible: true, item_effect_type: 0, category_id: "", category_name: "", platform: "all", apply_target_type: 0, source_platform: 1, version: "", adjust_params: [], time_range: null,
          formula_id: "", panel_id: "text_glow", bloom_params: { color: glow.color, strength: glow.strength, range: glow.range, dir_x: 0.5, dir_y: 0.5 }, request_id: "" };
        d.materials.effects.push(e); s.extra_material_refs.push(e.id); m.check_flag |= 64;
      } else m.check_flag &= ~64;
    }
    if (font) { base.font = { id: "", path: font }; m.font_path = font; m.font_id = ""; m.font_resource_id = ""; }
    if (strokeC) {
      const w = strokeW ?? m.border_width ?? 0.06;
      base.strokes = [{ width: w, mode: 0, content: { solid: { color: rgb(strokeC) }, render_type: "solid" } }];
      Object.assign(m, { border_color: strokeC, border_width: w, border_alpha: 1 });
      m.check_flag |= 8;
    }
    if (shadow) {
      // UI diff 9.5.0: blur 40% -> diffuse 40/600 in content, shadow_smoothing 40*0.03; shadow_point = 0.18 * distance * (cos, sin).
      const rad = (shadow.angle * Math.PI) / 180, k = 0.18 * shadow.distance;
      base.shadows = [{ thickness_projection_distance: 0, diffuse: shadow.smoothing / 600, angle: shadow.angle, thickness_projection_enable: false, content: { solid: { color: rgb(shadow.color) }, render_type: "solid" }, distance: shadow.distance, thickness_projection_angle: -45, alpha: shadow.alpha }];
      Object.assign(m, { has_shadow: true, shadow_color: shadow.color, shadow_alpha: shadow.alpha, shadow_distance: shadow.distance, shadow_angle: shadow.angle, shadow_smoothing: shadow.smoothing * 0.03,
        shadow_point: { x: Math.round(k * Math.cos(rad) * 1e6) / 1e6, y: Math.round(k * Math.sin(rad) * 1e6) / 1e6 } });
      m.check_flag |= 32;
    }
    if (bg) {
      Object.assign(m, { background_color: bg.color, background_alpha: bg.alpha, background_style: bg.style, background_round_radius: bg.radius,
        background_width: bg.width, background_height: bg.height, background_horizontal_offset: bg.x, background_vertical_offset: bg.y });
      m.check_flag |= 16;
    }
    if (has("bubble")) {
      const d = l.draft, old = new Set((d.materials.effects ??= []).filter((x: Json) => x.type === "text_shape" && s.extra_material_refs.includes(x.id)).map((x: Json) => x.id));
      s.extra_material_refs = s.extra_material_refs.filter((r: string) => !old.has(r)); d.materials.effects = d.materials.effects.filter((x: Json) => !old.has(x.id));
      if (bubble) {
        const e = { id: randomUUID(), effect_id: bubble.id, resource_id: bubble.id, third_resource_id: bubble.third, name: "", report_name: "", type: "text_shape", sub_type: "manual_stretch",
          path: bubble.path, value: 1, visible: true, item_effect_type: 0, category_id: "bubble", category_name: "Burbuja", category_key: "", sub_category_id: "", sub_category_name: "",
          platform: "all", apply_target_type: 0, source_platform: 1, version: "", adjust_params: [], time_range: null, formula_id: "", request_id: "" };
        d.materials.effects.push(e); s.extra_material_refs.push(e.id);
      }
    }
    if (align !== undefined) m.alignment = align;
    if (maxW !== undefined) Object.assign(m, { line_max_width: maxW, force_apply_line_max_width: true });
    c.styles = hl ? highlightRanges(c.text, hl).map(([x, y, col]) => ({ ...structuredClone(base), range: [x, y], ...(col ? { fill: solid(col) } : {}) }))
      : [{ ...base, range: [0, c.text.length] }];
    m.content = JSON.stringify(c);
  }
  return { segments: segs.length, track: a.track, ...(bubble && !bubble.path ? pathNote("") : {}) };
}

const GLOW: Record<string, [string, string]> = { neon: ["7194814295517958657", "neón brillante"], rays: ["7194814374001775105", "rayos brillantes"] }; // rays has the Pro diamond

/** WordArt preset (UI diff 9.5.0, sessions 2 and 4): read the downloaded folder's effectStyle.json; null removes it. */
function wordArt(l: Loaded, v: unknown): Json {
  if (v === null) return null;
  const id = rid({ resource_id: v }), path = cachedEffect(l, id);
  const file = join(path, "effectStyle.json");
  if (!path || !existsSync(file)) fail(`WordArt ${id} is not in the local CapCut cache (Cache/effect/${id}/<md5>/effectStyle.json): apply it once in CapCut so it downloads`);
  const c = JSON.parse(readFileSync(file, "utf8")).fill?.content ?? {};
  const fill = c.render_type === "texture" && c.texture?.path ? { content: { texture: { range: c.texture.range, scale: c.texture.scale, path: join(path, c.texture.path) }, render_type: "texture" } }
    : c.render_type === "solid" && c.solid?.color ? { content: { solid: { color: c.solid.color }, render_type: "solid" } } // ponytail: solid WordArt not seen in a CapCut-saved draft yet
    : fail(`WordArt ${id}: fill render_type "${c.render_type}" is not supported (texture and solid are)`);
  return { id, path, fill };
}

function applyWordArt(l: Loaded, s: Json, m: Json, base: Json, art: Json) {
  const d = l.draft, old = new Set((d.materials.effects ??= []).filter((x: Json) => x.type === "text_effect" && x.effect_id && s.extra_material_refs.includes(x.id)).map((x: Json) => x.id));
  s.extra_material_refs = s.extra_material_refs.filter((r: string) => !old.has(r));
  d.materials.effects = d.materials.effects.filter((x: Json) => !old.has(x.id));
  if (!art) { delete base.effectStyle; base.fill = solid(m.text_color || "#FFFFFF"); m.use_effect_default_color = false; return; }
  const e = { id: randomUUID(), effect_id: art.id, resource_id: art.id, third_resource_id: "0", name: "", type: "text_effect", sub_type: "none", path: art.path, value: 1, visible: true,
    item_effect_type: 0, category_id: "", category_name: "", platform: "all", apply_target_type: 0, source_platform: 1, version: "", adjust_params: [], time_range: null, request_id: "" };
  d.materials.effects.push(e);
  s.extra_material_refs.push(e.id);
  Object.assign(base, { fill: structuredClone(art.fill), effectStyle: { path: art.path, id: art.id } });
  delete base.strokes;
  m.use_effect_default_color = true;
}

/** CapCut volume panel: segment.volume = 10^(dB/20); -60 dB and lower is stored as 0 (UI diff 9.5.0). */
export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.round(10 ** (db / 20) * 1e6) / 1e6);

/** Cached effect folder of a resource id (Cache/effect/<id>/<hash>), as CapCut writes it in `path`; "" if not downloaded. */
function cachedEffect(l: Loaded, id: string): string {
  const dir = join(resolve(l.dir, "../../.."), "Cache", "effect", id); // <User Data>/Projects/com.lveditor.draft/<draft>
  try { const sub = readdirSync(dir).find((f) => statSync(join(dir, f)).isDirectory()); return sub ? join(dir, sub) : ""; } catch { return ""; }
}
const RID = { type: "string", pattern: "^[0-9]{6,25}$", description: "CapCut resource_id (digits), from docs/capcut_features.json or a CapCut-saved draft." };
const rid = (a: Args) => { const v = str(a, "resource_id", 25); if (!/^[0-9]{6,25}$/.test(v)) fail("resource_id must be digits"); return v; };
const optName = (a: Args) => (a.name === undefined ? "" : str(a, "name", 100));
const pathNote = (p: string) => (p ? {} : { warning: "Resource not in the local CapCut cache: open its panel in CapCut once (it downloads by resource_id; not verified offline)." });

/** New speed on a segment: target = source / speed snapped to frames; mode 1 + curve_speed for a curve, mode 0 + null for constant. */
function retime(l: Loaded, t: Json, s: Json, track: string, v: number, curve: Json) {
  const d = l.draft, fps = d.fps || 30;
  const [start, dur] = span(s.target_timerange.start / US, s.source_timerange.duration / US / v, fps);
  for (const o of t.segments) {
    if (o === s) continue;
    const x = o.target_timerange.start, y = x + o.target_timerange.duration;
    if (start < y && start + dur > x) fail(`Overlaps the next segment on track "${track}" (${toS(x)}s). Move it or use a lower speed.`);
  }
  s.target_timerange.duration = dur; s.speed = v;
  let sp = refd(l, s, "speeds");
  if (!sp) { sp = { id: randomUUID(), type: "speed" }; d.materials.speeds.push(sp); s.extra_material_refs.push(sp.id); }
  Object.assign(sp, { mode: curve ? 1 : 0, speed: v, curve_speed: curve });
  d.duration = endOf(d);
}

/** Speed-curve presets as CapCut 9.5.0 stores them (UI diff 2026-10-03, names as the Spanish UI writes them). */
export const SPEED_CURVES: Record<string, [string, string, number[][]]> = {
  custom: ["6768730851543880206", "Personalizado", [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]]],
  montage: ["6768648600848175619", "Montaje", [[0, 0.9], [0.1, 0.9], [0.5, 6.8], [0.65, 0.3], [0.8, 1], [1, 1]]],
  hero: ["6768650238149267981", "Héroe", [[0, 1], [0.35, 5.5], [0.45, 0.5], [0.55, 0.5], [0.65, 5.5], [1, 1]]],
  bullet: ["6768731518358524430", "Bala", [[0, 5.2], [0.4, 5.2], [0.46, 0.5], [0.54, 0.5], [0.6, 5.2], [1, 5.2]]],
  jump_cut: ["6768731594225095175", "Corte en la edición", [[0, 0.6], [0.43, 0.6], [0.5, 6], [0.57, 0.6], [1, 0.6]]],
  flash_in: ["6768731653402530307", "Flash de entrada", [[0, 5.2], [0.4, 5.2], [0.6, 1], [1, 1]]],
  flash_out: ["6768731733484376589", "Flash de salida", [[0, 1], [0.4, 1], [0.6, 5.2], [1, 5.2]]],
};

/** Average speed CapCut stores for a curve (fits 10 UI-diff samples to 1e-7): 1 / sum(dx / mean(y_i, y_i+1)). */
export const curveAverage = (pts: number[][]) => 1 / pts.slice(1).reduce((t, [x, y], i) => t + (x - pts[i][0]) / ((y + pts[i][1]) / 2), 0);

function opSpeedCurve(l: Loaded, a: Args): Json {
  const track = str(a, "track", 100, "main"), d = l.draft;
  if (a.start_s === undefined) fail("start_s is required: it picks the segment");
  const [s] = segmentsOf(l, "video", track, a), t = d.tracks.find((x: Json) => x.type === "video" && x.name === track);
  if (a.curve === null) { retime(l, t, s, track, 1, null); return { track, start_s: toS(s.target_timerange.start), curve: null, speed: 1, duration_s: toS(s.target_timerange.duration) }; }
  const name = (a.curve ?? (a.points ? "custom" : fail("give curve (preset name or null) or points"))) as string;
  const [id, label, preset] = SPEED_CURVES[name] ?? fail(`curve must be one of ${Object.keys(SPEED_CURVES).join(", ")} or null`);
  const pts = a.points === undefined ? preset : (Array.isArray(a.points) ? a.points : fail("points must be a list of [x, y]")) as number[][];
  if (pts.length < 2 || pts.length > 20) fail("points: 2 to 20 [x, y] pairs");
  pts.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === "number" && Number.isFinite(n))) fail("each point is [x, y] numbers");
    if (p[1] < 0.1 || p[1] > 10) fail("point speed y must be 0.1-10 (the CapCut curve range)");
    if (i === 0 ? p[0] !== 0 : p[0] <= pts[i - 1][0]) fail("point x must start at 0 and increase");
  });
  if (pts[pts.length - 1][0] !== 1) fail("the last point x must be 1");
  const v = curveAverage(pts);
  retime(l, t, s, track, v, { id, source_platform: 0, name: label, speed_points: pts.map(([x, y]) => ({ x, y })) });
  return { track, start_s: toS(s.target_timerange.start), curve: name, average_speed: v, duration_s: toS(s.target_timerange.duration) };
}

/** Transition on the cut after the segment at start_s (UI diff 9.5.0: materials.transitions, ref on the LEFT segment). */
function opTransition(l: Loaded, a: Args): Json {
  const track = str(a, "track", 100, "main"), d = l.draft, fps = d.fps || 30;
  if (a.start_s === undefined) fail("start_s is required: the segment before the cut");
  const [s] = segmentsOf(l, "video", track, a), t = d.tracks.find((x: Json) => x.type === "video" && x.name === track);
  const end = s.target_timerange.start + s.target_timerange.duration;
  const next = t.segments.find((o: Json) => Math.abs(o.target_timerange.start - end) <= US / fps / 2) ?? fail(`No clip starts right after the one at ${a.start_s}s on "${track}"`);
  const max = Math.min(s.target_timerange.duration, next.target_timerange.duration) / 2 / US;
  const dur = toUs(num(a, "duration_s", 0.1, Math.max(0.1, max), Math.min(0.5, max)), fps), id = rid(a), path = cachedEffect(l, id);
  const old = refd(l, s, "transitions");
  if (old) { unref(s, old.id); d.materials.transitions = d.materials.transitions.filter((m: Json) => m !== old); }
  const m = { id: randomUUID(), type: "transition", name: optName(a), effect_id: id, resource_id: id, third_resource_id: "0", source_platform: 1, path,
    duration: dur, is_overlap: true, platform: "all", category_id: "", category_name: "", request_id: "", is_ai_transition: false, video_path: "", task_id: "" };
  d.materials.transitions.push(m);
  s.extra_material_refs.splice(Math.min(2, s.extra_material_refs.length), 0, m.id); // CapCut puts it after speed + placeholder
  return { track, after_start_s: toS(s.target_timerange.start), duration_s: toS(dur), resource_id: id, replaced: !!old, ...pathNote(path) };
}

/** Clip filter (UI diff 9.5.0: materials.effects[type=filter], value = intensity/100, ref on the segment). */
function opFilter(l: Loaded, a: Args): Json {
  const track = str(a, "track", 100, "main"), d = l.draft;
  if (a.start_s === undefined) fail("start_s is required: it picks the segment");
  const [s] = segmentsOf(l, "video", track, a), id = rid(a), path = cachedEffect(l, id);
  const old = refd(l, s, "effects", (m) => m.type === "filter");
  if (old) { unref(s, old.id); d.materials.effects = d.materials.effects.filter((m: Json) => m !== old); }
  const m = { id: randomUUID(), type: "filter", name: optName(a), effect_id: id, resource_id: id, third_resource_id: "0", sub_type: "none", path,
    value: num(a, "intensity", 0, 100, 100) / 100, visible: true, platform: "all", apply_target_type: 0, source_platform: 1, category_id: "", category_name: "",
    adjust_params: [], time_range: null, request_id: "", version: "" };
  d.materials.effects.push(m);
  s.extra_material_refs.splice(Math.min(2, s.extra_material_refs.length), 0, m.id);
  return { track, start_s: toS(s.target_timerange.start), intensity: m.value * 100, resource_id: id, replaced: !!old, ...pathNote(path) };
}

/** In / out / loop / combo animation (UI diff 9.5.0: materials.material_animations[type=sticker_animation].animations[]). */
function opAnimation(l: Loaded, a: Args): Json {
  const track = str(a, "track", 100), d = l.draft, fps = d.fps || 30, kind = a.kind as string;
  if (!["in", "out", "loop", "group"].includes(kind)) fail("kind must be in, out, loop or group (combo)");
  const t = d.tracks.find((x: Json) => x.name === track && ["video", "text", "sticker"].includes(x.type)) ?? fail(`No video, text or sticker track named "${track}"`);
  if (kind === "loop" && t.type === "video") fail("loop animations are for text and stickers");
  if (a.start_s === undefined) fail("start_s is required: it picks the segment");
  const [s] = segmentsOf(l, t.type, track, a), segDur = s.target_timerange.duration, id = rid(a), path = cachedEffect(l, id);
  const dur = toUs(num(a, "duration_s", 0.1, segDur / US, Math.min(0.5, segDur / US)), fps);
  let ma = refd(l, s, "material_animations");
  if (!ma) { ma = { id: randomUUID(), type: "sticker_animation", animations: [], multi_language_current: "none" }; d.materials.material_animations.push(ma); s.extra_material_refs.push(ma.id); }
  const clash = kind === "group" ? ["in", "out", "group"] : kind === "loop" ? ["loop"] : [kind, "group"]; // ponytail: combo replaces in/out as in the UI; loop+in seen together in 9.5.0
  ma.animations = ma.animations.filter((x: Json) => !clash.includes(x.type));
  const video = t.type === "video";
  ma.animations.push({ id, type: kind, start: kind === "out" ? segDur - dur : 0, duration: kind === "group" ? segDur : dur, path, platform: "all", resource_id: id,
    third_resource_id: id, source_platform: 1, name: optName(a), category_id: "", category_name: "", panel: video ? "video" : "",
    material_type: video ? "video" : "sticker", anim_adjust_params: null, request_id: "" });
  return { track, start_s: toS(s.target_timerange.start), kind, duration_s: toS(kind === "group" ? segDur : dur), resource_id: id, animations: ma.animations.map((x: Json) => x.type), ...pathNote(path) };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** YouTube stamp: whole second that contains the frame-snapped time (HH:MM:SS). */
const chapterStamp = (us: number) => {
  const sec = Math.floor(us / US);
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor(sec / 60) % 60)}:${pad2(sec % 60)}`;
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const stampSec = (stamp: string) => { const [h, m, s] = stamp.split(":").map(Number); return h * 3600 + m * 60 + s; };

/** YouTube chapter list from time_marks. Inserts 00:00:00 when no marker falls in the first second.
 *  Rejects a list YouTube will not use: fewer than 3 chapters, displayed times under 10 seconds apart
 *  (including two markers that floor to the same second), or a last chapter shorter than 10 seconds. */
function chaptersFromMarks(l: Loaded, zeroTitle: string): { text: string; chapters: number; inserted_zero: boolean } {
  const fps = l.draft.fps || 30, items = l.draft.time_marks?.mark_items;
  if (!Array.isArray(items) || !items.length) fail("No timeline markers. Add them with capcut_add_markers.");
  const title0 = oneLine(zeroTitle);
  if (!title0) fail("zero_title is empty");
  const rows = items.map((m: Json) => {
    const us = toUs((m.time_range?.start ?? 0) / US, fps);
    return { us, stamp: chapterStamp(us), title: oneLine(String(m.title ?? "")) || "Untitled" };
  }).sort((a, b) => a.us - b.us);
  const inserted_zero = rows[0].stamp !== "00:00:00";
  if (inserted_zero) rows.unshift({ us: 0, stamp: "00:00:00", title: title0 });
  if (rows.length < 3) fail(`YouTube needs at least 3 chapters; this list has ${rows.length}.`);
  if (rows[0].stamp !== "00:00:00") fail("YouTube requires the first chapter at 00:00:00.");
  for (let i = 1; i < rows.length; i++) {
    const gap = stampSec(rows[i].stamp) - stampSec(rows[i - 1].stamp);
    if (gap < 10) fail(`YouTube chapters must be at least 10 seconds apart. ${rows[i - 1].stamp} and ${rows[i].stamp} are ${gap}s apart.`);
  }
  const last = stampSec(rows[rows.length - 1].stamp);
  const endSec = Math.floor(Math.max(0, l.draft.duration ?? 0) / US);
  const tail = endSec - last;
  if (tail < 10) fail(`The last YouTube chapter must be at least 10 seconds. It runs ${tail}s, from ${rows[rows.length - 1].stamp} to ${chapterStamp(Math.max(0, l.draft.duration ?? 0))}.`);
  return { text: rows.map((r) => `${r.stamp} ${r.title}`).join("\n") + "\n", chapters: rows.length, inserted_zero };
}

/** Timeline markers (UI diff 9.5.0: top-level time_marks.mark_items[], duration 0, default color #00c1cd). */
function opMarkers(l: Loaded, a: Args): Json {
  const list = Array.isArray(a.markers) && a.markers.length ? a.markers as Args[] : fail("markers must be a non-empty list of {t_s, title?, color?}");
  if (list.length > 500) fail("at most 500 markers");
  const d = l.draft, fps = d.fps || 30;
  d.time_marks ??= { id: randomUUID(), mark_items: [] };
  for (const m of list) {
    d.time_marks.mark_items.push({ id: randomUUID(), time_range: { start: toUs(num(m, "t_s", 0, 86_400), fps), duration: 0 },
      color: color(m, "color", "#00C1CD").toLowerCase(), title: str(m, "title", 200, `Marker ${String(d.time_marks.mark_items.length + 1).padStart(2, "0")}`) });
  }
  d.time_marks.mark_items.sort((x: Json, y: Json) => x.time_range.start - y.time_range.start);
  return { added: list.length, total: d.time_marks.mark_items.length };
}

/** C6: track_render_index = position in tracks[] (UI diff 9.5.0). */
const renumber = (d: Json) => d.tracks.forEach((t: Json, i: number) => t.segments.forEach((s: Json) => { s.track_render_index = i; }));

/** Track-level segment (effect, adjust): no source range, no clip transform, as CapCut writes them. */
function trackSegment(d: Json, type: string, name: string, materialId: string, renderIndex: number, a: Args): Json {
  const fps = d.fps || 30, [start, dur] = span(num(a, "start_s", 0, 86_400), num(a, "duration_s", 0.1, 86_400, 3), fps);
  const t = trackFor(d, type, name, start, dur), s = segment(materialId, start, dur, 0, [], renderIndex, true);
  s.source_timerange = null;
  t.segments.push(s); t.segments.sort((x: Json, y: Json) => x.target_timerange.start - y.target_timerange.start);
  renumber(d); d.duration = endOf(d);
  return s;
}

/** Scene or body effect on an effect track (UI diff 9.5.0: materials.video_effects[type video_effect | face_effect], render_index 11000+n). */
function opEffect(l: Loaded, a: Args): Json {
  const d = l.draft, kind = (a.kind ?? "scene") as string, id = rid(a), path = cachedEffect(l, id);
  if (!["scene", "body"].includes(kind)) fail("kind must be scene or body");
  const params = a.params === undefined ? [] : Object.entries(a.params as Args).map(([name, v]) => {
    if (!/^effects_adjust_[a-z_]+$/.test(name)) fail(`params keys look like effects_adjust_speed, not ${name}`);
    const value = num({ v }, "v", 0, 1); return { name, value, default_value: value };
  });
  const n = d.tracks.filter((t: Json) => t.type === "effect").reduce((k: number, t: Json) => k + t.segments.length, 0);
  const m = { id: randomUUID(), effect_id: id, resource_id: id, name: optName(a), type: kind === "body" ? "face_effect" : "video_effect", sub_type: 0, bind_segment_id: "",
    transparent_params: "", path, value: 1, category_id: "", category_name: "", platform: "all", apply_target_type: 2, source_platform: 1, version: "", item_effect_type: 0,
    adjust_params: params, time_range: null, formula_id: "", apply_time_range: null, render_index: 0, track_render_index: 0, common_keyframes: [], request_id: "",
    algorithm_artifact_path: "", disable_effect_faces: [], covering_relation_change: 0, enable_mask: true, effect_mask: [] };
  (d.materials.video_effects ??= []).push(m);
  const s = trackSegment(d, "effect", str(a, "track", 100, "effects"), m.id, 11000 + n, a);
  return { kind, type: m.type, resource_id: id, start_s: toS(s.target_timerange.start), duration_s: toS(s.target_timerange.duration), render_index: s.render_index, ...pathNote(path),
    ...(kind === "body" ? { note: "Body effects track people: CapCut computes algorithm_artifact_path (person masks) itself when it opens the draft; not verified offline." } : {}) };
}

/** Sticker (UI diff 9.5.0): materials.stickers[] (path Cache/artistEffect/<id>/<md5>), tracks[type=sticker], render_index 14001+. */
function opSticker(l: Loaded, a: Args): Json {
  const d = l.draft, id = rid(a), dir = join(resolve(l.dir, "../../.."), "Cache", "artistEffect", id);
  let path = ""; try { const sub = readdirSync(dir).find((f) => statSync(join(dir, f)).isDirectory()); path = sub ? join(dir, sub) : ""; } catch { /* not cached */ }
  const m = { id: randomUUID(), unique_id: "", type: "sticker", path, icon_url: "", preview_cover_url: "", sticker_id: id, resource_id: id, name: optName(a), category_id: "", category_name: "",
    platform: "all", unicode: "", source_platform: 1, formula_id: "", check_flag: 1, team_id: "", request_id: "", combo_info: { text_templates: [] }, sub_type: 0,
    radius: { top_left: 0, top_right: 0, bottom_left: 0, bottom_right: 0 }, global_alpha: 1, background_color: "", background_alpha: 1, border_line_style: 0, border_width: 0, border_color: "",
    has_shadow: false, shadow_color: "", shadow_alpha: 0.8, shadow_smoothing: 0, shadow_distance: 0, shadow_point: { x: 0, y: 0 }, shadow_angle: 0,
    shape_param: { shape_type: 0, roundness: [], custom_points: [], shape_size: [] }, original_size: [], update_params: "", aigc_type: "none", sequence_type: false, cycle_setting: true,
    shape_fill_render_style: { color: { solid: { color: "#FFFFFF", alpha: 1 }, gradient: { color: [], alpha: [], percent: [], angle: 90, mode: "all", style: "linear" },
      texture: { path: "", flip: [], scale: 1, alpha: 1, angle: 90, blend: "no", range: 4, fill: "tile", resource_id: "", effect_id: "", play_speed: 1 }, render_type: "solid" }, alpha: 1 },
    shape_fill_use_flower_color: false, multi_language_current: "none", corner_pin: null };
  (d.materials.stickers ??= []).push(m);
  const n = d.tracks.filter((t: Json) => t.type === "sticker").reduce((k: number, t: Json) => k + t.segments.length, 0);
  const s = trackSegment(d, "sticker", str(a, "track", 100, "stickers"), m.id, 14001 + n, a), v = num(a, "scale", 0.01, 50, 1);
  s.clip = { alpha: 1, rotation: num(a, "rotation", -360, 360, 0), scale: { x: v, y: v }, transform: { x: num(a, "x", -10, 10, 0), y: num(a, "y", -10, 10, 0) }, flip: { horizontal: false, vertical: false } };
  s.uniform_scale = { on: true, value: v };
  return { resource_id: id, start_s: toS(s.target_timerange.start), duration_s: toS(s.target_timerange.duration), render_index: s.render_index,
    ...(path ? {} : { warning: "Sticker not in the local CapCut cache (Cache/artistEffect): add it once in CapCut so it downloads; not verified offline." }) };
}

/** Voice filter (UI diff 9.5.0): materials.audio_effects[] (category 'sound_effect' = Filtros de voz), audio check_flag |= 2, video check_flag |= 2048. */
function setVoiceFilter(l: Loaded, s: Json, video: boolean, v: unknown) {
  const d = l.draft, old = refd(l, s, "audio_effects", (m) => m.category_id === "sound_effect");
  if (old) { unref(s, old.id); d.materials.audio_effects = d.materials.audio_effects.filter((m: Json) => m !== old); }
  if (v === null) return;
  const o = v && typeof v === "object" && !Array.isArray(v) ? v as Args : fail("voice_filter must be {resource_id, name?, strength?: 0..1} or null");
  const id = rid(o), path = cachedEffect(l, id), strength = num(o, "strength", 0, 1, 1);
  const m = { id: randomUUID(), constant_material_id: randomUUID().toUpperCase(), type: "audio_effect", name: optName(o), path, production_path: "", sub_type: 1,
    time_range: { start: 0, duration: 0 }, speaker_id: "", resource_id: id, third_resource_id: video ? id : "0", source_platform: 1, category_id: "sound_effect", category_name: "Filtros de voz",
    audio_adjust_params: [{ value: strength, default_value: 1, parameterIndex: 0, portIndex: 0, name: "strength", min_value: 0, max_value: 1 }], is_vc_clone_tone: false, vc_type: "none", is_ugc: false };
  (d.materials.audio_effects ??= []).push(m); s.extra_material_refs.push(m.id);
  const mat = (video ? d.materials.videos : d.materials.audios).find((x: Json) => x.id === s.material_id);
  if (mat) mat.check_flag = (mat.check_flag ?? 1) | (video ? 2048 : 2);
  return path;
}

/** Adjustment layer (UI diff 9.5.0: tracks[type=adjust] -> materials.placeholders[type=adjust] 'AjustarN', config.adjust_max_index). */
function opAdjustLayer(l: Loaded, a: Args): Json {
  const d = l.draft;
  d.config ??= {};
  const n = d.config.adjust_max_index ?? 1; // 9.5.0: 1 before, 2 after creating "Ajustar1"
  const p = { id: randomUUID(), name: `Ajustar${n}`, type: "adjust", material_resource_id: "" };
  d.config.adjust_max_index = n + 1;
  (d.materials.placeholders ??= []).push(p);
  const s = trackSegment(d, "adjust", str(a, "track", 100, "adjust"), p.id, 0, a);
  Object.assign(s, { enable_adjust: true, enable_hsl: true, enable_lut: true, enable_adjust_mask: true, enable_color_curves: true, enable_hsl_curves: true, enable_color_wheels: true });
  const set = a.adjust === undefined ? [] : setAdjust(l, s, a.adjust);
  const lut = a.lut === undefined ? {} : setLut(l, s, a.lut);
  return { name: p.name, start_s: toS(s.target_timerange.start), duration_s: toS(s.target_timerange.duration), adjust: set, ...lut };
}

/** Move a track among the tracks of its type (C6: tracks[] order = layer order, first = bottom). */
function opReorder(l: Loaded, a: Args): Json {
  const d = l.draft, type = str(a, "type", 20), same = d.tracks.filter((t: Json) => t.type === type);
  if (!same.length) fail(`No ${type} tracks`);
  const t = a.name === undefined ? fail("name is required") : same.find((x: Json) => x.name === a.name) ?? fail(`No ${type} track named "${a.name}"`);
  if (type === "video" && t === same[0] && t.flag !== 2) fail("The main video track stays first; move the overlay tracks instead");
  const to = num(a, "position", 0, same.length - 1);
  if (!Number.isInteger(to)) fail("position must be an integer");
  if (type === "video" && to === 0) fail("position 0 is the main video track");
  const order = same.filter((x: Json) => x !== t); order.splice(to, 0, t);
  const slots = d.tracks.map((x: Json, i: number) => (x.type === type ? i : -1)).filter((i: number) => i >= 0);
  slots.forEach((i: number, k: number) => { d.tracks[i] = order[k]; });
  renumber(d);
  return { type, order: order.map((x: Json) => x.name), note: "First = bottom layer; later tracks draw on top." };
}

type Tool = { description: string; inputSchema: Json; run: (a: Args) => Json };
let built: Record<string, Tool> | undefined;
/** Built on first call: server.ts and this file import each other. */
/** Built-in blend modes: ids from CapCut.app/Contents/Resources/MixMode/MixMode.json (9.5.0); same ids in pyJianYingDraft. */
const BLEND: Record<string, [string, string, string, string]> = { // tool name: [UI name (es, as CapCut 9.5.0 writes it), effect_id, resource_id, MixMode/<folder>]
  screen: ["Pantalla", "871339", "6758325170760323597", "d9c1d4ca7ab91df4f48d12b339f2da88"], darken: ["Oscurecer", "871342", "6758324839670354445", "420c92a2b480dc8e402d9269a5f83515"],
  lighten: ["Iluminar", "871341", "6758324919789949453", "b0e90c43dc266a317b05b0cd3ca5bfba"], overlay: ["Superposición", "871340", "6758324989931295240", "e6a48579910dfe831ba53a6acc6737f9"],
  hard_light: ["Luz intensa", "871338", "6758325264670790152", "840ca85a1a33e6fc3ea78bbdb2db8f60"], soft_light: ["Luz tenue", "871337", "6758325439212556814", "042aa15b71b1e17bca0bd928eec6fba7"],
  linear_burn: ["Profundidad lineal", "871336", "6758325619253056013", "655f3590dd07ece41209fb312348ffe9"], color_burn: ["Profundidad del color", "871335", "6758325724848853518", "b76087cda4833f553cf09e82fb81c463"],
  color_dodge: ["Desvanecimiento del color", "871334", "6758325800031752712", "f979dd10def50fad3ffb77c7f0df3db7"], multiply: ["Multiplicar", "871333", "6758325895519277582", "8001e07eefc5d8b69572b977ca14bef9"],
};
const MIXMODE_DIR = "/Applications/CapCut.app/Contents/MacOS/../Resources/MixMode/"; // UI diff 9.5.0 (2026-10-04): effect_id = MixMode.json effectId (short), resource_id = resourceId, path = bundle folder

const refd = (l: Loaded, s: Json, key: string, pick: (m: Json) => boolean = () => true) =>
  (l.draft.materials[key] ??= []).find((m: Json) => s.extra_material_refs.includes(m.id) && pick(m));
const unref = (s: Json, id: string) => { s.extra_material_refs = s.extra_material_refs.filter((x: string) => x !== id); };

const DENOISE_MODEL = "/Applications/CapCut.app/Contents/MacOS/../Resources/audiosami/unet_denoise_44k_music_model_v1.0.model";
/** Basic adjust sliders (UI diff 9.5.0, all 15 on an adjustment layer): tool name -> [effects type, version, UI divisor].
 * value = UI / divisor: -50..50 sliders use 50, 0..100 sliders (sharpen, clarity, grain, fade) use 100. */
const ADJ: Record<string, [string, string, number]> = {
  exposure: ["brightness", "v2", 50], contrast: ["contrast", "v3", 50], saturation: ["saturation", "v1", 50], temperature: ["temperature", "v3", 50],
  tint: ["tone", "v3", 50], highlights: ["highlight", "v3", 50], shadows: ["shadow", "v3", 50], whites: ["white", "", 50], blacks: ["black", "", 50],
  brilliance: ["light_sensation", "", 50], vignette: ["vignetting", "v1", 50],
  sharpen: ["sharpen", "v1", 100], clarity: ["clear", "", 100], grain: ["particle", "v2", 100], fade: ["fade", "", 100],
};
const ADJ_ID = "7501974767453474064"; // built-in adjust bundle

/** Replace the segment's basic-adjust effects (one materials.effects[] per slider, ref on the segment). UI value 0 removes the slider. */
function setAdjust(l: Loaded, s: Json, v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`adjust must be an object like {exposure: 10, saturation: -20} (CapCut UI values); keys: ${Object.keys(ADJ).join(", ")}`);
  const d = l.draft, path = cachedEffect(l, ADJ_ID), out: string[] = [];
  for (const [k, ui] of Object.entries(v as Args)) {
    const [type, version, div] = ADJ[k] ?? fail(`Unknown adjust key ${k}; known: ${Object.keys(ADJ).join(", ")}`);
    const val = num({ [k]: ui }, k, div === 100 ? 0 : -50, div === 100 ? 100 : 50) / div, old = refd(l, s, "effects", (m) => m.type === type);
    if (old) { unref(s, old.id); d.materials.effects = d.materials.effects.filter((m: Json) => m !== old); }
    if (val === 0) continue;
    const id = randomUUID();
    d.materials.effects.push({ id, type, effect_id: ADJ_ID, resource_id: ADJ_ID, third_resource_id: "", name: "", sub_type: "none", path, value: val, visible: true, version,
      platform: "all", apply_target_type: 0, source_platform: 1, category_id: "", category_name: "", adjust_params: [], time_range: null, request_id: "",
      lumi_hub_path: path ? join(path, "lumi_hub_path") : "" });
    s.extra_material_refs.push(id); out.push(k);
  }
  return out;
}

/** LUT (UI diff 9.5.0): materials.effects[type=lut], adjust-bundle resource, path "<cube file>;<bundle folder>", value = intensity/100. */
function setLut(l: Loaded, s: Json, v: unknown): Json {
  const d = l.draft, old = refd(l, s, "effects", (m) => m.type === "lut");
  if (old) { unref(s, old.id); d.materials.effects = d.materials.effects.filter((m: Json) => m !== old); }
  if (v === null) return { lut: "removed" };
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("lut must be {path: \"/abs/file.cube\", intensity?: 0-100} or null to remove");
  const file = mediaFile(v as Args, "path");
  if (![".cube", ".3dl"].includes(extname(file).toLowerCase())) fail("lut path must be a .cube or .3dl file");
  const bundle = cachedEffect(l, ADJ_ID), id = randomUUID();
  d.materials.effects.push({ id, type: "lut", effect_id: ADJ_ID, resource_id: ADJ_ID, third_resource_id: "", name: basename(file), sub_type: "none",
    path: `${file};${bundle}`, value: num(v as Args, "intensity", 0, 100, 100) / 100, visible: true, version: "", platform: "all", apply_target_type: 0,
    source_platform: 1, category_id: "", category_name: "", adjust_params: [], time_range: null, request_id: "", lumi_hub_path: bundle ? join(bundle, "lumi_hub_path") : "" });
  s.extra_material_refs.push(id);
  s.enable_lut = true;
  const notes = [];
  if (!bundle) notes.push("CapCut's built-in adjust bundle (7501974767453474064) is not in the local cache: open the Ajustar panel once.");
  if (!/[\\/]Resources[\\/]Lut[\\/]/.test(file)) notes.push("CapCut keeps imported LUTs in <User Data>/Resources/Lut/<name>/; a LUT elsewhere must stay at this path (not verified that CapCut reads it).");
  return { lut: basename(file), ...(notes.length ? { lut_warning: notes.join(" ") } : {}) };
}

/** Scale and x/y on one video segment. Shared by capcut_set_clip and capcut_add_cuts. */
function writeClipTransform(s: Json, a: Args): string[] {
  if (!s.clip) fail("scale, x and y apply to video clips only");
  const done: string[] = [];
  if (a.scale !== undefined) { const v = num(a, "scale", 0.01, 50); s.clip.scale = { x: v, y: v }; s.uniform_scale = { on: true, value: v }; done.push("scale"); }
  if (a.x !== undefined || a.y !== undefined) { s.clip.transform = { x: num(a, "x", -10, 10, s.clip.transform.x), y: num(a, "y", -10, 10, s.clip.transform.y) }; done.push("position"); }
  return done;
}

function opSetClip(l: Loaded, a: Args): Json {
  const track = str(a, "track", 100);
  const t = l.draft.tracks.find((x: Json) => x.name === track && ["video", "audio"].includes(x.type)) ?? fail(`No video or audio track named "${track}"`);
  if (a.start_s === undefined) fail("start_s is required: it picks the segment");
  const [s] = segmentsOf(l, t.type, track, a), d = l.draft, fps = d.fps || 30, done: string[] = [];
  const visual = ["scale", "x", "y", "rotation", "alpha", "background", "blend_mode"].filter((k) => a[k] !== undefined);
  if (visual.length && t.type !== "video") fail(`${visual.join(", ")} apply to video tracks only`);
  if (a.adjust !== undefined && t.type !== "video") fail("adjust applies to video tracks only");
  if (a.scale !== undefined || a.x !== undefined || a.y !== undefined) done.push(...writeClipTransform(s, a));
  if (a.rotation !== undefined) { s.clip.rotation = num(a, "rotation", -360, 360); done.push("rotation"); }
  if (a.alpha !== undefined) { s.clip.alpha = num(a, "alpha", 0, 1); done.push("alpha"); }
  if (a.volume !== undefined && a.volume_db !== undefined) fail("Give volume or volume_db, not both");
  if (a.volume !== undefined) { s.volume = num(a, "volume", 0, 10); done.push("volume"); }
  if (a.volume_db !== undefined) { s.volume = dbToGain(num(a, "volume_db", -100, 20)); done.push("volume"); }
  if (a.background !== undefined) {
    const b = a.background as Args;
    if (!b || typeof b !== "object" || Array.isArray(b)) fail("background must be {type: color|blur, ...}");
    let c = refd(l, s, "canvases");
    if (!c) { c = { id: randomUUID(), album_image: "", image: "", image_id: "", image_name: "", source_platform: 0, team_id: "" }; d.materials.canvases.push(c); s.extra_material_refs.push(c.id); }
    if (b.type === "color") Object.assign(c, { type: "canvas_color", color: `${color(b, "color", "#000000")}ff`.toLowerCase(), blur: 0 }); // UI diff 9.5.0: lowercase #rrggbbaa
    else if (b.type === "blur") Object.assign(c, { type: "canvas_blur", blur: num(b, "blur", 0, 1, 0.375), color: "" });
    else fail("background.type must be color or blur");
    done.push("background");
  }
  if (a.blend_mode !== undefined) {
    const name = a.blend_mode as string, old = refd(l, s, "effects", (m) => m.type === "mix_mode");
    if (name !== "normal" && !BLEND[name]) fail(`blend_mode must be normal or one of ${Object.keys(BLEND).join(", ")}`);
    if (old) { unref(s, old.id); d.materials.effects = d.materials.effects.filter((m: Json) => m !== old); }
    if (name !== "normal") {
      const [uiName, effect_id, resource_id, folder] = BLEND[name], id = randomUUID();
      d.materials.effects.push({ id, effect_id, resource_id, third_resource_id: "", name: uiName, report_name: "", type: "mix_mode", sub_type: "none", path: MIXMODE_DIR + folder, value: 1, visible: true,
        item_effect_type: 0, category_id: "", category_name: "", platform: "all", apply_target_type: 0, source_platform: 0, version: "", adjust_params: [], time_range: null, request_id: "" });
      s.extra_material_refs.push(id);
    }
    done.push("blend_mode");
  }
  if (a.speed !== undefined) {
    retime(l, t, s, track, num(a, "speed", 0.1, 100), null);
    done.push("speed");
  }
  if (a.fade_in_s !== undefined || a.fade_out_s !== undefined) {
    const old = refd(l, s, "audio_fades");
    const fin = toUs(num(a, "fade_in_s", 0, 60, old ? old.fade_in_duration / US : 0), fps), fout = toUs(num(a, "fade_out_s", 0, 60, old ? old.fade_out_duration / US : 0), fps);
    if (fin + fout > s.target_timerange.duration) fail("fade_in_s + fade_out_s is longer than the clip");
    const v = t.type === "video" ? d.materials.videos.find((m: Json) => m.id === s.material_id) : null;
    writeAudioFade(l, s, fin, fout, v);
    done.push("fades");
  }
  if (a.denoise !== undefined) {
    const old = refd(l, s, "realtime_denoises");
    if (old) { unref(s, old.id); d.materials.realtime_denoises = d.materials.realtime_denoises.filter((m: Json) => m !== old); }
    if (bool(a, "denoise", false)) {
      const id = randomUUID();
      (d.materials.realtime_denoises ??= []).push({ id, type: "realtime_denoise", is_denoise: true, denoise_mode: 1, denoise_rate: num(a, "denoise_rate", 0, 1, 0.85),
        path: DENOISE_MODEL, sami_name: "denoise_v2", sami_version: "1.0", sami_type: 2, is_from_hd_sounds: false }); // local model shipped in CapCut.app, Pro feature in 9.5.0
      s.extra_material_refs.push(id);
    }
    done.push("denoise");
  }
  if (a.adjust !== undefined) { setAdjust(l, s, a.adjust); done.push("adjust"); }
  if (a.stabilize !== undefined) { // UI diff 9.5.0: 0 off, 1 Corte minimo, 2 Recomendado, 3 Mas estable; CapCut computes the motion itself (matrix_path stays "")
    if (t.type !== "video") fail("stabilize applies to video tracks only");
    const v = d.materials.videos.find((m: Json) => m.id === s.material_id) ?? fail("video segment without a video material");
    v.stable = { matrix_path: "", time_range: { start: 0, duration: 0 }, ...v.stable, stable_level: num(a, "stabilize", 0, 3) };
    if (!Number.isInteger(v.stable.stable_level)) fail("stabilize must be 0, 1, 2 or 3");
    done.push("stabilize");
  }
  if (a.audio_channel !== undefined) { // UI diff 9.5.0 "Completar canal": materials.sound_channel_mappings[].audio_channel_mapping
    const n = ["none", "left_to_right", "right_to_left"].indexOf(a.audio_channel as string);
    if (n < 0) fail("audio_channel must be none, left_to_right or right_to_left");
    let c = refd(l, s, "sound_channel_mappings");
    if (!c) { c = { id: randomUUID(), type: "none" }; (d.materials.sound_channel_mappings ??= []).push(c); s.extra_material_refs.push(c.id); }
    Object.assign(c, { audio_channel_mapping: n, is_config_open: n > 0 });
    done.push("audio_channel");
  }
  let maskOut: Json = {};
  if (a.mask !== undefined) { if (t.type !== "video") fail("mask applies to video tracks only"); maskOut = setMask(l, s, a.mask); done.push("mask"); }
  let lutOut: Json = {};
  if (a.lut !== undefined) { if (t.type !== "video") fail("lut applies to video tracks only"); lutOut = setLut(l, s, a.lut); done.push("lut"); }
  const colorKeys = ["flip", "crop", "curves", "color_wheels", "hsl"].filter((k) => a[k] !== undefined);
  if (colorKeys.length && t.type !== "video") fail(`${colorKeys.join(", ")} apply to video tracks only`);
  if (a.flip !== undefined) {
    const f = a.flip as Args;
    if (!f || typeof f !== "object" || Array.isArray(f)) fail("flip must be {horizontal?: bool, vertical?: bool}");
    s.clip.flip = { horizontal: bool(f, "horizontal", s.clip.flip?.horizontal ?? false), vertical: bool(f, "vertical", s.clip.flip?.vertical ?? false) };
    done.push("flip");
  }
  if (a.crop !== undefined) { setCrop(l, s, a.crop); done.push("crop"); }
  if (a.curves !== undefined) { setCurves(l, s, a.curves); done.push("curves"); }
  if (a.color_wheels !== undefined) { setWheels(l, s, a.color_wheels); done.push("color_wheels"); }
  if (a.hsl !== undefined) { setHsl(l, s, a.hsl); done.push("hsl"); }
  let vfOut: Json = {};
  if (a.voice_filter !== undefined) { const p = setVoiceFilter(l, s, t.type === "video", a.voice_filter); if (a.voice_filter !== null && !p) vfOut = pathNote(""); done.push("voice_filter"); }
  if (done.length === 0) fail("Nothing to change: give at least one setting");
  return { track, start_s: toS(s.target_timerange.start), duration_s: toS(s.target_timerange.duration), changed: done, ...lutOut, ...maskOut, ...vfOut };
}

/** Crop (materials.videos[].crop, 8 corner coords 0..1, y down; CapCut default = full frame). {left, top, right, bottom} = fraction cut from each side; null resets. */
function setCrop(l: Loaded, s: Json, v: unknown) {
  const m = l.draft.materials.videos.find((x: Json) => x.id === s.material_id) ?? fail("video segment without a video material");
  const c = v === null ? {} : v && typeof v === "object" && !Array.isArray(v) ? v as Args : fail("crop must be {left, top, right, bottom} (fractions 0..1) or null");
  for (const k of Object.keys(c)) if (!["left", "top", "right", "bottom"].includes(k)) fail(`Unknown crop field: ${k}`);
  const L = num(c, "left", 0, 1, 0), T = num(c, "top", 0, 1, 0), R = 1 - num(c, "right", 0, 1, 0), B = 1 - num(c, "bottom", 0, 1, 0);
  if (R - L < 0.01 || B - T < 0.01) fail("crop leaves nothing: left + right and top + bottom must stay below 1");
  m.crop = { upper_left_x: L, upper_left_y: T, upper_right_x: R, upper_right_y: T, lower_left_x: L, lower_left_y: B, lower_right_x: R, lower_right_y: B };
  m.crop_ratio = "free"; m.crop_scale = 1;
}

/** Curves (UI diff 9.5.0): Bezier handles from anchors. Inner point: +-(next - prev)/6; end point: half of (chord - neighbour handle). Reproduces the CapCut-saved sample. */
export function curveHandles(pts: number[][]): Json[] {
  const P = pts.map(([x, y]) => ({ x, y })), n = P.length, r = (v: number) => Math.round(v * 1e9) / 1e9;
  const m = P.map((_, i) => (i > 0 && i < n - 1 ? { x: (P[i + 1].x - P[i - 1].x) / 6, y: (P[i + 1].y - P[i - 1].y) / 6 } : null));
  return P.map((p, i) => {
    let lc = { ...p }, rc = { ...p };
    if (m[i]) { lc = { x: p.x - m[i]!.x, y: p.y - m[i]!.y }; rc = { x: p.x + m[i]!.x, y: p.y + m[i]!.y }; }
    else if (n > 1) {
      const q = i === 0 ? P[1] : P[n - 2], mq = (i === 0 ? m[1] : m[n - 2]) ?? { x: (q.x - p.x) / 3 * 2, y: (q.y - p.y) / 3 * 2 };
      const sign = i === 0 ? 1 : -1, d = { x: (q.x - p.x) * sign - mq.x, y: (q.y - p.y) * sign - mq.y };
      const h = { x: p.x + (sign * d.x) / 2, y: p.y + (sign * d.y) / 2 };
      if (i === 0) rc = h; else lc = h;
    }
    return { sync_direction_control: true, anchor: { x: r(p.x), y: r(p.y) }, left_control: { x: r(lc.x), y: r(lc.y) }, right_control: { x: r(rc.x), y: r(rc.y) } };
  });
}
function setCurves(l: Loaded, s: Json, v: unknown) {
  const d = l.draft, old = refd(l, s, "color_curves");
  if (old) { unref(s, old.id); d.materials.color_curves = d.materials.color_curves.filter((m: Json) => m !== old); }
  if (v === null) return;
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("curves must be {luma?|red?|green?|blue?: [[x, y], ...]} (0..1, x ascending) or null");
  const path = cachedEffect(l, ADJ_ID), mat: Json = { id: randomUUID(), type: "color_curves", panel: "adjust_collection", resource_id: ADJ_ID, source_platform: 1, path,
    luma: [], red: [], green: [], blue: [], lumi_hub_path: path ? join(path, "lumi_hub_path") : "", link_status: false, select_channel: 0 };
  for (const [k, raw] of Object.entries(v as Args)) {
    if (!["luma", "red", "green", "blue"].includes(k)) fail(`Unknown curves channel: ${k}`);
    const pts = Array.isArray(raw) && raw.length >= 2 && raw.length <= 16 ? raw as number[][] : fail(`curves.${k} needs 2-16 points [[x, y], ...]`);
    pts.forEach((p, i) => { if (!Array.isArray(p) || p.length !== 2 || p.some((q) => typeof q !== "number" || q < 0 || q > 1)) fail(`curves.${k}[${i}] must be [x, y] in 0..1`);
      if (i && p[0] <= pts[i - 1][0]) fail(`curves.${k}: x must ascend`); });
    mat[k] = curveHandles(pts);
  }
  (d.materials.color_curves ??= []).push(mat); s.extra_material_refs.push(mat.id); s.enable_color_curves = true;
}

/** Color wheels (UI diff 9.5.0, Pro): materials.primary_color_wheels[], raw draft values per wheel {red, green, blue, luma, saturation} (-1..1). */
function setWheels(l: Loaded, s: Json, v: unknown) {
  const d = l.draft, old = refd(l, s, "primary_color_wheels");
  if (old) { unref(s, old.id); d.materials.primary_color_wheels = d.materials.primary_color_wheels.filter((m: Json) => m !== old); }
  if (v === null) return;
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("color_wheels must be {lift?, gamma?, gain?, offset?, intensity?} or null");
  const w = v as Args, zero = () => ({ red: 0, green: 0, blue: 0, luma: 0, saturation: 0 }), path = cachedEffect(l, ADJ_ID);
  const mat: Json = { id: randomUUID(), type: "primary_color_wheels", panel: "adjust_collection", resource_id: ADJ_ID, path, lift: zero(), gamma: zero(), gain: zero(), offset: zero(),
    intensity: num(w, "intensity", 0, 1, 1), lumi_hub_path: path ? join(path, "lumi_hub_path") : "", source_platform: 1 };
  for (const [k, x] of Object.entries(w)) {
    if (k === "intensity") continue;
    if (!["lift", "gamma", "gain", "offset"].includes(k)) fail(`Unknown color_wheels field: ${k}`);
    const o = x && typeof x === "object" && !Array.isArray(x) ? x as Args : fail(`color_wheels.${k} must be {red, green, blue, luma, saturation}`);
    for (const c of Object.keys(o)) { if (!(c in mat[k])) fail(`Unknown color_wheels.${k} field: ${c}`); mat[k][c] = num(o, c, -1, 1); }
  }
  (d.materials.primary_color_wheels ??= []).push(mat); s.extra_material_refs.push(mat.id); s.enable_color_wheels = true;
}

/** HSL (UI diff 9.5.0, all 8 colours 2026-10-04): materials.hsl[] per colour, hue/saturation/lightness = UI -100..100. */
const HSL: Record<string, [number, string]> = { red: [1, "#FFE64444"], orange: [2, "#FFE69444"], yellow: [3, "#FFF2F224"], green: [4, "#FF45E644"],
  cyan: [5, "#FF45E6E6"], blue: [6, "#FF4595E6"], purple: [7, "#FF9545E6"], magenta: [8, "#FFE644E6"] };
function setHsl(l: Loaded, s: Json, v: unknown) {
  const d = l.draft;
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("hsl must be {red: {hue, saturation, lightness}} (UI -100..100)");
  for (const [k, x] of Object.entries(v as Args)) {
    const [type, custom] = HSL[k] ?? fail(`hsl colour must be one of ${Object.keys(HSL).join(", ")}`);
    const old = refd(l, s, "hsl", (m) => m.hsl_color_type === type);
    if (old) { unref(s, old.id); d.materials.hsl = d.materials.hsl.filter((m: Json) => m !== old); }
    if (x === null) continue;
    const o = x && typeof x === "object" && !Array.isArray(x) ? x as Args : fail(`hsl.${k} must be {hue, saturation, lightness}`);
    for (const c of Object.keys(o)) if (!["hue", "saturation", "lightness"].includes(c)) fail(`Unknown hsl.${k} field: ${c}`);
    const path = cachedEffect(l, ADJ_ID);
    const mat = { id: randomUUID(), constant_material_id: randomUUID().toUpperCase(), hsl_color_type: type, hue: num(o, "hue", -100, 100, 0), saturation: num(o, "saturation", -100, 100, 0),
      lightness: num(o, "lightness", -100, 100, 0), interacting: false, version: "1", path, type: "hsl", lumi_hub_path: path ? join(path, "lumi_hub_path") : "", custom_color: custom, resource_id: ADJ_ID, source_platform: 1 };
    (d.materials.hsl ??= []).push(mat); s.extra_material_refs.push(mat.id);
  }
  s.enable_hsl = true;
}

/** Built-in mask shapes, UI diff 9.5.0: [resource_id, cache folder id, resource_type, aspectRatio]. Text, brush and pen masks are not covered. */
const MASKS: Record<string, [string, string, string, number]> = {
  line: ["7374020197990011409", "1068046523", "line", 1], mirror: ["7374021024985125377", "1068046521", "mirror", 1],
  circle: ["7374021188315517456", "1068046525", "circle", 1], rectangle: ["7374021450748924432", "1068046526", "rectangle", 1],
  star: ["7665298069453279761", "4711700584", "pentagram", 1.0471014493], heart: ["7350964630979613186", "1068046520", "heart", 1.1148148148],
};

/** One mask per clip in materials.common_mask, referenced from the segment. UI diff 9.5.0 units: width/height = px / canvas size,
 * centerX/Y = px offset / (canvas size / 2), feather and roundCorner = UI % / 100, rotation in degrees. null removes it. */
function setMask(l: Loaded, s: Json, m: unknown): Json {
  const d = l.draft, old = refd(l, s, "common_mask");
  if (old) { unref(s, old.id); d.materials.common_mask = d.materials.common_mask.filter((x: Json) => x !== old); }
  if (m === null) return {};
  if (!m || typeof m !== "object" || Array.isArray(m)) fail("mask must be {shape, ...} or null");
  const a = m as Args;
  for (const k of Object.keys(a)) if (!["shape", "x", "y", "width", "height", "rotation", "feather", "round_corner", "invert"].includes(k)) fail(`Unknown mask field: ${k}`);
  const [resource_id, folder, resource_type, aspectRatio] = MASKS[a.shape as string] ?? fail(`mask.shape must be one of ${Object.keys(MASKS).join(", ")}`);
  const path = cachedEffect(l, folder), id = randomUUID();
  (d.materials.common_mask ??= []).push({ id, type: "mask", category: "video", category_name: "", category_id: "", panel: "", is_old_version: false, resource_id, constant_material_id: randomUUID().toUpperCase(),
    name: a.shape, resource_type, path, position_info: "",
    config: { width: num(a, "width", 0, 4, 0.28), height: resource_type === "line" ? 0 : num(a, "height", 0, 4, 0.5), centerX: num(a, "x", -2, 2, 0), centerY: num(a, "y", -2, 2, 0),
      rotation: num(a, "rotation", -360, 360, 0), feather: num(a, "feather", 0, 100, 0) / 100, expansion: 0, roundCorner: num(a, "round_corner", 0, 100, 0) / 100, invert: bool(a, "invert", false), aspectRatio },
    text_config: { content: "", font_name: "", font_path: "", font_resource_id: "", font_size: 15, bold_width: 0, italic_degree: 0, has_underline: false, line_gap: 0, char_spacing: 0, align_type: 15, scale: 1 },
    platform: "all", loader_work_space: "", track_segment: "", contour_path: null, source_platform: 0 });
  s.extra_material_refs.push(id);
  return path ? {} : { mask_note: `Mask shape not in the local cache (Cache/effect/${folder}); CapCut fetches it when the draft opens.` };
}

/** Keyframe property names as CapCut stores them in segment.common_keyframes[].property_type (per pyJianYingDraft). */
const KF: Record<string, [string, string[]]> = { // tool name: [property_type, track types]
  position_x: ["KFTypePositionX", ["video", "text"]], position_y: ["KFTypePositionY", ["video", "text"]], scale: ["UNIFORM_SCALE", ["video", "text"]],
  rotation: ["KFTypeRotation", ["video", "text"]], alpha: ["KFTypeAlpha", ["video"]], volume: ["KFTypeVolume", ["video", "audio"]],
  brightness: ["KFTypeBrightness", ["video"]], contrast: ["KFTypeContrast", ["video"]], saturation: ["KFTypeSaturation", ["video"]],
};

/** Replace the keyframe list of one property; points are [offset from segment start in us, value].
 * ease (UI diff 9.5.0, right-click a keyframe): curveType "FreeCurveInOut"; "in" (Aceleracion) puts right_control.x = 0.42 x gap on the start key,
 * "out" (Desaceleracion) left_control.x = -0.42 x gap on the end key; the end key gets a graphID listed in top-level keyframe_graph_list ("Curva"). */
function setKeyframes(s: Json, property_type: string, points: [number, number][], ease = "linear", draft?: Json) {
  const gone = new Set((s.common_keyframes ?? []).filter((k: Json) => k.property_type === property_type).flatMap((k: Json) => k.keyframe_list.map((p: Json) => p.graphID)).filter(Boolean));
  if (draft?.keyframe_graph_list && gone.size) draft.keyframe_graph_list = draft.keyframe_graph_list.filter((g: Json) => !gone.has(g.id));
  s.common_keyframes = (s.common_keyframes ?? []).filter((k: Json) => k.property_type !== property_type);
  const list = [...points].sort((p, q) => p[0] - q[0]).map(([time_offset, v]) => ({
    id: randomUUID(), curveType: ease === "linear" ? "Line" : "FreeCurveInOut", graphID: "", left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 }, time_offset, values: [v],
  }));
  if (ease !== "linear" && draft) {
    for (let i = 1; i < list.length; i++) {
      const c = Math.round(0.42 * (list[i].time_offset - list[i - 1].time_offset));
      if (ease !== "out") list[i - 1].right_control = { x: c, y: 0 };
      if (ease !== "in") list[i].left_control = { x: -c, y: 0 };
      list[i].graphID = randomUUID();
      (draft.keyframe_graph_list ??= []).push({ id: list[i].graphID, resource_id: "7418178875479298577", resource_name: "Curva", source_platform: 1, graph_points: [] });
    }
  }
  s.common_keyframes.push({ id: randomUUID(), material_id: "", property_type, keyframe_list: list });
}

function opKeyframes(l: Loaded, a: Args): Json {
  const track = str(a, "track", 100), prop = KF[a.property as string] ?? fail(`property must be one of ${Object.keys(KF).join(", ")}`);
  const t = l.draft.tracks.find((x: Json) => x.name === track) ?? fail(`No track named "${track}"`);
  if (!prop[1].includes(t.type)) fail(`${a.property} keyframes apply to ${prop[1].join("/")} tracks, not ${t.type}`);
  if (a.start_s === undefined) fail("start_s is required: it picks the segment");
  const [s] = segmentsOf(l, t.type, track, a), fps = l.draft.fps || 30, dur = s.target_timerange.duration;
  const pts = Array.isArray(a.points) && a.points.length ? a.points as Args[] : fail("points must be a non-empty list of {t_s, value}");
  if (pts.length > 1000) fail("at most 1000 points");
  const out = pts.map((p) => {
    const at = toUs(num(p, "t_s", 0, 86_400), fps);
    if (at > dur) fail(`t_s ${p.t_s} is not inside the segment (0-${toS(dur)}s)`);
    return [at, num(p, "value", -100, 100)] as [number, number];
  });
  const ease = (a.ease ?? "linear") as string;
  if (!["linear", "in", "out", "in_out"].includes(ease)) fail("ease must be linear, in, out or in_out");
  setKeyframes(s, prop[0], out, ease, l.draft);
  return { track, start_s: toS(s.target_timerange.start), property: a.property, property_type: prop[0], points: out.length, ease };
}

/** Merge SRT cues into speech ranges (gaps shorter than mergeS join). Seconds. */
export function speechRanges(cues: { start: number; end: number }[], mergeS: number): [number, number][] {
  const out: [number, number][] = [];
  for (const c of [...cues].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && c.start - last[1] < mergeS) last[1] = Math.max(last[1], c.end); else out.push([c.start, c.end]);
  }
  return out;
}

function opDuck(l: Loaded, a: Args): Json {
  if ((a.srt_path === undefined) === (a.srt_text === undefined)) fail("Give exactly one of srt_path or srt_text");
  const src = a.srt_path !== undefined ? readFileSync(mediaFile(a, "srt_path"), "utf8") : str(a, "srt_text", 5_000_000);
  const ranges = speechRanges(parseSrt(src), num(a, "merge_gap_s", 0, 10, 0.6));
  const track = str(a, "track", 100, "music"), under = num(a, "under", 0, 2, 0.1), ramp = num(a, "ramp_s", 0, 5, 0.25), off = num(a, "offset_s", -86_400, 86_400, 0);
  const t = l.draft.tracks.find((x: Json) => x.type === "audio" && x.name === track) ?? fail(`No audio track named "${track}"`);
  const fps = l.draft.fps || 30;
  for (const s of t.segments) {
    const free = num(a, "free", 0, 2, s.volume ?? 1), s0 = s.target_timerange.start, dur = s.target_timerange.duration;
    const pts: [number, number][] = [];
    const put = (sec: number, v: number) => {
      const at = Math.min(Math.max(toUs(sec + off, fps) - s0, 0), dur);
      if (pts.length && at <= pts[pts.length - 1][0]) { if (v === under) pts[pts.length - 1][1] = v; return; }
      pts.push([at, v]);
    };
    put(s0 / US - off, free);
    for (const [x, y] of ranges) { put(x - ramp, free); put(x, under); put(y, under); put(y + ramp, free); }
    s.volume = 1; // ponytail: level lives in the keyframes; whether CapCut multiplies them by segment volume is unverified
    setKeyframes(s, "KFTypeVolume", pts);
  }
  return { track, segments: t.segments.length, speech_ranges: ranges.length, under, ramp_s: ramp };
}

const srtTime = (us: number) => {
  const ms = Math.round(us / 1000), p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
/** SRT body. Cue ends are microseconds already on the frame grid. */
export function formatSrt(cues: { a: number; b: number; text: string }[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.a)} --> ${srtTime(c.b)}\n${c.text}\n`).join("\n");
}

/** Text template (Texto > Plantilla de texto): CapCut stores text_templates[] plus its own texts/effects/animations and the text
 *  segment points at the template (UI diff 9.5.0 sessions 2/3). Templates bundle several cached resources, so this tool copies one
 *  that CapCut already placed in a draft (same or another) to a new time, with fresh ids and optionally new text. */
export function opCopyTextTemplate(l: Loaded, a: Args): Json {
  const d = l.draft, fps = d.fps || 30;
  const srcL = a.from_draft === undefined || a.from_draft === a.draft ? l : load(draftDir(a.from_draft));
  const sd = srcL.draft, at = toUs(num(a, "from_start_s", 0, 86_400), fps), tol = US / fps / 2;
  const tpls = new Map<string, Json>((sd.materials.text_templates ?? []).map((m: Json) => [m.id, m]));
  const seg = sd.tracks.flatMap((t: Json) => t.type === "text" ? t.segments : []).find((s: Json) => tpls.has(s.material_id) && Math.abs(s.target_timerange.start - at) <= tol)
    ?? fail(`No text template segment starts at ${toS(at)}s in ${a.from_draft ?? a.draft}`);
  const tpl = tpls.get(seg.material_id);
  const byId = new Map<string, [string, Json]>();
  for (const [k, v] of Object.entries(sd.materials)) if (Array.isArray(v)) for (const m of v) if (m?.id) byId.set(m.id, [k, m]);
  const want = new Set<string>([...(seg.extra_material_refs ?? [])]);
  for (const r of tpl.text_info_resources ?? []) { want.add(r.text_material_id); for (const x of r.extra_material_refs ?? []) want.add(x); }
  const ids = [tpl.id, seg.id, ...[...want].filter((x) => byId.has(x)), ...(tpl.text_info_resources ?? []).map((r: Json) => r.id).filter(Boolean)];
  const map = new Map(ids.map((x) => [x, randomUUID().toUpperCase()]));
  let blob = JSON.stringify({ tpl, seg, mats: [...want].filter((x) => byId.has(x)).map((x) => byId.get(x)) });
  for (const [o, n] of map) blob = blob.split(o).join(n);
  const b = JSON.parse(blob);
  const dur = seg.target_timerange.duration;
  const [start] = span(num(a, "start_s", 0, 86_400), toS(dur), fps);
  const tname = a.track === undefined ? "text_templates" : str(a, "track", 200);
  const t = trackFor(d, "text", tname, start, dur);
  if (a.text !== undefined) {
    const text = str(a, "text", 500), tm = b.mats.find(([k, m]: [string, Json]) => k === "texts" && m.id === map.get(tpl.text_info_resources?.[0]?.text_material_id));
    if (!tm) fail("This template has no editable text");
    const c = JSON.parse(tm[1].content);
    c.text = text;
    for (const st of c.styles ?? []) st.range = [0, text.length];
    tm[1].content = JSON.stringify(c);
  }
  for (const [k, m] of b.mats) (d.materials[k] ??= []).push(m);
  (d.materials.text_templates ??= []).push(b.tpl);
  b.seg.target_timerange = { start, duration: dur };
  t.segments.push(b.seg);
  t.segments.sort((x: Json, y: Json) => x.target_timerange.start - y.target_timerange.start);
  d.duration = Math.max(d.duration ?? 0, endOf(d));
  return { template: tpl.name, resource_id: tpl.resource_id, track: tname, start_s: toS(start), duration_s: toS(dur), materials_copied: b.mats.length,
    ...(a.text !== undefined ? { text: a.text } : {}), note: "The template's cached resources must exist in this CapCut (they do when it came from a draft on this machine)." };
}

/** Map source-time cues through a cut list (kept ranges placed back to back). A cue across a cut becomes one cue from its
 *  first kept piece to its last; cues fully inside cuts, or under one frame after the cut, are dropped. Seconds. */
export function remapCues(cues: { start: number; end: number; text: string }[], map: { in_s: number; out_s: number; at_s: number }[], fps: number) {
  const out: { start: number; end: number; text: string }[] = [];
  let dropped = 0;
  for (const c of cues) {
    let s: number | undefined, e = 0;
    for (const m of map) {
      const x = Math.max(c.start, m.in_s), y = Math.min(c.end, m.out_s);
      if (y > x) { s ??= m.at_s + x - m.in_s; e = m.at_s + y - m.in_s; }
    }
    if (s === undefined || Math.round(e * fps) <= Math.round(s * fps)) dropped++; else out.push({ start: s, end: e, text: c.text });
  }
  return { cues: out, dropped };
}

type Kept = { x: number; y: number; xf?: Args };
const timeNum = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 86_400;

/** keep: [in_s, out_s] or {in_s, out_s, x?, y?, scale?}. cut: pairs only (the complement has no per-turn transform). */
function parseRanges(raw: unknown, key: string, fps: number): Kept[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2000) fail(`${key} must be a list of 1-2000 ranges`);
  return (raw as unknown[]).map((p) => {
    let inn: number, out: number, xf: Args | undefined;
    if (Array.isArray(p)) {
      if (p.length !== 2 || !p.every(timeNum)) fail(`each ${key} range is [in_s, out_s] in seconds`);
      [inn, out] = p as [number, number];
    } else if (p && typeof p === "object") {
      if (key === "cut") fail("cut ranges are [in_s, out_s] pairs; put x, y and scale on keep entries");
      const o = p as Args;
      for (const k of Object.keys(o)) if (!["in_s", "out_s", "x", "y", "scale"].includes(k)) fail(`Unknown keep field: ${k}`);
      inn = num(o, "in_s", 0, 86_400); out = num(o, "out_s", 0, 86_400);
      const t: Args = {};
      for (const k of ["x", "y", "scale"]) if (o[k] !== undefined) t[k] = o[k];
      if (Object.keys(t).length) xf = t;
    } else fail(`each ${key} range is [in_s, out_s] in seconds`);
    return { x: Math.round(inn! * fps), y: Math.round(out! * fps), xf };
  });
}

/** Batch cuts: keep ranges (or the complement of cut ranges) of one file, snapped to frames, placed back to back from start_s. */
function opCuts(l: Loaded, a: Args): Json {
  const fps = l.draft.fps || 30, src = mediaFile(a, "path");
  if ((a.keep === undefined) === (a.cut === undefined)) fail("Give exactly one of keep or cut");
  if (a.srt_out !== undefined && a.srt_path === undefined && a.srt_text === undefined) fail("srt_out needs srt_path or srt_text");
  const key = a.keep !== undefined ? "keep" : "cut";
  let r = parseRanges(a[key], key, fps);
  r.forEach(({ x, y }, i) => {
    if (y <= x) fail(`${key} range ${i + 1} is shorter than one frame after snapping to ${fps} fps`);
    if (i && x < r[i - 1].y) fail(`${key} ranges must be ascending and must not overlap (range ${i + 1})`);
  });
  if (key === "cut") {
    const len = a.media_duration_s !== undefined ? num(a, "media_duration_s", 0.001, 86_400) : probeMedia(src).duration_s ?? fail("cut needs the file length: give media_duration_s");
    const end = Math.floor(len * fps + 1e-6), keep: Kept[] = [];
    let at = 0;
    for (const { x, y } of r) { if (x > at) keep.push({ x: at, y: Math.min(x, end) }); at = Math.max(at, y); }
    if (at < end) keep.push({ x: at, y: end });
    r = keep.filter(({ x, y }) => y > x);
    if (!r.length) fail("cut removes the whole file");
  }
  const media: Args = { path: src, track: a.track, volume: a.volume, media_duration_s: a.media_duration_s };
  for (const k of Object.keys(media)) if (media[k] === undefined) delete media[k];
  let at = Math.round(num(a, "start_s", 0, 86_400, 0) * fps), kind = "";
  const map: { in_s: number; out_s: number; at_s: number }[] = [];
  for (const range of r) {
    const placed = opMedia(l, { ...media, in_s: range.x / fps, duration_s: (range.y - range.x) / fps, start_s: at / fps });
    kind = placed.kind;
    if (kind === "photo") fail("path must be a video or audio file");
    if (range.xf) {
      if (kind !== "video") fail("x, y and scale apply to video clips only");
      const [s] = segmentsOf(l, "video", placed.track, { start_s: placed.start_s });
      writeClipTransform(s, range.xf);
    }
    map.push({ in_s: toS(range.x / fps * US), out_s: toS(range.y / fps * US), at_s: toS(at / fps * US) });
    at += range.y - range.x;
  }
  const out: Json = { kind, track: a.track ?? (kind === "audio" ? "audio" : "main"), segments: r.length, start_s: map[0].at_s, end_s: toS(at / fps * US), time_map: map };
  if (a.srt_path !== undefined || a.srt_text !== undefined) {
    const { cues, dropped } = remapCues(readSrt(a), r.map(({ x, y }, i) => ({ in_s: x / fps, out_s: y / fps, at_s: map[i].at_s })), fps);
    if (a.srt_out !== undefined) {
      if (!cues.length) fail("srt_out: every cue is inside a cut or shorter than one frame");
      const body = formatSrt(cues.map((c) => {
        const start = toUs(c.start, fps);
        return { a: start, b: Math.max(toUs(c.end, fps), start + Math.round(US / fps)), text: c.text };
      }));
      const path = str(a, "srt_out", 4096);
      stageNewFile(l, path, ".srt", body, "srt_out");
      out.srt_out = { path, cues: cues.length, dropped_in_cuts: dropped, preview: body.slice(0, 500) };
    }
    if (bool(a, "place_subtitles", true)) {
      const sa: Args = { font_size: a.sub_font_size, color: a.sub_color, y: a.sub_y, track: a.sub_track };
      for (const k of Object.keys(CHUNK_PROPS)) sa[k] = a[k];
      for (const k of Object.keys(sa)) if (sa[k] === undefined) delete sa[k];
      out.subtitles = cues.length ? { ...placeCues(l, cues, sa), dropped_in_cuts: dropped } : { cues: 0, dropped_in_cuts: dropped };
    } else if (a.srt_out === undefined) out.captions = { cues: cues.length, dropped_in_cuts: dropped, placed: false };
  }
  return out;
}

/** Delete the segment at start_s; drop materials nothing else points at; ripple = pull later segments on that track left. */
function opRemove(l: Loaded, a: Args): Json {
  const d = l.draft, fps = d.fps || 30, tol = US / fps / 2, track = str(a, "track", 200), at = toUs(num(a, "start_s", 0, 86_400), fps);
  const type = a.type === undefined ? undefined : str(a, "type", 20);
  const hits = d.tracks.filter((t: Json) => t.name === track && (type === undefined || t.type === type))
    .flatMap((t: Json) => t.segments.filter((s: Json) => Math.abs(s.target_timerange.start - at) <= tol).map((s: Json) => [t, s]));
  if (hits.length === 0) fail(`No segment starts at ${toS(at)}s on a track named "${track}"`);
  if (hits.length > 1) fail(`Tracks of type ${hits.map(([t]: Json) => t.type).join(", ")} named "${track}" have a segment at ${toS(at)}s: give type`);
  const [t, seg] = hits[0], start = seg.target_timerange.start, dur = seg.target_timerange.duration;
  t.segments = t.segments.filter((x: Json) => x !== seg);
  let moved = 0;
  if (bool(a, "ripple", false)) for (const o of t.segments) if (o.target_timerange.start >= start + dur - tol) { o.target_timerange.start -= dur; moved++; }
  // ponytail: an id still written anywhere else in the draft keeps its material (string count); fine-grained ref tracking if this keeps too much
  const json = JSON.stringify({ tracks: d.tracks, materials: d.materials });
  let removed = 0;
  for (const id of [seg.material_id, ...(seg.extra_material_refs ?? [])]) for (const v of Object.values(d.materials)) {
    if (!Array.isArray(v)) continue;
    const i = v.findIndex((m: Json) => m?.id === id);
    if (i >= 0 && json.split(id).length === 2) { v.splice(i, 1); removed++; }
  }
  d.duration = endOf(d);
  return { track, type: t.type, removed: { start_s: toS(start), duration_s: toS(dur) }, ripple: bool(a, "ripple", false), segments_moved: moved, materials_removed: removed, duration_s: toS(d.duration) };
}

/** subdraft/<id>/{draft_content.json, sub_draft_config.json, draft_cover.jpg} next to a compound clip (CapCut 9.5.0 layout). */
function subdraftFiles(l: Loaded, dir: string, sub: Json, name: string, dur: number, cover = join(l.dir, "draft_cover.jpg")): void {
  const subId = sub.id;
  l.files = [...(l.files ?? []), [join(dir, "draft_content.json"), JSON.stringify(sub)], [join(dir, "sub_draft_config.json"), JSON.stringify({
    audio_path: "", cover_height: 180, cover_path: "draft_cover.jpg", cover_width: 320, create_time: Math.floor(Date.now() / 1000), draft_json_file: "draft_content.json", id: subId,
    import_time_ms: Date.now(), is_from_multi_timeline: false, is_from_sub_draft: true, name, project_id: subId, rough_cut_duration: dur, rough_cut_start: 0,
    source: "timeline", type: "video" })]];
  if (existsSync(cover)) l.copies.push([cover, join(dir, "draft_cover.jpg")]);
}

/** CapCut's saved elements ("Guardar elemento predefinido" > Tuyos > Mis elementos predefinidos) live outside the drafts. */
export const presetsRoot = () => resolve(process.env.CAPCUT_PRESETS_ROOT ?? join(process.env.HOME ?? "", "Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Presets/Combination"));

/** Insert a saved element: UI diff 9.5.0 session 8. CapCut adds a compound-clip segment whose videos[] material is named
 *  "<preset name>##<preset id>" (extra_type_option 2) and whose materials.drafts entry is a copy of the preset's compound. */
export function opInsertPreset(l: Loaded, a: Args): Json {
  const d = l.draft, fps = d.fps || 30;
  const name = str(a, "preset", 200);
  if (/[\\/]|\.\./.test(name)) fail("preset must be a preset name, not a path");
  const root = presetsRoot(), pdir = join(root, "Presets", name);
  const pfile = join(pdir, "preset_draft", "draft_content.json");
  if (!existsSync(pfile)) {
    const have = existsSync(join(root, "Presets")) ? readdirSync(join(root, "Presets")).filter((x) => existsSync(join(root, "Presets", x, "preset_draft"))) : [];
    fail(`No saved element "${name}" in ${join(root, "Presets")}. Available: ${have.join(", ") || "none"}`);
  }
  const info = existsSync(join(pdir, `${name}.json`)) ? JSON.parse(readFileSync(join(pdir, `${name}.json`), "utf8")) : {};
  const p = JSON.parse(readFileSync(pfile, "utf8").replace(/##_presetpath_placeholder_[0-9A-Za-z-]+_##/g, root.replace(/\\/g, "/")));
  const pseg = p.tracks?.find((t: Json) => t.type === "video")?.segments?.[0] ?? fail(`Saved element "${name}" has no video segment`);
  const pmat = p.materials.videos.find((v: Json) => v.id === pseg.material_id) ?? fail(`Saved element "${name}" is not a compound clip`);
  const pdrafts = new Map<string, Json>((p.materials.drafts ?? []).map((x: Json) => [x.id, x]));
  const comb = structuredClone(pseg.extra_material_refs.map((r: string) => pdrafts.get(r)).find(Boolean) ?? fail(`Saved element "${name}" has no compound draft`));
  const dur = pseg.target_timerange.duration;
  const [start] = span(num(a, "start_s", 0, 86_400), toS(dur), fps);
  const track = a.track === undefined ? undefined : str(a, "track", 200);
  const tname = track ?? d.tracks.find((t: Json) => t.type === "video")?.name ?? "main";
  const t = trackFor(d, "video", tname, start, dur);
  const subId = randomUUID().toUpperCase(), dir = join(l.dir, "subdraft", subId);
  Object.assign(comb.draft, { id: subId });
  Object.assign(comb, { id: randomUUID().toUpperCase(), combination_id: randomUUID().toUpperCase(),
    draft_file_path: join(dir, "draft_content.json"), draft_cover_path: join(dir, "draft_cover.jpg"), draft_config_path: join(dir, "sub_draft_config.json") });
  (d.materials.drafts ??= []).push(comb);
  const mat = { ...structuredClone(pmat), id: randomUUID().toUpperCase(), material_name: info.id ? `${name}##${info.id}` : name, extra_type_option: 2 };
  d.materials.videos.push(mat);
  const seg = { ...structuredClone(pseg), id: randomUUID().toUpperCase(), material_id: mat.id, target_timerange: { start, duration: dur },
    extra_material_refs: [comb.id, ...companions(d, true)], keyframe_refs: [], common_keyframes: [] };
  t.segments.push(seg);
  t.segments.sort((x: Json, y: Json) => x.target_timerange.start - y.target_timerange.start);
  d.duration = Math.max(d.duration ?? 0, endOf(d));
  subdraftFiles(l, dir, comb.draft, comb.draft.name ?? name, dur, join(pdir, `${name}.jpeg`));
  return { preset: name, preset_id: info.id ?? null, track: tname, start_s: toS(start), duration_s: toS(dur), subdraft: dir };
}

/** Compound clip (Crear clip combinado, Option+G), shape from UI diff 9.5.0 sessions 3, 4 and 8: the chosen segments move into an
 *  embedded draft (materials.drafts[type combination]) that is also written to subdraft/<id>/; the track gets one segment whose
 *  material is a videos[] entry with path '' and extra_type_option 2. */
export function opCompound(l: Loaded, a: Args): Json {
  const d = l.draft, fps = d.fps || 30, tol = US / fps / 2;
  const track = a.track === undefined || a.track === "" ? undefined : str(a, "track", 200); // CapCut's own main track is named ""
  const t = d.tracks.find((x: Json) => x.type === "video" && (track === undefined || x.name === track)) ?? fail(`No video track named "${track ?? ""}"`);
  const from = toUs(num(a, "start_s", 0, 86_400), fps), to = toUs(num(a, "end_s", 0, 86_400), fps);
  if (to <= from) fail("end_s must be after start_s");
  const pick = t.segments.filter((s: Json) => s.target_timerange.start >= from - tol && s.target_timerange.start + s.target_timerange.duration <= to + tol);
  if (pick.length === 0) fail(`No segment lies fully inside ${toS(from)}s-${toS(to)}s on video track "${track}"`);
  const subMats = new Set<string>((d.materials.drafts ?? []).map((m: Json) => m.id));
  if (pick.some((s: Json) => s.extra_material_refs?.some((r: string) => subMats.has(r)))) fail("A compound clip cannot contain another compound clip here; pick other segments");
  const start = Math.min(...pick.map((s: Json) => s.target_timerange.start));
  const dur = Math.max(...pick.map((s: Json) => s.target_timerange.start + s.target_timerange.duration)) - start;
  const used = new Set<string>(pick.flatMap((s: Json) => [s.material_id, ...(s.extra_material_refs ?? [])]));
  const rest = new Set<string>(d.tracks.flatMap((x: Json) => x.segments.filter((s: Json) => !pick.includes(s)).flatMap((s: Json) => [s.material_id, ...(s.extra_material_refs ?? [])])));
  const n = (d.config?.combination_max_index ?? 0) + 1, name = `Clip combinado${n}`;
  const subId = randomUUID().toUpperCase();
  const sub: Json = structuredClone({ ...d, materials: {}, tracks: [] });
  for (const [k, v] of Object.entries(d.materials)) sub.materials[k] = Array.isArray(v) ? structuredClone(v.filter((m: Json) => used.has(m?.id))) : structuredClone(v);
  sub.materials.drafts = [];
  sub.tracks = [{ ...structuredClone({ ...t, segments: [] }), id: randomUUID().toUpperCase(),
    segments: pick.map((s: Json) => ({ ...structuredClone(s), target_timerange: { ...s.target_timerange, start: s.target_timerange.start - start } })) }];
  Object.assign(sub, { id: subId, name, duration: dur, config: { ...structuredClone(d.config ?? {}), combination_max_index: n } });
  for (const [k, v] of Object.entries(d.materials)) if (Array.isArray(v)) d.materials[k] = v.filter((m: Json) => !used.has(m?.id) || rest.has(m.id));
  t.segments = t.segments.filter((s: Json) => !pick.includes(s));
  const dir = join(l.dir, "subdraft", subId), draftsId = randomUUID().toUpperCase(), matId = randomUUID().toUpperCase();
  (d.materials.drafts ??= []).push({ id: draftsId, type: "combination", name: "", category_id: "", category_name: "", formula_id: "",
    combination_id: randomUUID().toUpperCase(), combination_type: "none", aimusic_mv_template_info: null, precompile_combination: false, draft: sub,
    draft_file_path: join(dir, "draft_content.json"), draft_cover_path: join(dir, "draft_cover.jpg"), draft_config_path: join(dir, "sub_draft_config.json") });
  const { width, height } = d.canvas_config;
  d.materials.videos.push({ id: matId, type: "video", path: "", material_name: name, duration: dur, width, height, category_id: "", category_name: "",
    check_flag: 62978047, has_audio: false, stable: { matrix_path: "", stable_level: 0, time_range: { duration: 0, start: 0 } }, local_material_id: "", extra_type_option: 2, source_platform: 0, media_path: "", reverse_path: "", team_id: "",
    crop: { lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1, upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0 },
    crop_ratio: "free", crop_scale: 1 });
  const seg = segment(matId, start, dur, 0, [draftsId, ...companions(d, true)], pick[0].render_index ?? 0, false);
  if (pick[0].hdr_settings) seg.hdr_settings = { ...pick[0].hdr_settings };
  t.segments.push(seg);
  t.segments.sort((x: Json, y: Json) => x.target_timerange.start - y.target_timerange.start);
  (d.config ??= {}).combination_max_index = n;
  subdraftFiles(l, dir, sub, name, dur);
  return { track: t.name, name, start_s: toS(start), duration_s: toS(dur), segments_grouped: pick.length, subdraft: dir };
}

/** Fields capcut_style_text accepts, minus draft / track / start_s / dry_run. make_short passes the same object through. */
export const STYLE_PROPS: Json = {
  font_size: { type: "number", minimum: 1, maximum: 100 }, color: HEX, bold: { type: "boolean" }, italic: { type: "boolean" },
  font_path: { type: "string", description: "Absolute path of an installed .ttf/.otf font file." },
  stroke_color: HEX, stroke_width: { type: "number", minimum: 0, maximum: 100, description: "CapCut UI scale 0-100." },
  shadow: { type: "object", properties: { color: HEX, alpha: { type: "number" }, distance: { type: "number" }, angle: { type: "number" }, smoothing: { type: "number", description: "UI blur % 0-100." } }, additionalProperties: false },
  bg_color: HEX, bg_alpha: { type: "number", minimum: 0, maximum: 1 }, bg_style: { type: "integer", enum: [1, 2] }, bg_round_radius: { type: "number", minimum: 0, maximum: 1 },
  bg_width: { type: "number", minimum: 0, maximum: 1, description: "UI % / 100 (default 0.14)." }, bg_height: { type: "number", minimum: 0, maximum: 1, description: "UI % / 100 (default 0.14)." },
  bg_offset_x: { type: "number", minimum: -1, maximum: 1, description: "(UI % - 50) / 50; 0 is centred." }, bg_offset_y: { type: "number", minimum: -1, maximum: 1, description: "(UI % - 50) / 50; 0 is centred." },
  highlight: { type: "array", items: { type: "object", properties: { word: { type: "string" }, color: HEX }, required: ["word"] }, description: "Whole words to color, e.g. [{word:\"gratis\", color:\"#F8D508\"}]." },
  max_width: { type: "number", minimum: 0.1, maximum: 1, description: "Wrap width as a share of the canvas width." },
  alignment: { type: "string", enum: ["left", "center", "right"] },
  underline: { type: "boolean" }, letter_spacing: { type: "number", minimum: -100, maximum: 100, description: "CapCut 'Caracter' spacing (UI value; stored x0.05)." },
  line_spacing: { type: "number", minimum: -100, maximum: 100, description: "CapCut 'Linea' spacing (UI value; stored x0.05)." },
  glow: { type: ["object", "null"], description: "Text glow (Brillo): {style: neon (free) | rays (Pro), color '#RRGGBB', strength 0-100 (default 50), range 0-100 (default 40)}; null removes it." },
  bubble: { type: ["object", "null"], description: "Text bubble (Texto > Burbuja): {resource_id, third_resource_id} from verified_ids.text_bubbles in docs/capcut_features.json (240 free bubbles), e.g. {resource_id: \"7446995323060227333\", third_resource_id: \"6844049416047825415\"}; null removes it." },
  wordart: { type: ["string", "null"], pattern: "^[0-9]{6,25}$", description: "WordArt (Texto > Efectos) resource_id, already downloaded in CapCut; null removes it. Not combinable with stroke." },
};

/** Apply capcut_style_text fields to every segment on a text track. Rejects unknown keys. */
export function applyTextStyle(l: Loaded, track: string, style: unknown, label: string): Json {
  if (!style || typeof style !== "object" || Array.isArray(style)) fail(`${label} must be an object of capcut_style_text fields`);
  const o = style as Args;
  for (const k of Object.keys(o)) if (!(k in STYLE_PROPS)) fail(`Unknown ${label} field: ${k}`);
  if (!Object.keys(o).length) fail(`${label} needs at least one capcut_style_text field`);
  return opStyleText(l, { ...o, track });
}

export const featureTools = () => (built ??= {
  capcut_style_text: {
    description: "Style text already on a track (captions, titles): WordArt preset, stroke, shadow, background box, per-word highlight color, font file, bold/italic, size, color, wrap width, alignment. All segments on the track, or only the one at start_s. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, track: { type: "string", description: "Text track name (e.g. subtitles, text)." },
      start_s: { type: "number", minimum: 0, description: "Only the segment that starts here." },
      ...STYLE_PROPS, dry_run: DRY,
    }, ["draft", "track"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opStyleText(l, a) });
    },
  },
  capcut_compound_clip: {
    description: "Group the segments that lie fully inside start_s..end_s on one video track into a compound clip (Crear clip combinado), like Option+G in CapCut. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string", description: "Video track name (e.g. main); omitted = the first video track." }, start_s: { type: "number", minimum: 0 }, end_s: { type: "number", minimum: 0 }, dry_run: DRY },
      ["draft", "start_s", "end_s"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opCompound(l, a) });
    },
  },
  capcut_insert_preset: {
    description: "Insert one of CapCut's saved elements (right-click > Guardar elemento predefinido; Tuyos > Mis elementos predefinidos) as a compound clip at start_s. Reads the local preset store (CAPCUT_PRESETS_ROOT, default the CapCut Mac container). Dry-run by default.",
    inputSchema: T({ draft: DRAFT, preset: { type: "string", description: "Saved element name, e.g. \"Mis elementos predefinidos1\"." }, start_s: { type: "number", minimum: 0 },
      track: { type: "string", description: "Video track name; omitted = the first video track." }, dry_run: DRY }, ["draft", "preset", "start_s"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opInsertPreset(l, a) });
    },
  },
  capcut_copy_text_template: {
    description: "Copy a text template (Texto > Plantilla de texto) that CapCut already placed in a draft to a new time, in the same or another draft, with fresh ids and optionally new text. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, from_draft: { type: "string", description: "Draft that holds the template (default: the same draft)." },
      from_start_s: { type: "number", minimum: 0, description: "Start of the template segment to copy." }, start_s: { type: "number", minimum: 0 },
      text: { type: "string", description: "Replace the template's (first) text." }, track: { type: "string", description: "Text track name (default text_templates)." }, dry_run: DRY },
      ["draft", "from_start_s", "start_s"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opCopyTextTemplate(l, a) });
    },
  },
  capcut_set_clip: {
    description: "Change one clip (the segment at start_s on a track): video scale/position/rotation/opacity, canvas background (color or blur), blend mode, basic adjust, speed (constant), audio volume, fades and noise reduction, stabilization level, audio channel copy, shape mask, flip, crop, curves, color wheels (Pro), HSL (8 colours), voice filter (Pro). Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, track: { type: "string", description: "Track name (main, music, ...)." }, start_s: { type: "number", minimum: 0, description: "Start of the segment to change." },
      scale: { type: "number", minimum: 0.01, maximum: 50, description: "1 = fit (100%)." },
      x: { type: "number", description: "Horizontal position, 1 = half the canvas width to the right." }, y: { type: "number", description: "Vertical position, 1 = half the canvas height up." },
      rotation: { type: "number", minimum: -360, maximum: 360, description: "Degrees, clockwise." }, alpha: { type: "number", minimum: 0, maximum: 1 },
      background: { type: "object", description: "{type:\"color\", color:\"#RRGGBB\"} or {type:\"blur\", blur:0..1 (CapCut levels 0.0625, 0.375, 0.75, 1)}." },
      blend_mode: { type: "string", enum: ["normal", ...Object.keys(BLEND)] },
      speed: { type: "number", minimum: 0.1, maximum: 100, description: "Constant speed; the timeline length becomes source length / speed." },
      volume: { type: "number", minimum: 0, maximum: 10, description: "Linear gain: 1 = 0 dB, 0.1 = -20 dB, 10 = +20 dB (CapCut max)." },
      volume_db: { type: "number", minimum: -100, maximum: 20, description: "Same in dB as the CapCut volume panel; -60 or lower = mute." },
      fade_in_s: { type: "number", minimum: 0, maximum: 60, description: "Audio fade-in (audio clips and the sound of video clips)." }, fade_out_s: { type: "number", minimum: 0, maximum: 60 },
      denoise: { type: "boolean", description: "CapCut 'Reducir el ruido' (local model; Pro in CapCut 9.5.0). false removes it." }, denoise_rate: { type: "number", minimum: 0, maximum: 1, default: 0.85 },
      adjust: { type: "object", description: "Video basic adjust in CapCut UI values: exposure, contrast, saturation, temperature, tint, highlights, shadows, whites, blacks, brilliance, vignette (-50..50); sharpen, clarity, grain, fade (0..100). 0 removes the slider." },
      stabilize: { type: "integer", enum: [0, 1, 2, 3], description: "Video stabilization: 0 off, 1 minimum crop, 2 recommended, 3 most stable (Pro in CapCut 9.5)." },
      audio_channel: { type: "string", enum: ["none", "left_to_right", "right_to_left"], description: "Copy one audio channel onto the other (CapCut 'Completar canal')." },
      mask: { type: ["object", "null"], description: "{shape: line|mirror|circle|rectangle|star|heart, x, y (offset / half canvas, -1..1), width, height (fraction of canvas; defaults 0.28, 0.5), rotation (deg), feather, round_corner (UI 0-100), invert}. null removes." },
      lut: { type: ["object", "null"], description: "{path: absolute .cube/.3dl, intensity: 0-100 (default 100)}; null removes the LUT." },
      flip: { type: "object", description: "{horizontal?: bool, vertical?: bool} (mirror)." },
      crop: { type: ["object", "null"], description: "{left, top, right, bottom}: fraction cut from each side (0..1); null resets to the full frame." },
      curves: { type: ["object", "null"], description: "{luma?|red?|green?|blue?: [[x, y], ...]} 2-16 points in 0..1, x ascending, e.g. luma [[0,0],[0.58,0.73],[1,1]]; null removes." },
      color_wheels: { type: ["object", "null"], description: "Pro. {lift?|gamma?|gain?|offset?: {red, green, blue, luma, saturation} raw -1..1, intensity 0..1}; null removes." },
      voice_filter: { type: ["object", "null"], description: "CapCut voice filter (Filtros de voz, Pro in 9.5.0): {resource_id, name?, strength 0..1}, e.g. 7320193577613529602 = Dulce; null removes." },
      hsl: { type: "object", description: "{red|orange|yellow|green|cyan|blue|purple|magenta: {hue, saturation, lightness}} CapCut UI -100..100; {red: null} removes that colour." },
      dry_run: DRY,
    }, ["draft", "track", "start_s"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opSetClip(l, a) });
    },
  },
  capcut_add_keyframes: {
    description: "Animate one property of the segment at start_s: position_x/position_y (1 = half the canvas), scale (1 = 100%), rotation (degrees), alpha (0-1), volume (1 = original), brightness/contrast/saturation (-1..1). Easing linear (default), in, out or in_out (CapCut's Aceleracion / Desaceleracion / both). Replaces that property's keyframes. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, track: { type: "string" }, start_s: { type: "number", minimum: 0, description: "Start of the segment." },
      property: { type: "string", enum: Object.keys(KF) },
      points: { type: "array", items: { type: "object", properties: { t_s: { type: "number", description: "Seconds from the segment start." }, value: { type: "number" } }, required: ["t_s", "value"] } },
      ease: { type: "string", enum: ["linear", "in", "out", "in_out"], default: "linear" }, dry_run: DRY,
    }, ["draft", "track", "start_s", "property", "points"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opKeyframes(l, a) });
    },
  },
  capcut_duck_music: {
    description: "Lower the music under speech: reads SRT cues and writes volume keyframes on every segment of the music track (under = level during speech, free = level between lines, default the segment volume). Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, srt_path: { type: "string", description: "Absolute path of the voice .srt." }, srt_text: { type: "string" },
      track: { type: "string", default: "music" }, under: { type: "number", minimum: 0, maximum: 2, default: 0.1 },
      free: { type: "number", minimum: 0, maximum: 2 }, ramp_s: { type: "number", minimum: 0, maximum: 5, default: 0.25 },
      merge_gap_s: { type: "number", minimum: 0, maximum: 10, default: 0.6, description: "Pauses shorter than this stay ducked." },
      offset_s: { type: "number", default: 0, description: "Shift every cue (same as add_subtitles offset_s)." }, dry_run: DRY,
    }, ["draft"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opDuck(l, a) });
    },
  },
  capcut_export_srt: {
    description: "Write the cues of one text track (default subtitles) as an .srt file, e.g. for YouTube closed captions. Never overwrites. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string", default: "subtitles" }, out_path: { type: "string", description: "Absolute path of the new .srt file." }, dry_run: DRY }, ["draft", "out_path"]),
    run: (a) => {
      const l = load(draftDir(a.draft)), track = str(a, "track", 100, "subtitles"), out = str(a, "out_path", 4096);
      assertNewFile(out, ".srt");
      const t = l.draft.tracks.find((x: Json) => x.type === "text" && x.name === track) ?? fail(`No text track named "${track}"`);
      const mats = new Map(l.draft.materials.texts.map((m: Json) => [m.id, m]));
      const cues = [...t.segments].sort((x: Json, y: Json) => x.target_timerange.start - y.target_timerange.start).map((s: Json) => {
        const m: Json = mats.get(s.material_id);
        let text = ""; try { text = JSON.parse(m?.content ?? "{}").text ?? ""; } catch { /* unreadable content: empty cue */ }
        return { a: s.target_timerange.start, b: s.target_timerange.start + s.target_timerange.duration, text: text.trim() };
      }).filter((c) => c.text);
      const srt = formatSrt(cues);
      const plan = { draft: a.draft, track, cues: cues.length, would_write: [out] };
      if (dryRun(a)) return { dry_run: true, ...plan, preview: srt.slice(0, 500) };
      writeFileSync(out, srt, { encoding: "utf8", flag: "wx" }); // wx: fail if it appeared meanwhile
      return { dry_run: false, written: true, ...plan };
    },
  },
  capcut_export_chapters: {
    description: "Read timeline markers (time_marks from capcut_add_markers) and return a YouTube chapter list: HH:MM:SS Title. Times snap to the draft fps; the stamp is the second that contains that frame. Inserts 00:00:00 when no marker falls in the first second. Refuses a list YouTube will not use: fewer than 3 chapters, displayed times under 10 seconds apart (two markers in the same second count), or a last chapter shorter than 10 seconds against the draft duration. Optional out_path writes a .txt file and never overwrites. Dry-run by default when out_path is set.",
    inputSchema: T({
      draft: DRAFT,
      out_path: { type: "string", description: "Absolute path of a new .txt file, for example chapters.txt. Omit to return the text only." },
      zero_title: { type: "string", default: "Start", description: "Title for the inserted 00:00:00 line. YouTube requires a first chapter at 0:00." },
      dry_run: DRY,
    }, ["draft"]),
    run: (a) => {
      const l = load(draftDir(a.draft));
      const body = chaptersFromMarks(l, str(a, "zero_title", 200, "Start"));
      const plan = { draft: a.draft, fps: l.draft.fps || 30, ...body };
      if (a.out_path === undefined) return plan;
      const out = str(a, "out_path", 4096);
      assertNewFile(out, ".txt");
      if (dryRun(a)) return { dry_run: true, ...plan, would_write: [out] };
      writeFileSync(out, body.text, { encoding: "utf8", flag: "wx" });
      return { dry_run: false, written: true, ...plan, would_write: [out] };
    },
  },
  capcut_register_draft: {
    description: "Add or refresh this draft in CapCut's project list (root_meta_info.json, backed up first) with its current duration. Run after the last edit. CapCut must be closed. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, dry_run: DRY }, ["draft"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      const base = dirname(l.dir);
      const out = { draft: a.draft, index_file: join(base, INDEX), duration_s: toS(l.draft.duration ?? 0), would_write: [join(base, INDEX)] };
      if (dryRun(a)) return { dry_run: true, ...out };
      if (capcutRunning()) fail("CapCut is running. Quit CapCut first: it rewrites root_meta_info.json when it saves.");
      return { dry_run: false, written: true, ...out, index: registerIndex(base, l) };
    },
  },
  capcut_add_transition: {
    description: "Add (or replace) a transition on the cut after the video segment at start_s, by CapCut resource_id (e.g. 6724845717472416269 = Combinar, free). Duration up to half the shorter clip. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string", default: "main" }, start_s: { type: "number", minimum: 0, description: "Start of the clip before the cut." },
      resource_id: RID, name: { type: "string" }, duration_s: { type: "number", minimum: 0.1, default: 0.5 }, dry_run: DRY }, ["draft", "start_s", "resource_id"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opTransition(l, a) }); },
  },
  capcut_set_speed_curve: {
    description: "Speed curve on one video clip (the segment at start_s): a CapCut preset (montage, hero, bullet, jump_cut, flash_in, flash_out) or custom points [[x 0..1, speed 0.1..10], ...]; null goes back to 1x. Clip length = source / CapCut's average speed, snapped to frames. The Curva tab is marked Pro in CapCut 9.5 (cache ids are free); exporting may need Pro. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string", default: "main" }, start_s: { type: "number", minimum: 0 },
      curve: { type: ["string", "null"], enum: [...Object.keys(SPEED_CURVES), null] },
      points: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, description: "Custom curve: x from 0 to 1 increasing, y speed 0.1-10. Overrides the preset's points." }, dry_run: DRY },
      ["draft", "start_s"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opSpeedCurve(l, a) }); },
  },
  capcut_add_filter: {
    description: "Put a CapCut filter on one video clip (the segment at start_s) by resource_id, intensity 0-100 (e.g. 7668224318974823701 = Rollo vintage, free). Replaces the clip's filter. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string", default: "main" }, start_s: { type: "number", minimum: 0 }, resource_id: RID, name: { type: "string" },
      intensity: { type: "number", minimum: 0, maximum: 100, default: 100 }, dry_run: DRY }, ["draft", "start_s", "resource_id"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opFilter(l, a) }); },
  },
  capcut_add_animation: {
    description: "Add an in / out / loop (text, sticker) / group (combo) animation to the segment at start_s by resource_id (e.g. video in 6740868384637850120 = Zoom 1, text in 7210980292243231233 = Maquina de escribir). Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string" }, start_s: { type: "number", minimum: 0 }, kind: { type: "string", enum: ["in", "out", "loop", "group"] },
      resource_id: RID, name: { type: "string" }, duration_s: { type: "number", minimum: 0.1, description: "in/out length, loop period; group always spans the clip." }, dry_run: DRY },
      ["draft", "track", "start_s", "kind", "resource_id"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opAnimation(l, a) }); },
  },
  capcut_add_sticker: {
    description: "Add a CapCut sticker on a sticker track by resource_id (sticker_id), with position/scale/rotation. The sticker must have been added once in CapCut so it is in Cache/artistEffect. Animate it with capcut_add_animation. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, resource_id: RID, name: { type: "string" }, start_s: { type: "number", minimum: 0 }, duration_s: { type: "number", minimum: 0.1, default: 3 },
      x: { type: "number" }, y: { type: "number" }, scale: { type: "number", minimum: 0.01, maximum: 50, default: 1 }, rotation: { type: "number", minimum: -360, maximum: 360 },
      track: { type: "string", default: "stickers" }, dry_run: DRY }, ["draft", "resource_id", "start_s"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opSticker(l, a) }); },
  },
  capcut_add_effect: {
    description: "Add a CapCut video effect on an effect track over a time range: kind scene (video_effect) or body (face_effect, follows people), by resource_id (e.g. scene 7434872753355756048 = Grafiti de tiza, body 7688574067632377106 = Figura neon; both free). Dry-run by default.",
    inputSchema: T({ draft: DRAFT, kind: { type: "string", enum: ["scene", "body"], default: "scene" }, resource_id: RID, name: { type: "string" },
      start_s: { type: "number", minimum: 0 }, duration_s: { type: "number", minimum: 0.1, default: 3 }, track: { type: "string", default: "effects" },
      params: { type: "object", description: "Optional sliders 0-1, e.g. {effects_adjust_speed: 0.33, effects_adjust_intensity: 1}." }, dry_run: DRY }, ["draft", "resource_id", "start_s"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opEffect(l, a) }); },
  },
  capcut_add_adjustment_layer: {
    description: "Add an adjustment layer (CapCut 'Ajustar') over a time range, with optional basic adjust (same keys and UI values as capcut_set_clip adjust) and LUT. It affects every track below it. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, start_s: { type: "number", minimum: 0 }, duration_s: { type: "number", minimum: 0.1, default: 3 }, track: { type: "string", default: "adjust" },
      adjust: { type: "object" }, lut: { type: "object", description: "{path: absolute .cube/.3dl, intensity: 0-100}" }, dry_run: DRY }, ["draft", "start_s"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opAdjustLayer(l, a) }); },
  },
  capcut_reorder_track: {
    description: "Move a track up or down among the tracks of its type (layer order: position 0 = bottom). The main video track stays at 0. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, type: { type: "string", enum: ["video", "text", "sticker", "effect", "adjust", "audio"] }, name: { type: "string" },
      position: { type: "integer", minimum: 0 }, dry_run: DRY }, ["draft", "type", "name", "position"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opReorder(l, a) }); },
  },
  capcut_add_cuts: {
    description: "Batch cut list: place the keep ranges of one video/audio file (or everything except the cut ranges) back to back on a track from start_s, snapped to the draft's frame grid, and return the time map. A keep entry may be {in_s, out_s, x?, y?, scale?} so each speaker turn gets the same transform as capcut_set_clip. Optional source SRT is remapped through the cuts (cues in cuts dropped). srt_out writes that remapped SRT (frame-snapped, full cues, not the short cards) and never overwrites; dry-run by default. place_subtitles false skips burned-in captions. Re-chunking matches capcut_add_subtitles. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, path: { type: "string", description: "Absolute path of the source file." },
      keep: { type: "array", description: "Ranges to keep, ascending. [in_s, out_s] or {in_s, out_s, x?, y?, scale?} (x and y are -10..10 from centre, scale 0.01..50, same writer as capcut_set_clip)." },
      cut: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, description: "Or: [[in_s, out_s], ...] source ranges to remove, ascending." },
      start_s: { type: "number", minimum: 0, default: 0 }, track: { type: "string", description: "Default main (audio files: audio)." },
      volume: { type: "number", minimum: 0, maximum: 2, default: 1 }, media_duration_s: { type: "number", description: "Source length, if it cannot be read (MP3, MKV...)." },
      srt_path: { type: "string", description: "Absolute path of the source .srt (source times)." }, srt_text: { type: "string" },
      srt_out: { type: "string", description: "Absolute path of a new .srt for the remapped cues (YouTube CC). Never overwrites. Omit to skip the file. Dry-run until dry_run is false." },
      place_subtitles: { type: "boolean", default: true, description: "false: remap (and optionally write srt_out) without putting captions on the draft." },
      sub_track: { type: "string", default: "subtitles" }, sub_font_size: { type: "number", minimum: 1, maximum: 100, default: 8 }, sub_color: HEX,
      sub_y: { type: "number", minimum: -1, maximum: 1, default: -0.55 }, ...CHUNK_PROPS, dry_run: DRY,
    }, ["draft", "path"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opCuts(l, a), new_draft_duration_s: toS(l.draft.duration) }); },
  },
  capcut_remove_segment: {
    description: "Delete the segment that starts at start_s on a track (any type) and the materials only it used. ripple: true pulls the later segments of that track left to close the gap (other tracks do not move). Dry-run by default.",
    inputSchema: T({ draft: DRAFT, track: { type: "string" }, start_s: { type: "number", minimum: 0 }, type: { type: "string", enum: ["video", "audio", "text", "sticker", "effect", "adjust", "filter"], description: "Only if several tracks share the name." },
      ripple: { type: "boolean", default: false }, dry_run: DRY }, ["draft", "track", "start_s"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opRemove(l, a) }); },
  },
  capcut_add_markers: {
    description: "Add timeline markers (CapCut time marks), e.g. chapter points for a YouTube description: [{t_s, title, color}]. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, markers: { type: "array", items: { type: "object", properties: { t_s: { type: "number", minimum: 0 }, title: { type: "string" }, color: HEX }, required: ["t_s"] } }, dry_run: DRY }, ["draft", "markers"]),
    run: (a) => { const l = load(draftDir(a.draft)); assertWritable(l); return finish(l, a, { draft: a.draft, ...opMarkers(l, a) }); },
  },
});
