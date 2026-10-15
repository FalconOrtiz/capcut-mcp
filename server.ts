#!/usr/bin/env node
// capcut-mcp: zero-dependency stdio MCP server that reads and writes CapCut desktop
// draft folders on local disk. It never contacts CapCut servers and never decrypts drafts.
// Draft field shapes and the 8.7+/9.x layout rules are adapted from capcut-cli
// (MIT, (c) 2026 Rene Zander, https://github.com/renezander030/capcut-cli) and the
// shell-first recipe of capcut-shell-inject (MIT, (c) 2026 Zone Tome). See NOTICE.
// Run: node server.ts   (Node >= 22.18, native TypeScript type stripping)
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, copyFileSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { applyTextStyle, featureTools, STYLE_PROPS } from "./features.ts"; // v0.3 tools; circular import, so built on first use

export type Json = any; // ponytail: drafts are an undocumented, app-owned schema; typed loosely on purpose.
export type Args = Record<string, unknown>;

const VERSION = "0.3.0";
export const US = 1_000_000;
const PHOTO_US = 10_800 * US; // CapCut convention: stills carry a 3 h source duration.
const ROOT_FILES = ["draft_content.json", "draft_info.json"]; // Windows primary, macOS primary.
const TIMELINE_FILES = [...ROOT_FILES, "template-2.tmp"]; // template-2.tmp: plain mirror on 8.7+.
const META = "draft_meta_info.json";
export const INDEX = "root_meta_info.json";
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,99}$/u;
const EXT: Record<string, "video" | "photo" | "audio"> = {
  ".mp4": "video", ".mov": "video", ".m4v": "video", ".mkv": "video", ".webm": "video", ".avi": "video",
  ".jpg": "photo", ".jpeg": "photo", ".png": "photo", ".webp": "photo", ".bmp": "photo",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio", ".ogg": "audio",
};

export class UserError extends Error {}
export const fail = (msg: string): never => { throw new UserError(msg); };

// ---------- configuration and path confinement ----------

export function defaultDraftsRoot(platform = process.platform, env = process.env): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CapCut", "User Data", "Projects", "com.lveditor.draft");
  return join(homedir(), "Movies", "CapCut", "User Data", "Projects", "com.lveditor.draft");
}

/** Which app layout new drafts get: mac = draft_info.json only (CapCut/JianYing 6.0+ on macOS). */
function targetOs(): "mac" | "windows" {
  const v = process.env.CAPCUT_TARGET_OS;
  if (v === "mac" || v === "windows") return v;
  return process.platform === "darwin" ? "mac" : "windows";
}
const defaultFiles = () => (targetOs() === "mac" ? ["draft_info.json"] : [...ROOT_FILES]);

function root(): string {
  const r = process.env.CAPCUT_DRAFTS_ROOT || defaultDraftsRoot();
  if (!existsSync(r) || !statSync(r).isDirectory()) fail(`Drafts root does not exist: ${r}. Set CAPCUT_DRAFTS_ROOT.`);
  return realpathSync(r);
}

function exportRoot(): string {
  const r = process.env.CAPCUT_EXPORT_ROOT;
  if (!r) fail("CAPCUT_EXPORT_ROOT is not set. Set it to the CapCut drafts folder that export may write into.");
  if (!existsSync(r!) || !statSync(r!).isDirectory()) fail(`Export root does not exist: ${r}`);
  return realpathSync(r!);
}

export function checkName(v: unknown, field: string): string {
  if (typeof v !== "string" || !NAME_RE.test(v) || v.includes("..")) {
    fail(`${field} must be a folder name: 1-100 letters, digits, space, _ . - (no path separators, no "..")`);
  }
  return v as string;
}

/** Resolve a draft folder name inside a root; reject anything that escapes it (incl. symlinks). */
export function draftDir(name: unknown, base = root(), mustExist = true): string {
  const dir = join(base, checkName(name, "draft"));
  if (!existsSync(dir)) { if (mustExist) fail(`Draft not found: ${name}`); return dir; }
  const real = realpathSync(dir);
  if (dirname(real) !== base) fail(`Draft path escapes the drafts root: ${name}`);
  return real;
}

/**
 * CapCut autosaves the drafts it knows and rewrites root_meta_info.json, so those writes need the app closed.
 * A draft it never opened (no Timelines/, not in its project list) is safe to write while it runs.
 */
export function mustQuitCapCut(dir: string, isNew: boolean, writesIndex: boolean): boolean {
  if (writesIndex) return true;
  if (isNew) return false;
  if (existsSync(join(dir, "Timelines"))) return true;
  try {
    const idx = JSON.parse(readFileSync(join(dirname(dir), INDEX), "utf8").replace(/^\uFEFF/, ""));
    return Object.values(idx).some((v) => Array.isArray(v) && v.some((e: Json) => e?.draft_fold_path === dir));
  } catch { return false; } // no index or not plain JSON: CapCut does not list it
}

export function capcutRunning(): boolean {
  if (process.env.CAPCUT_ALLOW_RUNNING === "1") return false;
  try {
    if (process.platform === "darwin") { execFileSync("pgrep", ["-x", "CapCut"], { stdio: "ignore" }); return true; }
    if (process.platform === "win32") return execFileSync("tasklist", ["/FI", "IMAGENAME eq CapCut.exe"], { encoding: "utf8" }).includes("CapCut.exe");
  } catch { /* pgrep exits 1 when nothing matches */ }
  return false;
}

// ---------- argument validation ----------

function allowOnly(args: Args, schema: Json) {
  for (const k of Object.keys(args)) if (!(k in schema.properties)) fail(`Unknown argument: ${k}`);
  for (const k of schema.required ?? []) if (args[k] === undefined) fail(`Missing argument: ${k}`);
}
export function num(args: Args, k: string, min: number, max: number, def?: number): number {
  const v = args[k] ?? def;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(`${k} must be a number in [${min}, ${max}]`);
  return v as number;
}
export function str(args: Args, k: string, maxLen: number, def?: string): string {
  const v = args[k] ?? def;
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) fail(`${k} must be a non-empty string (max ${maxLen} chars)`);
  return v as string;
}
export function bool(args: Args, k: string, def: boolean): boolean {
  const v = args[k] ?? def;
  if (typeof v !== "boolean") fail(`${k} must be true or false`);
  return v as boolean;
}
export function color(args: Args, k: string, def: string): string {
  const v = str(args, k, 7, def);
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) fail(`${k} must be #RRGGBB`);
  return v.toUpperCase();
}
export function mediaFile(args: Args, k: string): string {
  const p = str(args, k, 4096);
  if (!isAbsolute(p)) fail(`${k} must be an absolute path`);
  if (!existsSync(p) || !statSync(p).isFile()) fail(`${k} does not exist or is not a file: ${p}`);
  return realpathSync(p);
}
export const dryRun = (a: Args) => bool(a, "dry_run", true);

// ---------- media probe (MP4/MOV/M4A boxes and WAV headers; no ffprobe needed) ----------

export function probeMedia(file: string): { duration_s?: number; width?: number; height?: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const rd = (pos: number, len: number) => { const b = Buffer.alloc(len); return b.subarray(0, readSync(fd, b, 0, len, pos)); };
    const head = rd(0, 12);
    if (head.length < 12) return {};
    if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE") {
      let pos = 12, byteRate = 0;
      while (pos + 8 <= size) {
        const h = rd(pos, 8), id = h.toString("latin1", 0, 4), len = h.readUInt32LE(4);
        if (id === "fmt ") byteRate = rd(pos + 8, 16).readUInt32LE(8);
        if (id === "data") return byteRate ? { duration_s: Math.min(len, size - pos - 8) / byteRate } : {};
        pos += 8 + len + (len & 1);
      }
      return {};
    }
    if (!["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(head.toString("latin1", 4, 8))) return {};
    let pos = 0;
    while (pos + 8 <= size) {
      const h = rd(pos, 16);
      let len = h.readUInt32BE(0), hdr = 8;
      if (len === 1 && h.length >= 16) { len = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr) break;
      if (h.toString("latin1", 4, 8) === "moov") return len > 64_000_000 ? {} : parseMoov(rd(pos + hdr, len - hdr));
      pos += len;
    }
    return {};
  } finally { closeSync(fd); }
}

function parseMoov(b: Buffer) {
  const out: { duration_s?: number; width?: number; height?: number } = {};
  const boxes = (buf: Buffer, cb: (type: string, body: Buffer) => void) => {
    let p = 0;
    while (p + 8 <= buf.length) {
      let len = buf.readUInt32BE(p), hdr = 8;
      if (len === 1 && p + 16 <= buf.length) { len = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (len === 0) len = buf.length - p;
      if (len < hdr || p + len > buf.length) break;
      cb(buf.toString("latin1", p + 4, p + 8), buf.subarray(p + hdr, p + len));
      p += len;
    }
  };
  boxes(b, (type, body) => {
    if (type === "mvhd" && body.length >= 32) {
      const v1 = body[0] === 1, ts = body.readUInt32BE(v1 ? 20 : 12);
      const d = v1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
      if (ts) out.duration_s = d / ts;
    }
    if (type === "trak") boxes(body, (t, tk) => {
      const o = tk[0] === 1 ? 12 : 0;
      if (t !== "tkhd" || tk.length < 84 + o) return;
      const w = tk.readUInt32BE(76 + o) / 65536, h = tk.readUInt32BE(80 + o) / 65536;
      const rot = tk.readInt32BE(40 + o) === 0 && tk.readInt32BE(44 + o) !== 0; // 90/270 degree matrix (phone video)
      if (w > 0 && h > 0 && w * h > (out.width ?? 0) * (out.height ?? 0)) { out.width = Math.round(rot ? h : w); out.height = Math.round(rot ? w : h); }
    });
  });
  return out;
}

// ---------- draft I/O ----------

function isEncrypted(file: string): boolean {
  const head = readFileSync(file).subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return !head.startsWith("{");
}

function readJson(file: string): Json {
  if (isEncrypted(file)) fail(`${basename(file)} is not plain JSON (encrypted or binary). This tool does not decrypt drafts.`);
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

interface Target { file: string; id: string | undefined } // path relative to the draft folder; each document keeps its own id
export interface Loaded {
  dir: string; draft: Json; meta: Json | null; targets: Target[];
  source: string; blocked?: string; isNew?: boolean;
  copies: [string, string][]; sidecars: [string, string][]; index?: { base: string }; files?: [string, string][];
  createFiles?: [string, string][]; // new files that must not already exist (wx); listed in would_write
}

/**
 * Read a draft. CapCut 8.7+/9.x keeps the live timeline in Timelines/<main_timeline_id>/
 * (pointer: Timelines/project.json) with root mirrors; that nested document is read first and
 * every plain copy (nested + root + template-2.tmp) is a write target, so the app sees one timeline.
 */
export function load(dir: string): Loaded {
  const plain = (rel: string) => existsSync(join(dir, rel)) && statSync(join(dir, rel)).isFile() && !isEncrypted(join(dir, rel));
  const mains = ROOT_FILES.filter((f) => existsSync(join(dir, f)));
  let nested: string[] = [], blocked: string | undefined;
  if (existsSync(join(dir, "Timelines"))) {
    try {
      const p = readJson(join(dir, "Timelines", "project.json"));
      const id = p.main_timeline_id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("no main_timeline_id");
      const found = TIMELINE_FILES.map((f) => join("Timelines", id, f)).filter((r) => existsSync(join(dir, r)));
      if (found.length === 0) throw new Error("no nested timeline document");
      if (found.some((r) => !plain(r))) blocked = "The nested timeline is encrypted; refusing to write.";
      nested = found.filter(plain);
    } catch (e) {
      blocked = `This draft has a Timelines/ folder but no readable active timeline (${(e as Error).message}); root edits would be ignored. Create a new draft instead.`;
    }
  }
  if (mains.length === 0 && nested.length === 0) fail(`No draft_content.json or draft_info.json in ${basename(dir)}`);
  const rootPlain = TIMELINE_FILES.filter(plain);
  const mainsPlain = rootPlain.filter((f) => ROOT_FILES.includes(f));
  if (mainsPlain.length === 0 && nested.length === 0) readJson(join(dir, mains[0])); // throws the "does not decrypt" error
  const newest = (xs: string[]) => [...xs].sort((x, y) => statSync(join(dir, y)).mtimeMs - statSync(join(dir, x)).mtimeMs)[0];
  const source = nested.find((r) => ROOT_FILES.includes(basename(r))) ?? nested[0] ?? newest(mainsPlain);
  const draft = readJson(join(dir, source));
  const targets = [...nested, ...rootPlain].map((file) => ({ file, id: (file === source ? draft : readJson(join(dir, file))).id }));
  if (mains.some((f) => !rootPlain.includes(f))) blocked ??= "A root timeline file is encrypted; refusing to write.";
  const meta = existsSync(join(dir, META)) ? readJson(join(dir, META)) : null;
  return { dir, draft, meta, targets, source, blocked, copies: [], sidecars: [] };
}

export function assertWritable(l: Loaded) { if (l.blocked) fail(l.blocked); }

/** CapCut 9.x rewrites media paths inside the draft as "##_draftpath_placeholder_<uuid>_##/assets/..." on save. */
export const localPath = (dir: string, p: string) => p.replace(/^##_draftpath_placeholder_[0-9A-Za-z-]+_##/, dir);
const PRIVATE = new Set(["device_id", "hard_disk_id", "mac_address"]); // machine identifiers CapCut stores in platform
const publicPlatform = (p: Json) => (p && typeof p === "object" ? Object.fromEntries(Object.entries(p).filter(([k]) => !PRIVATE.has(k))) : null);

export function atomicWrite(file: string, data: string, backup = true) {
  if (backup && existsSync(file)) copyFileSync(file, `${file}.bak`); // one-step undo for every overwrite
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

function save(l: Loaded, backup = true) {
  for (const t of l.targets) atomicWrite(join(l.dir, t.file), JSON.stringify({ ...l.draft, id: t.id ?? l.draft.id }), backup);
  if (l.meta) {
    l.meta.tm_duration = l.draft.duration;
    l.meta.tm_draft_modified = Date.now() * 1000;
    atomicWrite(join(l.dir, META), JSON.stringify(l.meta), backup);
  }
}

/** Every file a real write touches; shown in every plan. */
function wouldWrite(l: Loaded): string[] {
  return [...l.targets.map((t) => join(l.dir, t.file)), ...(l.meta ? [join(l.dir, META)] : []),
    ...l.sidecars.map(([, d]) => d), ...(l.files ?? []).map(([f]) => f), ...l.copies.filter(([, d]) => !existsSync(d)).map(([, d]) => d),
    ...(l.createFiles ?? []).map(([f]) => f), ...(l.index ? [join(l.index.base, INDEX)] : [])];
}

/** Absolute new file: the parent folder must exist, and the file must not. Same rules as capcut_export_chapters out_path. */
export function assertNewFile(file: string, ext: string, label = "out_path") {
  if (!isAbsolute(file) || extname(file).toLowerCase() !== ext) fail(`${label} must be an absolute path ending in ${ext}`);
  if (existsSync(file)) fail(`${label} already exists: ${file}`);
  if (!existsSync(dirname(file))) fail(`Folder does not exist: ${dirname(file)}`);
}

/** Queue a new file on the draft write. Dry-run lists it in would_write and does not create it. */
export function stageNewFile(l: Loaded, file: string, ext: string, data: string, label = "out_path") {
  assertNewFile(file, ext, label);
  (l.createFiles ??= []).push([file, data]);
}

/** Dry-run returns the plan; a real write creates the folder, copies media, writes JSON, then the index. */
export function finish(l: Loaded, a: Args, plan: Json): Json {
  const out = { ...plan, would_write: wouldWrite(l) };
  if (dryRun(a)) return { dry_run: true, ...out };
  if (mustQuitCapCut(l.dir, !!l.isNew, !!l.index) && capcutRunning()) fail("CapCut is running and knows this draft (or the project list is written). Quit CapCut (Cmd+Q / close it) first: it overwrites these files when it saves.");
  if (l.isNew) mkdirSync(l.dir); // fails if it appeared meanwhile
  for (const [s, d] of l.sidecars) cpSync(s, d, { recursive: true, errorOnExist: true, force: false });
  for (const [s, d] of l.copies) if (!existsSync(d)) { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d); }
  for (const [f, data] of l.files ?? []) { mkdirSync(dirname(f), { recursive: true }); atomicWrite(f, data, false); }
  save(l, !l.isNew);
  for (const [f, data] of l.createFiles ?? []) {
    try { writeFileSync(f, data, { encoding: "utf8", flag: "wx" }); }
    catch (e) { fail(`Could not write ${f}: ${(e as Error).message}`); }
  }
  const index = l.index ? registerIndex(l.index.base, l) : undefined;
  return { dry_run: false, written: true, ...out, ...(index ? { index } : {}) };
}

// ---------- root_meta_info.json (CapCut's project list) ----------

/** Add or refresh this draft's entry in root_meta_info.json. Backs the file up first; never drops other entries. */
export function registerIndex(base: string, l: Loaded): Json {
  const file = join(base, INDEX), now = Date.now() * 1000;
  const ident = {
    draft_fold_path: l.dir, draft_id: l.meta?.draft_id ?? l.draft.id, draft_json_file: join(l.dir, (l.targets.find((t) => !t.file.includes(sep)) ?? l.targets[0]).file),
    draft_name: l.meta?.draft_name ?? l.draft.name, draft_root_path: base, tm_draft_modified: now, tm_draft_removed: 0, tm_duration: l.draft.duration ?? 0,
  };
  const fresh = { draft_cover: "draft_cover.jpg", draft_is_ai_shorts: false, draft_is_invisible: false, draft_new_version: "",
    draft_timeline_materials_size: 0, tm_draft_create: now, ...ident };
  if (!existsSync(file)) { atomicWrite(file, JSON.stringify({ all_draft_store: [fresh] }), false); return { file, action: "created" }; }
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let idx: Json;
  try { idx = JSON.parse(raw); } catch { return { file, action: "skipped", reason: "root_meta_info.json is not plain JSON; left untouched" }; }
  const key = Object.keys(idx).find((k) => Array.isArray(idx[k]) && idx[k].some((e: Json) => e && typeof e === "object" && "draft_fold_path" in e)) ?? "all_draft_store";
  const store: Json[] = Array.isArray(idx[key]) ? idx[key] : (idx[key] = []);
  const backup = `${file}.capcut-mcp-${Date.now()}.bak`;
  writeFileSync(backup, raw, "utf8");
  const hit = store.find((e) => e?.draft_fold_path === l.dir);
  if (hit) Object.assign(hit, ident);
  else store.push(store[0] && typeof store[0] === "object" ? { ...structuredClone(store[0]), ...fresh } : fresh);
  atomicWrite(file, JSON.stringify(idx), false);
  return { file, action: hit ? "updated" : "appended", backup };
}

// ---------- draft model helpers ----------

export const toUs = (s: number, fps: number) => Math.round(Math.round(s * fps) * (US / fps)); // snap to frame grid (CapCut does this on open)
export const durUs = (s: number, fps: number) => Math.max(toUs(s, fps), Math.round(US / fps)); // at least one frame
/** Snap start and end (not start and length) to frames, so back-to-back ranges stay back to back (3.75 s at 30 fps). */
export const span = (startS: number, durS: number, fps: number) => { const s = toUs(startS, fps); return [s, Math.max(toUs(startS + durS, fps) - s, Math.round(US / fps))]; };
export const toS = (us: number) => Math.round(us / 1000) / 1000;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const ratio = (w: number, h: number) => `${w / gcd(w, h)}:${h / gcd(w, h)}`;
const vtuple = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
const newer = (a: string, b: string) => { const x = vtuple(a), y = vtuple(b); for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };

const MATERIAL_KEYS = ["videos", "audios", "texts", "speeds", "placeholder_infos", "sound_channel_mappings",
  "vocal_separations", "canvases", "material_colors", "audio_fades", "stickers", "video_effects", "transitions", "material_animations"];

function emptyDraft(id: string, name: string, w: number, h: number, fps: number): Json {
  return {
    id, name, duration: 0, fps, create_time: Math.floor(Date.now() / 1000), update_time: Math.floor(Date.now() / 1000),
    canvas_config: { width: w, height: h, ratio: ratio(w, h) },
    tracks: [], materials: Object.fromEntries(MATERIAL_KEYS.map((k) => [k, []])),
    extra_info: { created_via: "capcut-mcp" }, free_render_index_mode_on: false,
  };
}

/** Empty skeleton from an app-made project: keep its version markers and settings, drop its content (capcut-cli seed rule). */
function seedSkeleton(donor: Json, id: string, name: string, w: number, h: number, fps: number): Json {
  const s = structuredClone(donor);
  for (const [k, v] of Object.entries(s)) {
    if ((k === "materials" || k === "keyframes") && v && typeof v === "object" && !Array.isArray(v)) {
      for (const sub of Object.keys(v as Json)) if (Array.isArray((v as Json)[sub])) (v as Json)[sub] = [];
    } else if (["cover", "retouch_cover", "time_marks"].includes(k)) s[k] = null;
    else if (Array.isArray(v)) s[k] = [];
  }
  s.materials ??= {};
  for (const k of MATERIAL_KEYS) if (!Array.isArray(s.materials[k])) s.materials[k] = [];
  const now = Math.floor(Date.now() / 1000);
  Object.assign(s, { id, name, duration: 0, fps, canvas_config: { ...(s.canvas_config ?? {}), width: w, height: h, ratio: ratio(w, h) } });
  if (typeof s.static_cover_image_path === "string") s.static_cover_image_path = "";
  if (typeof s.create_time === "number") s.create_time = now;
  if (typeof s.update_time === "number") s.update_time = now;
  return s;
}

function metaFor(dir: string, base: string, id: string, name: string, jsonFile: string, template?: Json): Json {
  const now = Date.now() * 1000;
  const groups = Array.isArray(template?.draft_materials) && template.draft_materials.length
    ? template.draft_materials.map((g: Json) => ({ ...g, value: [] })) : [{ type: 0, value: [] }];
  return {
    ...(template ?? {}),
    draft_cover: template?.draft_cover ?? "draft_cover.jpg",
    draft_fold_path: dir, draft_id: id, draft_name: name, draft_root_path: base, draft_json_file: join(dir, jsonFile),
    draft_materials: groups, draft_is_invisible: false, draft_new_version: template?.draft_new_version ?? "",
    tm_draft_create: now, tm_draft_modified: now, tm_draft_removed: 0, tm_duration: 0,
  };
}

/** Newest app-made project in the root (has Timelines/ and a plain timeline with platform.app_version). */
function findTemplate(base: string): { folder: string; app_version: string } | null {
  let best: { folder: string; app_version: string; mtime: number } | null = null;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || !existsSync(join(base, e.name, "Timelines"))) continue;
    try {
      const v = load(join(base, e.name)).draft.platform?.app_version;
      if (typeof v !== "string" || !v) continue;
      const mtime = statSync(join(base, e.name)).mtimeMs;
      if (!best || newer(v, best.app_version) || (v === best.app_version && mtime > best.mtime)) best = { folder: e.name, app_version: v, mtime };
    } catch { /* unreadable or encrypted: not a usable template */ }
  }
  return best && { folder: best.folder, app_version: best.app_version };
}

export function companions(draft: Json, withCanvas: boolean): string[] {
  const add = (key: string, m: Json) => { (draft.materials[key] ??= []).push(m); return m.id; };
  const ids = [
    add("speeds", { id: randomUUID(), type: "speed", speed: 1, mode: 0, curve_speed: null }),
    add("placeholder_infos", { id: randomUUID(), type: "placeholder_info", error_path: "", error_text: "", meta_type: "none", res_path: "", res_text: "" }),
    add("sound_channel_mappings", { id: randomUUID(), type: "none", audio_channel_mapping: 0, is_config_open: false }),
    add("vocal_separations", { id: randomUUID(), type: "vocal_separation", choice: 0, enter_from: "", final_algorithm: "", production_path: "", removed_sounds: [], time_range: null }),
  ];
  if (withCanvas) {
    ids.push(add("canvases", { id: randomUUID(), type: "canvas_color", album_image: "", blur: 0, color: "", image: "", image_id: "", image_name: "", source_platform: 0, team_id: "" }));
    ids.push(add("material_colors", { id: randomUUID(), type: "material_color", gradient_angle: 90, gradient_colors: [], gradient_percents: [], height: 0, is_color_clip: false, is_gradient: false, solid_color: "", width: 0 }));
  }
  return ids;
}

/** Audio fade on a segment (UI diff 9.5.0). Video materials also store a copy on videos[].audio_fade. */
export function writeAudioFade(l: Loaded, s: Json, fin: number, fout: number, video?: Json | null): Json {
  const fades = (l.draft.materials.audio_fades ??= []);
  let fade = fades.find((m: Json) => s.extra_material_refs.includes(m.id));
  if (fade) Object.assign(fade, { fade_in_duration: fin, fade_out_duration: fout });
  else {
    fade = { id: randomUUID(), type: "audio_fade", fade_in_duration: fin, fade_out_duration: fout, fade_type: 0 };
    fades.push(fade);
    s.extra_material_refs.push(fade.id);
  }
  if (video) video.audio_fade = { ...fade };
  return fade;
}

export function segment(materialId: string, start: number, dur: number, srcStart: number, refs: string[], renderIndex: number, audio: boolean, volume = 1, x = 0, y = 0): Json {
  return {
    id: randomUUID(), material_id: materialId,
    target_timerange: { start, duration: dur }, source_timerange: { start: srcStart, duration: dur },
    speed: 1, volume, visible: true, reverse: false,
    clip: audio ? null : { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x, y }, flip: { horizontal: false, vertical: false } },
    uniform_scale: audio ? null : { on: true, value: 1 },
    render_index: renderIndex, track_render_index: 0, track_attribute: 0,
    extra_material_refs: refs, common_keyframes: [], keyframe_refs: [],
  };
}

/** Find or create the named track; refuse overlaps so CapCut does not silently clip segments. */
export function trackFor(draft: Json, type: string, name: string, start: number, dur: number): Json {
  let t = draft.tracks.find((x: Json) => x.type === type && x.name === name);
  if (!t) { t = { id: randomUUID(), type, name, attribute: 0, flag: 0, is_default_name: false, segments: [] }; draft.tracks.push(t); }
  for (const s of t.segments) {
    const a = s.target_timerange.start, b = a + s.target_timerange.duration;
    if (start < b && start + dur > a) fail(`Overlaps an existing segment on ${type} track "${name}" (${toS(a)}s-${toS(b)}s). Use another track name or start time.`);
  }
  return t;
}

export const endOf = (draft: Json) => Math.max(0, ...draft.tracks.flatMap((t: Json) => t.segments.map((s: Json) => s.target_timerange.start + s.target_timerange.duration)));
const segCount = (draft: Json) => (draft.tracks ?? []).reduce((n: number, t: Json) => n + (t.segments?.length ?? 0), 0);

function registerMedia(meta: Json | null, path: string, kind: string, durUs: number, w: number, h: number): string {
  if (!meta) return "";
  let g = (meta.draft_materials ??= []).find((x: Json) => x.type === 0);
  if (!g) { g = { type: 0, value: [] }; meta.draft_materials.unshift(g); }
  const hit = g.value.find((e: Json) => e.file_Path === path);
  if (hit) return hit.id;
  const e = {
    ai_group_type: "", create_time: -1, duration: durUs, enter_from: 0, extra_info: basename(path), file_Path: path,
    height: kind === "music" ? 0 : h, width: kind === "music" ? 0 : w, id: randomUUID(), import_time: -1, import_time_ms: -1,
    item_source: 1, md5: "", metetype: kind, roughcut_time_range: { duration: -1, start: -1 }, sub_time_range: { duration: -1, start: -1 }, type: 0,
  };
  g.value.push(e);
  return e.id;
}

function textContent(text: string, size: number, hex: string): string {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return JSON.stringify({
    text,
    styles: [{ range: [0, text.length], size, bold: false, italic: false, underline: false, // UTF-16 code units, as JS length
      fill: { alpha: 1, content: { render_type: "solid", solid: { alpha: 1, color: rgb } } } }],
  });
}

function addTextSeg(draft: Json, text: string, start: number, dur: number, size: number, hex: string, x: number, y: number, track: string) {
  const t = trackFor(draft, "text", track, start, dur);
  const id = randomUUID();
  draft.materials.texts.push({
    id, type: "text", content: textContent(text, size, hex), alignment: 1, font_size: size, text_color: hex,
    typesetting: 0, letter_spacing: 0, line_spacing: 0.02, line_feed: 1, line_max_width: 0.82,
    force_apply_line_max_width: false, check_flag: 7, fixed_width: -1, fixed_height: -1,
  });
  t.segments.push(segment(id, start, dur, 0, companions(draft, false), 15000, false, 1, x, y));
}

export function parseSrt(src: string): { start: number; end: number; text: string }[] {
  const ts = (h: string, m: string, s: string, ms: string) => ((+h * 60 + +m) * 60 + +s) + +ms.padEnd(3, "0") / 1000;
  const out: { start: number; end: number; text: string }[] = [];
  for (const block of src.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const m = lines[i].match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) fail(`Bad SRT timing line: ${lines[i]}`);
    const [, a, b, c, d, e, f, g, h] = m!;
    const cue = { start: ts(a, b, c, d), end: ts(e, f, g, h), text: lines.slice(i + 1).join("\n").trim() };
    if (cue.end <= cue.start) fail(`SRT cue ends before it starts: ${lines[i]}`);
    if (cue.text) out.push(cue);
  }
  if (out.length === 0) fail("SRT has no cues");
  return out;
}

type Cue = { start: number; end: number; text: string };
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Split cues into short cards (max words / chars, punch words alone). Each cue's time is shared by letters (or words);
 *  boundaries land on the fps frame grid, back to back. A cue too short for one frame per card stays whole. */
export function chunkCues(cues: Cue[], o: { maxWords?: number; maxChars?: number; by?: "chars" | "words"; upper?: boolean; punch?: string[] }, fps: number): Cue[] {
  const punch = new Set((o.punch ?? []).map(bare)), out: Cue[] = [];
  for (const c of cues) {
    const text = o.upper ? c.text.toUpperCase() : c.text, cards: { w: string[]; p: boolean }[] = [];
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const cur = cards[cards.length - 1], p = punch.has(bare(w));
      if (cur && !cur.p && !p && (!o.maxWords || cur.w.length < o.maxWords) && (!o.maxChars || [...cur.w, w].join(" ").length <= o.maxChars)) cur.w.push(w);
      else cards.push({ w: [w], p });
    }
    const f0 = Math.round(c.start * fps), f1 = Math.round(c.end * fps);
    if (cards.length < 2 || f1 - f0 < cards.length) { out.push({ ...c, text }); continue; }
    const weight = cards.map(({ w }) => (o.by === "words" ? w.length : Math.max(1, w.join("").length)));
    const total = weight.reduce((x, y) => x + y, 0);
    let prev = f0, cum = 0;
    cards.forEach(({ w }, i) => {
      cum += weight[i];
      const b = i === cards.length - 1 ? f1 : Math.min(Math.max(Math.round(f0 + ((f1 - f0) * cum) / total), prev + 1), f1 - (cards.length - 1 - i));
      out.push({ start: prev / fps, end: b / fps, text: w.join(" ") });
      prev = b;
    });
  }
  return out;
}

export function summarize(l: Loaded) {
  const draft = l.draft, mats: Record<string, Json> = {};
  for (const k of ["videos", "audios", "texts"]) for (const m of draft.materials?.[k] ?? []) mats[m.id] = m;
  return {
    name: l.meta?.draft_name || draft.name, id: draft.id, fps: draft.fps, duration_s: toS(draft.duration ?? 0),
    canvas: draft.canvas_config, app: publicPlatform(draft.platform), timeline_file: l.source,
    write_targets: l.targets.map((t) => t.file), writable: !l.blocked, ...(l.blocked ? { blocked: l.blocked } : {}),
    tracks: (draft.tracks ?? []).map((t: Json) => ({
      type: t.type, name: t.name ?? "",
      segments: (t.segments ?? []).map((s: Json) => {
        const m = mats[s.material_id];
        let text: string | undefined;
        if (m?.type === "text") { try { text = JSON.parse(m.content).text; } catch { text = undefined; } }
        return { start_s: toS(s.target_timerange.start), duration_s: toS(s.target_timerange.duration), kind: m?.type ?? "other", path: m?.path && localPath(l.dir, m.path), text, volume: s.volume };
      }),
    })),
  };
}

// ---------- operations (mutate a Loaded in memory; finish() writes) ----------

function opCreate(base: string, a: Args): { l: Loaded; plan: Json } {
  const name = checkName(a.name, "name");
  const w = num(a, "width", 144, 7680, 1080), h = num(a, "height", 144, 7680, 1920), fps = num(a, "fps", 24, 60, 30);
  if (![24, 25, 30, 50, 60].includes(fps) || !Number.isInteger(w) || !Number.isInteger(h)) fail("width/height must be integers; fps one of 24, 25, 30, 50, 60");
  const dir = draftDir(name, base, false);
  if (existsSync(dir)) fail(`Draft already exists: ${name}`);
  const id = randomUUID().toUpperCase();
  let tname = a.template_draft === undefined ? "auto" : str(a, "template_draft", 100), warning: string | undefined;
  let tbase = base;
  if (tname === "auto") {
    const extra = process.env.CAPCUT_TEMPLATE_ROOT;
    let found = findTemplate(base);
    if (!found && extra && existsSync(extra)) { tbase = realpathSync(extra); found = findTemplate(tbase); }
    tname = found?.folder ?? "none";
    if (!found) warning = "No CapCut-made project found in the drafts root to copy version markers from. CapCut 9.x may refuse this draft (\"unusual path\"). Fix: create an empty project in CapCut, quit CapCut, and run again (or fill that project with capcut_make_short draft=<its name>).";
  }
  let draft = emptyDraft(id, name, w, h, fps), files = defaultFiles(), meta: Json, sidecars: [string, string][] = [], app = null;
  if (tname !== "none") {
    const t = load(draftDir(tname, tbase));
    app = t.draft.platform?.app_version ?? null;
    draft = seedSkeleton(t.draft, id, name, w, h, fps);
    const rootTimelines = t.targets.map((x) => x.file).filter((f) => !f.includes(sep) && !f.includes("/"));
    if (rootTimelines.length) files = rootTimelines;
    meta = metaFor(dir, base, id, name, files[0], t.meta ?? undefined);
    // Copy the app's per-project sidecars; never Timelines/, attachment/patch/mini_draft.json, timeline_layout.json,
    // subdraft/ (they carry the donor's timeline id), key_value.json (donor's session ids), cover, backups.
    const skip = new Set(["Timelines", "attachment", "key_value.json", "timeline_layout.json", "subdraft", "attachment_pc_common.json", META, INDEX, ".DS_Store", "assets", ...TIMELINE_FILES]);
    sidecars = readdirSync(t.dir).filter((n) => !skip.has(n) && !/\.(bak|jpe?g|png)$|\.tmp-\d+$|^\._/i.test(n)).map((n) => [join(t.dir, n), join(dir, n)]);
  } else meta = metaFor(dir, base, id, name, files[0]);
  const l: Loaded = { dir, draft, meta, targets: files.map((file) => ({ file, id })), source: files[0], isNew: true, copies: [], sidecars };
  return { l, plan: { draft: name, path: dir, canvas: draft.canvas_config, fps, template: tname === "none" ? null : tname, template_app_version: app, layout: files, ...(warning ? { warning } : {}) } };
}

export function opMedia(l: Loaded, a: Args, only?: "audio"): Json {
  const src = mediaFile(a, "path");
  const kind = EXT[extname(src).toLowerCase()] ?? fail(`Unsupported file type: ${extname(src)}. Allowed: ${Object.keys(EXT).join(" ")}`);
  if (only && kind !== only) fail(`path must be an audio file (${Object.keys(EXT).filter((e) => EXT[e] === "audio").join(" ")})`);
  const d = l.draft, fps = d.fps || 30;
  const probe = kind === "photo" ? {} : probeMedia(src);
  const inS = num(a, "in_s", 0, 86_400, 0);
  const mediaS = kind === "photo" ? PHOTO_US / US : a.media_duration_s !== undefined ? num(a, "media_duration_s", 0.001, 86_400) : probe.duration_s;
  if (a.duration_s === undefined && mediaS === undefined) fail("duration_s is required: the file length could not be read (give duration_s or media_duration_s)");
  const want = a.duration_s !== undefined ? num(a, "duration_s", 0.001, 86_400) : mediaS! - inS;
  if (want <= 0) fail("in_s is at or after the end of the file");
  const [start, dur] = span(num(a, "start_s", 0, 86_400, 0), want, fps);
  const mediaUs = Math.round((mediaS ?? inS + toS(dur)) * US);
  if (Math.round(inS * US) + dur > mediaUs + Math.round(US / fps)) fail(`in_s + duration_s (${toS(Math.round(inS * US) + dur)}s) is longer than the file (${toS(mediaUs)}s)`);
  const w = num(a, "width", 16, 16384, probe.width ?? d.canvas_config.width), h = num(a, "height", 16, 16384, probe.height ?? d.canvas_config.height);
  const vol = num(a, "volume", 0, 2, 1);
  const fin = toUs(num(a, "fade_in_s", 0, 60, 0), fps), fout = toUs(num(a, "fade_out_s", 0, 60, 0), fps);
  if (fin + fout > dur) fail("fade_in_s + fade_out_s is longer than the clip");
  const track = a.track === undefined ? (kind === "audio" ? (only ? "music" : "audio") : "main") : checkName(a.track, "track");
  const dest = join(l.dir, "assets", kind === "audio" ? "audio" : "video", basename(src));
  const queued = l.copies.find(([, x]) => x === dest);
  // ponytail: same name + same size is treated as the same file; hash it if collisions show up.
  if ((queued && queued[0] !== src) || (existsSync(dest) && statSync(dest).size !== statSync(src).size)) fail(`A different file named ${basename(src)} is already in this draft's assets`);
  const t = trackFor(d, kind === "audio" ? "audio" : "video", track, start, dur);
  const matId = randomUUID();
  const localId = registerMedia(l.meta, dest, kind === "audio" ? "music" : kind, mediaUs, w, h);
  const refs = companions(d, kind !== "audio");
  let video: Json = null;
  if (kind === "audio") {
    d.materials.audios.push({ id: matId, type: "extract_music", name: basename(src), path: dest, duration: mediaUs, music_id: "",
      category_id: "", category_name: "local", source_platform: 0, wave_points: [], local_material_id: localId, check_flag: 1 });
  } else {
    video = {
      id: matId, type: kind, path: dest, material_name: basename(src), duration: mediaUs, width: w, height: h,
      category_id: "", category_name: "local", check_flag: 7, has_audio: kind === "video", local_material_id: localId,
      crop: { lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1, upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0 },
      crop_ratio: "free", crop_scale: 1, extra_type_option: 0, source_platform: 0, media_path: "", reverse_path: "", team_id: "",
      stable: { matrix_path: "", stable_level: 0, time_range: { duration: 0, start: 0 } },
      video_algorithm: { algorithms: [], deflicker: null, motion_blur_config: null, noise_reduction: null, path: "", quality_enhance: null, time_range: null },
    };
    d.materials.videos.push(video);
  }
  const seg = segment(matId, start, dur, Math.round(inS * US), refs, kind === "audio" ? 0 : 14000, kind === "audio", vol);
  t.segments.push(seg);
  if (fin || fout) writeAudioFade(l, seg, fin, fout, video);
  d.duration = Math.max(d.duration ?? 0, endOf(d));
  if (!queued) l.copies.push([src, dest]);
  return { kind, track, start_s: toS(start), duration_s: toS(dur), in_s: inS, source_length_s: toS(mediaUs), size: kind === "audio" ? null : { width: w, height: h },
    volume: vol, ...(fin || fout ? { fade_in_s: toS(fin), fade_out_s: toS(fout) } : {}), copy: { from: src, to: dest } };
}

function opText(l: Loaded, a: Args): Json {
  const fps = l.draft.fps || 30;
  const [start, dur] = span(num(a, "start_s", 0, 86_400), num(a, "duration_s", 0.001, 86_400), fps);
  const track = checkName(a.track ?? "text", "track"), text = str(a, "text", 500);
  addTextSeg(l.draft, text, start, dur, num(a, "font_size", 1, 100, 12), color(a, "color", "#FFFFFF"), num(a, "x", -1, 1, 0), num(a, "y", -1, 1, 0.6), track);
  l.draft.duration = Math.max(l.draft.duration ?? 0, endOf(l.draft));
  return { track, text, start_s: toS(start), duration_s: toS(dur) };
}

export function readSrt(a: Args): Cue[] {
  if ((a.srt_path === undefined) === (a.srt_text === undefined)) fail("Give exactly one of srt_path or srt_text");
  if (a.srt_text !== undefined) return parseSrt(str(a, "srt_text", 5_000_000));
  const p = mediaFile(a, "srt_path");
  if (extname(p).toLowerCase() !== ".srt") fail("srt_path must end in .srt");
  if (statSync(p).size > 5_000_000) fail("SRT file is larger than 5 MB");
  return parseSrt(readFileSync(p, "utf8"));
}

const CHUNK_KEYS = ["max_words", "max_chars", "split_by", "upper", "punch_words"];
export const CHUNK_PROPS = {
  max_words: { type: "integer", minimum: 1, maximum: 50, description: "Split each cue into cards of at most this many words." },
  max_chars: { type: "integer", minimum: 1, maximum: 500, description: "Split each cue into cards of at most this many characters (a longer single word keeps its own card)." },
  split_by: { type: "string", enum: ["chars", "words"], default: "chars", description: "Share each cue's time between its cards by letters or by words." },
  upper: { type: "boolean", default: false, description: "ALL CAPS cards." },
  punch_words: { type: "array", items: { type: "string" }, description: "Words that get a card of their own (color them with capcut_style_text highlight)." },
  min_gap_s: { type: "number", minimum: 0, maximum: 1, default: 0, description: "Shorten a card so at least this gap is left before the next one (never below one frame)." },
};

/** Place cues (seconds) on a text track: offset_s, optional chunking, frame snap, clamp at clampUs. */
export function placeCues(l: Loaded, parsed: Cue[], a: Args, clampUs?: number): Json {
  const fps = l.draft.fps || 30, off = num(a, "offset_s", -86_400, 86_400, 0);
  const size = num(a, "font_size", 1, 100, 8), hex = color(a, "color", "#FFFFFF"), x = num(a, "x", -1, 1, 0), y = num(a, "y", -1, 1, -0.55);
  const track = checkName(a.track ?? "subtitles", "track");
  let cues = parsed.map((c) => (c.start + off < 0 ? fail(`offset_s moves a cue before 0s: "${c.text}"`) : { ...c, start: c.start + off, end: c.end + off }));
  const chunked = CHUNK_KEYS.some((k) => a[k] !== undefined);
  if (chunked) {
    const by = str(a, "split_by", 10, "chars");
    if (by !== "chars" && by !== "words") fail("split_by must be chars or words");
    const punch = a.punch_words === undefined ? [] : Array.isArray(a.punch_words) && a.punch_words.every((w) => typeof w === "string" && w.length <= 100) ? a.punch_words as string[] : fail("punch_words must be a list of words");
    cues = chunkCues(cues, { maxWords: a.max_words === undefined ? undefined : num(a, "max_words", 1, 50), maxChars: a.max_chars === undefined ? undefined : num(a, "max_chars", 1, 500), by, upper: bool(a, "upper", false), punch }, fps);
  }
  const gap = toUs(num(a, "min_gap_s", 0, 1, 0), fps), one = durUs(0, fps);
  const spans = cues.map((c) => { const s = toUs(c.start, fps); return [s, Math.max(toUs(c.end, fps), s + one)]; });
  if (gap) spans.forEach((x, i) => { const next = spans[i + 1]?.[0]; if (next !== undefined && next - x[1] < gap) x[1] = Math.max(x[0] + one, Math.min(x[1], next - gap)); });
  let used = 0, dropped = 0;
  for (const [i, c] of cues.entries()) {
    const s = spans[i][0];
    let e = spans[i][1];
    if (clampUs !== undefined) { if (s >= clampUs) { dropped++; continue; } e = Math.min(e, clampUs); }
    addTextSeg(l.draft, c.text, s, e - s, size, hex, x, y, track);
    used++;
  }
  l.draft.duration = Math.max(l.draft.duration ?? 0, endOf(l.draft));
  return { track, cues: used, x, ...(chunked ? { source_cues: parsed.length } : {}), ...(dropped ? { dropped_after_end: dropped } : {}), first: parsed[0], last: parsed[parsed.length - 1] };
}
const opSubs = (l: Loaded, a: Args, clampUs?: number): Json => placeCues(l, readSrt(a), a, clampUs);

// ---------- tools ----------

export const DRAFT = { type: "string", description: "Draft folder name inside the drafts root (from capcut_list_drafts)." };
export const DRY = { type: "boolean", default: true, description: "true (default): return the plan only. false: write to disk (CapCut must be closed)." };
const REG = { type: "boolean", default: false, description: "Also add/refresh the project entry in root_meta_info.json (backed up first). Use only if CapCut does not list the draft after a restart." };
const TMPL = { type: "string", description: "Folder of an empty project made by CapCut, to copy its version markers (needed for CapCut 9.x). \"auto\" (default) picks the newest CapCut-made project in the drafts root, then in CAPCUT_TEMPLATE_ROOT; \"none\" uses the built-in skeleton." };
export const T = (props: Json, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const MEDIA_PROPS = {
  path: { type: "string", description: "Absolute path of the media file." },
  start_s: { type: "number", minimum: 0, default: 0, description: "Timeline position." },
  duration_s: { type: "number", exclusiveMinimum: 0, description: "Length on the timeline (default: rest of the file after in_s; read from MP4/MOV/M4A/WAV)." },
  in_s: { type: "number", minimum: 0, default: 0, description: "Trim start inside the source." },
  media_duration_s: { type: "number", description: "Full source length, if the file length cannot be read (MP3, MKV...)." },
  volume: { type: "number", minimum: 0, maximum: 2, default: 1 },
};

// UI diff 9.5.0 session 8 (2026-10-04): Espacio cromático writes draft.color_space and hdr_settings.mode on every
// non-compound video segment; compound clips get it inside materials.drafts[].draft.
const COLOR_SPACES: Record<string, { color_space: number; mode: number }> = {
  rec709_sdr: { color_space: 0, mode: 1 }, rec2020_sdr: { color_space: 2, mode: 1 },
  rec2100_hlg: { color_space: 67, mode: 2 }, rec2100_pq: { color_space: 2084, mode: 3 },
};
const csName = (v: number) => Object.entries(COLOR_SPACES).find(([, c]) => c.color_space === v)?.[0] ?? `unknown(${v})`;
function setColorSpace(d: any, cs: { color_space: number; mode: number }): void {
  d.color_space = cs.color_space;
  const sub = new Set<string>((d.materials?.drafts ?? []).map((m: any) => m.id));
  for (const t of d.tracks ?? []) if (t.type === "video") for (const sg of t.segments ?? []) {
    if (sub.has(sg.material_id)) continue;
    sg.hdr_settings = { intensity: 1, nits: 1000, ...(sg.hdr_settings ?? {}), mode: cs.mode };
  }
  for (const m of d.materials?.drafts ?? []) if (m.draft) setColorSpace(m.draft, cs);
}

export const TOOLS: Record<string, { description: string; inputSchema: Json; run: (a: Args) => Json }> = {
  capcut_list_drafts: {
    description: "List CapCut draft folders in the drafts root (read only).",
    inputSchema: T({}),
    run: () => {
      const base = root();
      const drafts = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => {
        const dir = join(base, d.name);
        const files = [...TIMELINE_FILES, META].filter((f) => existsSync(join(dir, f)));
        if (files.length === 0 && !existsSync(join(dir, "Timelines"))) return null;
        const r: Json = { folder: d.name, name: d.name, files, has_timelines_dir: existsSync(join(dir, "Timelines")), modified: statSync(dir).mtime.toISOString() };
        try {
          const l = load(dir);
          Object.assign(r, { name: l.meta?.draft_name || d.name, app_version: l.draft.platform?.app_version ?? null, segments: segCount(l.draft), duration_s: toS(l.draft.duration ?? 0), writable: !l.blocked, encrypted: false });
        } catch (e) { Object.assign(r, { encrypted: /decrypt/.test((e as Error).message), writable: false, error: (e as Error).message }); }
        return r;
      }).filter(Boolean);
      return { drafts_root: base, count: drafts.length, drafts, index_file: existsSync(join(base, INDEX)) ? join(base, INDEX) : null };
    },
  },
  capcut_read_draft: {
    description: "Read one draft and return canvas, fps, duration, which file holds the timeline, and every track/segment in seconds (read only).",
    inputSchema: T({ draft: DRAFT }, ["draft"]),
    run: (a) => summarize(load(draftDir(a.draft))),
  },
  capcut_create_draft: {
    description: "Create a new empty draft folder. Default canvas 1080x1920 (vertical short), 30 fps. Copies version markers from an empty CapCut-made project (template_draft, default auto) so CapCut 9.x accepts it. Dry-run by default.",
    inputSchema: T({
      name: { type: "string", description: "New draft folder and project name." },
      width: { type: "integer", default: 1080, minimum: 144, maximum: 7680 },
      height: { type: "integer", default: 1920, minimum: 144, maximum: 7680 },
      fps: { type: "integer", default: 30, enum: [24, 25, 30, 50, 60] },
      template_draft: TMPL, register_in_index: REG, dry_run: DRY,
    }, ["name"]),
    run: (a) => {
      const base = root();
      const { l, plan } = opCreate(base, a);
      if (bool(a, "register_in_index", false)) l.index = { base };
      return finish(l, a, plan);
    },
  },
  capcut_add_clip: {
    description: "Add a video, image or audio file to a draft timeline. The file is copied into <draft>/assets/. Length and size are read from MP4/MOV/M4A/WAV files. Optional fade_in_s / fade_out_s use the same audio-fade writer as capcut_set_clip (video clips also copy audio_fade onto the video material). Times are seconds. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, ...MEDIA_PROPS,
      fade_in_s: { type: "number", minimum: 0, maximum: 60, default: 0, description: "Audio fade-in (audio files and the sound of video clips)." },
      fade_out_s: { type: "number", minimum: 0, maximum: 60, default: 0, description: "Audio fade-out." },
      width: { type: "integer", description: "Source width px (default: read from file, else canvas width)." },
      height: { type: "integer", description: "Source height px (default: read from file, else canvas height)." },
      track: { type: "string", description: "Track name (default main / audio). Use another name to layer." },
      dry_run: DRY,
    }, ["draft", "path"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opMedia(l, a), new_draft_duration_s: toS(l.draft.duration) });
    },
  },
  capcut_add_audio: {
    description: "Add music or a voice-over (audio file) on an audio track, with volume and optional fade in/out. Default track \"music\". Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, ...MEDIA_PROPS,
      volume: { type: "number", minimum: 0, maximum: 2, default: 1, description: "1 = original level. Background music: 0.2-0.4." },
      fade_in_s: { type: "number", minimum: 0, maximum: 60, default: 0 },
      fade_out_s: { type: "number", minimum: 0, maximum: 60, default: 0 },
      track: { type: "string", default: "music" }, dry_run: DRY,
    }, ["draft", "path"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opMedia(l, a, "audio"), new_draft_duration_s: toS(l.draft.duration) });
    },
  },
  capcut_add_text: {
    description: "Add a text overlay (title, hook, CTA) to a draft. Position x/y is -1..1 from the canvas centre. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, text: { type: "string", maxLength: 500 },
      start_s: { type: "number", minimum: 0 }, duration_s: { type: "number", exclusiveMinimum: 0 },
      font_size: { type: "number", minimum: 1, maximum: 100, default: 12 },
      color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#FFFFFF" },
      x: { type: "number", minimum: -1, maximum: 1, default: 0 }, y: { type: "number", minimum: -1, maximum: 1, default: 0.6 },
      track: { type: "string", default: "text" }, dry_run: DRY,
    }, ["draft", "text", "start_s", "duration_s"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opText(l, a) });
    },
  },
  capcut_add_subtitles: {
    description: "Import an SRT file (or SRT text) as caption text segments on one track. Optional re-chunking into short cards (max_words / max_chars, time shared by letters or words on the frame grid), ALL CAPS and punch words on their own card. x is -1..1 from the canvas centre (default 0, centred), same as capcut_add_text. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT,
      srt_path: { type: "string", description: "Absolute path of a .srt file." },
      srt_text: { type: "string", description: "SRT content, if no file." },
      offset_s: { type: "number", default: 0, description: "Shift every cue by this many seconds." },
      font_size: { type: "number", minimum: 1, maximum: 100, default: 8 },
      color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#FFFFFF" },
      x: { type: "number", minimum: -1, maximum: 1, default: 0, description: "Horizontal position, -1..1 from the canvas centre (same as capcut_add_text). 0 is centred." },
      y: { type: "number", minimum: -1, maximum: 1, default: -0.55 },
      track: { type: "string", default: "subtitles" }, ...CHUNK_PROPS, dry_run: DRY,
    }, ["draft"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      return finish(l, a, { draft: a.draft, ...opSubs(l, a) });
    },
  },
  capcut_make_short: {
    description: "One call for a vertical short: clip + optional title (title_y, title_color, title_style) + optional SRT subtitles (sub_font_size, sub_color, sub_y, re-chunking, sub_style) + optional background music (with fades). sub_style and title_style use the same fields and writer as capcut_style_text. Give draft (an EMPTY project you made in CapCut: it is filled in place, best for CapCut 9.x) or name (a new draft that copies a CapCut-made project's markers). Dry-run by default.",
    inputSchema: T({
      draft: { type: "string", description: "Existing EMPTY CapCut-made project to fill in place (recommended for CapCut 9.x)." },
      name: { type: "string", description: "Or: name of a new draft to create." },
      clip_path: { type: "string", description: "Absolute path of the video clip." },
      clip_in_s: { type: "number", minimum: 0, default: 0 },
      duration_s: { type: "number", exclusiveMinimum: 0, description: "Short length (default: rest of the clip after clip_in_s)." },
      clip_media_duration_s: { type: "number", description: "Clip file length, only if it cannot be read (non-MP4/MOV)." },
      clip_volume: { type: "number", minimum: 0, maximum: 2, default: 1 },
      title: { type: "string", maxLength: 500 },
      title_duration_s: { type: "number", exclusiveMinimum: 0, default: 3 },
      title_font_size: { type: "number", minimum: 1, maximum: 100, default: 14 },
      title_y: { type: "number", minimum: -1, maximum: 1, default: 0.6 }, title_color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#FFFFFF" },
      srt_path: { type: "string", description: "Absolute path of a .srt file." },
      srt_text: { type: "string", description: "SRT content, if no file." },
      sub_font_size: { type: "number", minimum: 1, maximum: 100, default: 8 }, sub_color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#FFFFFF" },
      sub_y: { type: "number", minimum: -1, maximum: 1, default: -0.55 }, ...CHUNK_PROPS,
      sub_style: { type: "object", description: "Caption look, same fields as capcut_style_text (stroke, shadow, background, highlight, font file, bold, italic). Applied to every subtitle.", properties: STYLE_PROPS, additionalProperties: false },
      title_style: { type: "object", description: "Title look, same fields as capcut_style_text. Applied to the title.", properties: STYLE_PROPS, additionalProperties: false },
      music_path: { type: "string", description: "Absolute path of the music file." },
      music_in_s: { type: "number", minimum: 0, default: 0 },
      music_media_duration_s: { type: "number", description: "Music file length, only if it cannot be read (MP3...)." },
      music_volume: { type: "number", minimum: 0, maximum: 2, default: 0.3 },
      music_fade_s: { type: "number", minimum: 0, maximum: 10, default: 1, description: "Fade in and fade out length." },
      music_fade_in_s: { type: "number", minimum: 0, maximum: 10, description: "Overrides music_fade_s for the fade in." },
      music_fade_out_s: { type: "number", minimum: 0, maximum: 10, description: "Overrides music_fade_s for the fade out." },
      width: { type: "integer", default: 1080 }, height: { type: "integer", default: 1920 },
      fps: { type: "integer", enum: [24, 25, 30, 50, 60], description: "New drafts only (default 30)." },
      template_draft: TMPL, register_in_index: REG, dry_run: DRY,
    }, ["clip_path"]),
    run: (a) => {
      const base = root();
      if ((a.draft === undefined) === (a.name === undefined)) fail("Give exactly one of draft (fill an empty CapCut project) or name (create a new draft)");
      let l: Loaded, created: Json = null;
      if (a.name !== undefined) {
        const c = opCreate(base, { name: a.name, width: a.width, height: a.height, fps: a.fps, template_draft: a.template_draft });
        l = c.l; created = c.plan;
      } else {
        if (a.template_draft !== undefined || a.fps !== undefined) fail("template_draft and fps apply only with name");
        l = load(draftDir(a.draft)); assertWritable(l);
        if (segCount(l.draft) > 0) fail(`Draft "${a.draft}" is not empty (${segCount(l.draft)} segments). Use an empty project, or name to create a new draft.`);
        const w = num(a, "width", 144, 7680, 1080), h = num(a, "height", 144, 7680, 1920);
        if (!Number.isInteger(w) || !Number.isInteger(h)) fail("width/height must be integers");
        l.draft.canvas_config = { ...l.draft.canvas_config, width: w, height: h, ratio: ratio(w, h) };
      }
      const pick = (src: string, dst: string, o: Args) => { if (a[src] !== undefined) o[dst] = a[src]; return o; };
      const clipArgs = pick("clip_media_duration_s", "media_duration_s", pick("duration_s", "duration_s", { path: a.clip_path, in_s: a.clip_in_s, volume: a.clip_volume }));
      const clip = opMedia(l, Object.fromEntries(Object.entries(clipArgs).filter(([, v]) => v !== undefined)));
      if (clip.kind !== "video") fail("clip_path must be a video file");
      const end = l.draft.duration, endS = toS(end);
      const steps: Json = { clip };
      if (a.title !== undefined) steps.title = opText(l, { text: a.title, start_s: 0, duration_s: Math.min(num(a, "title_duration_s", 0.001, 600, 3), endS), font_size: num(a, "title_font_size", 1, 100, 14), y: num(a, "title_y", -1, 1, 0.6), color: color(a, "title_color", "#FFFFFF") });
      if (a.title_style !== undefined) {
        if (a.title === undefined) fail("title_style needs a title");
        steps.title = { ...steps.title, style: applyTextStyle(l, "text", a.title_style, "title_style") };
      }
      if (a.srt_path !== undefined || a.srt_text !== undefined) {
        const sa: Args = {};
        for (const [from, to] of [["srt_text", "srt_text"], ["srt_path", "srt_path"], ["sub_font_size", "font_size"], ["sub_color", "color"], ["sub_y", "y"], ...Object.keys(CHUNK_PROPS).map((k) => [k, k])]) pick(from, to, sa);
        steps.subtitles = opSubs(l, sa, end);
      }
      if (a.sub_style !== undefined) {
        if (a.srt_path === undefined && a.srt_text === undefined) fail("sub_style needs srt_path or srt_text");
        steps.subtitles = { ...steps.subtitles, style: applyTextStyle(l, "subtitles", a.sub_style, "sub_style") };
      }
      if (a.music_path !== undefined) {
        const m: Args = { path: a.music_path, in_s: a.music_in_s ?? 0, volume: a.music_volume ?? 0.3 };
        if (a.music_media_duration_s !== undefined) m.media_duration_s = a.music_media_duration_s;
        const src = mediaFile(m, "path");
        const len = (m.media_duration_s as number | undefined) ?? probeMedia(src).duration_s;
        if (len === undefined) fail("music length could not be read; give music_media_duration_s");
        const dur = Math.min(endS, len! - (m.in_s as number));
        if (dur <= 0) fail("music_in_s is at or after the end of the music file");
        const fade = num(a, "music_fade_s", 0, 10, 1), half = (k: string) => Math.min(num(a, k, 0, 10, fade), dur / 2);
        steps.music = opMedia(l, { ...m, duration_s: dur, fade_in_s: half("music_fade_in_s"), fade_out_s: half("music_fade_out_s") }, "audio");
      }
      if (bool(a, "register_in_index", false)) l.index = { base };
      const plan = { draft: l.meta?.draft_name ?? basename(l.dir), mode: created ? "new draft" : "filled in place", path: l.dir, ...(created ? { created } : {}),
        canvas: l.draft.canvas_config, duration_s: endS, steps, next: "Quit CapCut before dry_run=false. Then open CapCut and the project from the drafts list." };
      return finish(l, a, plan);
    },
  },
  capcut_set_timeline: {
    description: "Change canvas size, fps, total duration or colour space (SDR/HDR) of a draft. Duration cannot cut existing segments. Dry-run by default.",
    inputSchema: T({
      draft: DRAFT, width: { type: "integer", minimum: 144, maximum: 7680 }, height: { type: "integer", minimum: 144, maximum: 7680 },
      fps: { type: "integer", enum: [24, 25, 30, 50, 60] }, duration_s: { type: "number", minimum: 0 },
      color_space: { type: "string", enum: Object.keys(COLOR_SPACES), description: "Project colour space (Configuración del proyecto > Espacio cromático)" }, dry_run: DRY,
    }, ["draft"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      const d = l.draft, before = { canvas: { ...d.canvas_config }, fps: d.fps, duration_s: toS(d.duration ?? 0) }, before_cs = d.color_space ?? 0;
      const w = num(a, "width", 144, 7680, d.canvas_config.width), h = num(a, "height", 144, 7680, d.canvas_config.height);
      const fps = num(a, "fps", 24, 60, d.fps || 30);
      if (![24, 25, 30, 50, 60].includes(fps) || !Number.isInteger(w) || !Number.isInteger(h)) fail("width/height must be integers; fps one of 24, 25, 30, 50, 60");
      d.canvas_config = { ...d.canvas_config, width: w, height: h, ratio: ratio(w, h) };
      d.fps = fps;
      if (a.color_space !== undefined) {
        const cs = COLOR_SPACES[String(a.color_space)]; if (!cs) fail(`color_space must be one of ${Object.keys(COLOR_SPACES).join(", ")}`);
        setColorSpace(d, cs);
      }
      const end = endOf(d);
      if (a.duration_s !== undefined) {
        const want = toUs(num(a, "duration_s", 0, 86_400), fps);
        if (want < end) fail(`duration_s ${toS(want)} is shorter than the last segment end ${toS(end)}`);
        d.duration = want;
      } else d.duration = Math.max(d.duration ?? 0, end);
      return finish(l, a, { draft: a.draft, before: { ...before, color_space: csName(before_cs) }, after: { canvas: d.canvas_config, fps: d.fps, duration_s: toS(d.duration), color_space: csName(d.color_space ?? 0) } });
    },
  },
  capcut_export_draft: {
    description: "Validate a draft and copy its folder into CAPCUT_EXPORT_ROOT (the CapCut drafts folder) so you can open it in CapCut. Never overwrites. Not needed when CAPCUT_DRAFTS_ROOT already is the CapCut folder. Dry-run by default.",
    inputSchema: T({ draft: DRAFT, new_name: { type: "string", description: "Folder/project name at the destination (default: same)." }, register_in_index: REG, dry_run: DRY }, ["draft"]),
    run: (a) => {
      const l = load(draftDir(a.draft)); assertWritable(l);
      if (existsSync(join(l.dir, "Timelines"))) fail("This draft is already a CapCut project (it has Timelines/). Open it in CapCut directly.");
      const dest = exportRoot();
      const name = checkName(a.new_name ?? a.draft, "new_name");
      const out = join(dest, name);
      if (existsSync(out)) fail(`Destination already exists: ${out}`);
      const problems: string[] = [];
      for (const k of ["videos", "audios"]) for (const m of l.draft.materials?.[k] ?? []) if (m.path && !existsSync(localPath(l.dir, m.path))) problems.push(`missing media: ${m.path}`);
      if (endOf(l.draft) > (l.draft.duration ?? 0)) problems.push("a segment ends after the draft duration");
      if (problems.length) fail(`Draft is not valid: ${problems.join("; ")}`);
      const reg = bool(a, "register_in_index", false);
      const plan = { draft: a.draft, from: l.dir, to: out, segments: segCount(l.draft), duration_s: toS(l.draft.duration), would_write: [out, ...(reg ? [join(dest, INDEX)] : [])] };
      if (dryRun(a)) return { dry_run: true, ...plan };
      if (reg && capcutRunning()) fail("CapCut is running. Quit CapCut first: it rewrites root_meta_info.json when it saves.");
      cpSync(l.dir, out, { recursive: true, errorOnExist: true, force: false, filter: (s) => !/\.(bak|tmp-\d+)$/.test(s) });
      // Media paths point into the old folder; repoint them and the identity fields at the new one.
      const swap = (v: string) => (v.startsWith(l.dir + sep) ? out + v.slice(l.dir.length) : v);
      const c = load(out);
      c.draft.name = name;
      for (const k of ["videos", "audios"]) for (const m of c.draft.materials?.[k] ?? []) if (m.path) m.path = swap(m.path);
      if (c.meta) {
        Object.assign(c.meta, { draft_fold_path: out, draft_root_path: dest, draft_name: name, draft_json_file: join(out, c.targets[0].file) });
        for (const g of c.meta.draft_materials ?? []) for (const e of g.value ?? []) if (e.file_Path) e.file_Path = swap(e.file_Path);
      }
      save(c, false);
      const index = reg ? registerIndex(dest, c) : undefined;
      return { dry_run: false, written: true, ...plan, ...(index ? { index } : {}), next: "Open CapCut, then open the project from the drafts list." };
    },
  },
};

// ---------- MCP JSON-RPC over stdio ----------

export function handle(msg: Json): Json | null {
  const { id, method, params } = msg ?? {};
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof method !== "string") return error(-32600, "Invalid Request");
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "capcut-mcp", version: VERSION },
      });
    case "ping": return reply({});
    case "tools/list":
      return reply({ tools: Object.entries({ ...TOOLS, ...featureTools() }).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const tool = TOOLS[params?.name] ?? featureTools()[params?.name];
      if (!tool) return error(-32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments ?? {};
      try {
        if (typeof args !== "object" || Array.isArray(args)) fail("arguments must be an object");
        allowOnly(args, tool.inputSchema);
        return reply({ content: [{ type: "text", text: JSON.stringify(tool.run(args), null, 2) }] });
      } catch (e) {
        const text = e instanceof UserError ? e.message : `Internal error: ${(e as Error).message}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default: return error(-32601, `Method not found: ${method}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let out: Json;
    try { out = handle(JSON.parse(line)); } catch { out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}
