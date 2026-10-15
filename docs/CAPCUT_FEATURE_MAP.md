# CapCut 9.5.0 (macOS) feature map for capcut-mcp

Read 2026-10-03. Machine-readable catalog: [capcut_features.json](capcut_features.json).

**102 features mapped; 19 AI/cloud features are out of scope** (<owner>, 2026-10-03: no cloud captions, background removal, reframe, AI effects, TTS, retouch/reshape/makeup/relight, quality enhance, avatars, AI translate, auto cut, auto colour, voice enhance, credit features). Counts below exclude them. **83 in scope.** MCP support: **57 yes, 8 partial, 0 no, 18 impossible** (unknown = 0) (unknown = 4) (unknown = 6) (unknown = 9) (unknown = 13) (unknown = 15) (unknown = 15) (unknown = 15) (unknown = 20). Confidence: 55 high, 23 medium, 5 low.

UI diff (2026-10-03, 39 steps): **21 of the 57 'needs UI diff' features resolved** (evidence `ui-diff 9.5.0`), 1 more raised to medium by analogy, 5 medium features raised to high. C6 and C7 resolved.

UI diff session 2 (2026-10-03 20:10-20:26, 12 steps): **7 more resolved (28 in total)**, 1 low raised to medium (text on path). The Mac went to sleep at about 20:26.

UI diff session 3 (2026-10-03 22:10-22:24, 22 steps): **3 more resolved (31 in total)**: LUT, keyframe easing, compound clip. Beat detection and canvas background raised to high, stabilization to medium. Resource cache re-read: 4638 new ids (21409 total).

UI diff session 4 (2026-10-03 22:32-22:56, about 30 steps, native editing only): **7 more resolved (38 in total)**: stabilization levels, text stroke / shadow / background box values, all mask shapes and params, channel mapping, video stroke/shadow/radius (not in the 9.5 UI). New writers: `capcut_set_clip` stabilize, audio_channel, mask; `capcut_style_text` corrected and extended.

## Method (ToS-safe)

- Read only, on the Mac: plain JSON in `~/Movies/CapCut/User Data` (saved drafts, `Cache/effect/*/config.json`, `Presets/`), the local resource-panel cache `Cache/ressdk_db/*/rp.db` (copied to /tmp, then read on the box), and plain JSON/plist in `/Applications/CapCut.app/Contents/Resources` (`MixMode/MixMode.json`, `video_template_ratio.json`, `DefaultAdjustBundle/`, `Font/SystemFont/`).
- Official help pages on capcut.com (URLs per feature in the JSON).
- Shape cross-check: pyJianYingDraft (MIT open-source draft writer, commit 6bb2d06). It targets JianYing; its ids mostly do not match CapCut (0 of 453 transition ids, 0 of 2104 filter ids match the local cache), but blend-mode ids match the CapCut bundle 10/10 and video in/out/combo ids partly match (111 of 402).
- Not done: no calls to CapCut servers, no traffic capture, no decompiling, no decryption. `Cache/strategy/*.json` and `resourcePanel/*` are encrypted: not read. No device ids or tokens copied into the repo (`platform.device_id`, `hard_disk_id`, `mac_address` and the cache's user id stay out).

## Evidence levels

- **ui-diff 9.5.0**: one change made in the CapCut UI, the autosaved `draft_info.json` diffed against the step before. Samples (anonymised): [test/fixtures/capcut-9.5.0-ui-diff.json](../test/fixtures/capcut-9.5.0-ui-diff.json).
- **high**: field seen in a CapCut-saved 9.5.0 draft (`draft_info.json` version 360000, new_version 187.0.0) or an id in the app bundle.
- **medium**: field name seen in a 9.5.0 save or id in the local cache, value encoding from pyJianYingDraft. Writable, but check once in the UI.
- **low**: docs only, or JSON shape unknown. Marked `unknown, needs UI diff`. No ids or ranges were invented.

## What a 9.5.0 draft holds

`materials` has 55 lists in 9.5.0: `flowers videos tail_leaders audios images texts effects stickers canvases transitions audio_effects audio_fades beats material_animations placeholders placeholder_infos speeds common_mask chromas text_templates realtime_denoises audio_pannings audio_pitch_shifts video_trackings hsl drafts color_curves hsl_curves primary_color_wheels log_color_wheels video_effects ai_text_effects audio_balances handwrites manual_deformations manual_beautys plugin_effects sound_channel_mappings green_screens shapes material_colors digital_humans digital_human_model_dressing smart_crops ai_translates audio_track_indexes loudnesses vocal_beautifys vocal_separations smart_relights time_marks multi_language_refs video_shadows video_strokes video_radius`. A segment links its extras through `extra_material_refs` (speed, placeholder, canvas, sound channel, color, vocal separation, fades, effects). The text material carries stroke/shadow/background fields even when unused (`border_*`, `shadow_*`, `background_*`).

## Features by category

| Category | Feature | Draft fields | Tier | MCP | Tool | Confidence |
|---|---|---|---|---|---|---|
| project | Canvas size and ratio | `canvas_config.width, canvas_config.height, canvas_config.ratio` | free | yes | capcut_create_draft, capcut_set_timeline | high |
| project | Frame rate | `fps` | free | yes | capcut_create_draft, capcut_set_timeline | medium |
| project | Project duration | `duration (microseconds)` | free | yes | capcut_set_timeline | high |
| project | 9.5.0 version markers | `version=360000, new_version=187.0.0, platform.app_version=9.5.0` | free | yes | capcut_create_draft (template seeding) | high |
| project | Nested timeline (multi-timeline layout) | `Timelines/project.json main_timeline_id, Timelines/<id>/draft_info.json, template-2.tmp` | free | yes | all writers | high |
| project | Project list registration | `root_meta_info.json all_draft_store[]` | free | yes | capcut_register_draft, register_in_index | high |
| project | Track order and layers | `tracks[] order = layer order, bottom (main video) to top, track.flag: 0 main video, 2 overlay video, segment.track_render_index = index of its track in tracks[] ...` | free | yes | capcut_reorder_track | high |
| project | Color space and HDR | `color_space, config.hdr_vivid, segment.hdr_settings ...` | unknown | yes | capcut_set_timeline (color_space) | low |
| project | Markers (time marks) | `time_marks (top level) = {id, mark_items[{id, time_range{start, duration 0}, color '#00c1cd', title 'Marcador 01'}]}` | free | yes | capcut_add_markers, capcut_export_chapters | high |
| project | Compound clip / group | `materials.drafts[type 'combination'] {combination_id, draft = full embedded draft (own tracks/materials), draft_file_path -> subdraft/<id>/draft_content.json, draft_cover_path, draft_config_path}, main segment material_id -> materials.videos[] {type 'video', path '', material_name 'Clip combinado1', extra_type_option 2}, config.combination_max_index++ ...` | free | yes | capcut_compound_clip | high |
| project | Combination presets | `(app store) CombinationPresetVirtualStore.json` | unknown | yes | capcut_insert_preset | low |
| video | Video / photo clip | `materials.videos[], tracks[type=video].segments[]` | free | yes | capcut_add_clip, capcut_make_short | high |
| video | Trim (in point, length) | `segment.source_timerange, segment.target_timerange` | free | yes | capcut_add_clip | high |
| video | Transform: scale, position, rotation, opacity | `segment.clip.scale, segment.clip.transform, segment.clip.rotation ...` | free | yes | capcut_set_clip | medium |
| video | Flip | `segment.clip.flip.horizontal, segment.clip.flip.vertical` | free | yes | capcut_set_clip (flip: {horizontal, vertical}) | high |
| video | Crop | `materials.videos[].crop (8 corner coords), crop_ratio, crop_scale` | free | yes | capcut_set_clip (crop: {left, top, right, bottom}) | medium |
| video | Reverse | `segment.reverse = true, materials.videos[].reverse_path = '##_draftpath_placeholder_<id>_##/<md5>.mp4' (CapCut renders a reversed copy inside the draft), videos[].video_algorithm.time_range` | free | impossible | impossible: Needs CapCut-rendered files: CapCut writes a reversed copy inside the draft (reverse_path placeholder + md5 file) | high |
| video | Freeze frame | `clip is split; a photo segment (default 3 s) is inserted, materials.videos[type=photo].path = extracted frame .jpg in the draft, videos[].freeze = {source_material_id, source_material_path, reverse_material_path, timestamp (us)}` | free | impossible | impossible: Needs a CapCut-extracted frame file in the draft (photo segment + videos[] | high |
| video | Speed (constant) | `materials.speeds[].speed, segment.speed, source = target x speed` | free | yes | capcut_set_clip | medium |
| video | Speed curve | `materials.speeds[].mode = 1, speeds[].curve_speed = {id, name, source_platform 0, speed_points[{x 0..1, y 0.1..10}]}, speeds[].speed = segment.speed = 1 / sum(dx / ((y_i + y_i+1) / 2)) ...` | pro | yes | capcut_set_speed_curve | high |
| video | Canvas background: color / blur / image | `materials.canvases[] {type canvas_color, color '#rrggbbaa' lowercase (e.g. '#f4c70fff')} or {type canvas_blur, blur 0.0625 \| 0.375 \| 0.75 \| 1.0}, segment.extra_material_refs` | free | partial | capcut_set_clip (color, blur) | high |
| video | Blend mode | `materials.effects[type=mix_mode], segment.extra_material_refs` | free | yes | capcut_set_clip | medium |
| video | Masks | `materials.common_mask[] {type 'mask', name 'Circulo', resource_type 'circle', resource_id 7374021188315517456, config{width 0.28, height 0.5, centerX, centerY, rotation, feather, expansion, roundCorner, invert, aspectRatio}, path Cache/effect/1068046525/<md5>}` | free | yes | capcut_set_clip (mask: line, mirror, circle, rectangle, star, heart) | high |
| video | Chroma key | `materials.chromas[] {type 'chroma', color '' until picked, intensity_value 0.2, shadow_value 0, edge_smooth_value 0, spill_value 0, path '$APP/Chroma2', version 'v2'}, segment.extra_material_refs` | free | impossible | impossible: The picked key colour is not persisted in any readable draft file (color stays '' after eyedropper picks in sessions 3 and 4, in every copy); it can only live in the encrypted draft | medium |
| video | Video stroke / shadow / corner radius | `materials.video_strokes, materials.video_shadows, materials.video_radius` | mixed | impossible | impossible: Not a native control for video clips in CapCut 9 | medium |
| video | Stabilization | `materials.videos[].stable {stable_level 0 off \| 1 Corte minimo \| 2 Recomendado \| 3 Mas estable, matrix_path '' (CapCut computes the motion), time_range {0,0}}` | pro | yes | capcut_set_clip (stabilize 0-3) | high |
| video | Corner pin / surface tracking | `videos[].corner_pin, videos[].surface_trackings` | unknown | impossible | impossible: CapCut 9 | low |
| video | Video animations: in / out / combo | `materials.material_animations[type=sticker_animation] per segment (ref in extra_material_refs; created empty with each video clip), animations[] {id = resource_id, type in\|out\|group, start, duration (us), panel 'video', material_type 'video', path, category_id}` | mixed | yes | capcut_add_animation | high |
| video | Transitions | `materials.transitions[] {type 'transition', name, effect_id = resource_id, third_resource_id, path $USER_DATA/Cache/effect/<id>/<md5>, duration (us), is_overlap true, category_id, category_name, is_ai_transition false}, LEFT segment.extra_material_refs (inserted after speed + placeholder refs)` | mixed | yes | capcut_add_transition | high |
| video | Video effects (scene) | `materials.video_effects[] {type 'video_effect', effect_id = resource_id, value 1, apply_target_type 2, adjust_params[{name effects_adjust_speed\|intensity\|texture\|color, value, default_value}], render_index, track_render_index}, tracks[type=effect].segments[] (render_index 11000)` | mixed | yes | capcut_add_effect (kind scene) | high |
| video | Body effects (character) | `materials.video_effects[type=face_effect] {effect_id = resource_id, apply_target_type 2, adjust_params[effects_adjust_speed], algorithm_artifact_path '##_draftpath_placeholder_<id>_##/video_effect/multi_faces_algorithm/<uuid>'}, tracks[type=effect].segments[] render_index 11000 + n (n = effect segments already there)` | mixed | yes | capcut_add_effect (kind body) | high |
| video | Filters | `materials.effects[type=filter] {effect_id = resource_id, name, value = intensity/100, path, category_id, adjust_params []}, segment.extra_material_refs` | mixed | yes | capcut_add_filter | high |
| color | Adjustment layer | `tracks[type=adjust].segments[] (source_timerange null, enable_adjust/enable_hsl/enable_lut/enable_adjust_mask true), segment.material_id -> materials.placeholders[] {type 'adjust', name 'Ajustar1'}, config.adjust_max_index++ ...` | free | yes | capcut_add_adjustment_layer | high |
| video | Glow | `video_effects/bloom_params` | mixed | yes | capcut_style_text (glow: {style neon/rays, color, strength, range}) | medium |
| ai_tools | Retouch: face beauty / skin | `materials.manual_beautys, videos[].beauty_face_preset_infos, beauty_face_auto_preset` | mixed | out_of_scope |  | low |
| ai_tools | Face reshape | `materials.manual_deformations?` | mixed | out_of_scope |  | low |
| ai_tools | Body reshape | `videos[].beauty_body_preset_id` | mixed | out_of_scope |  | low |
| ai_tools | Makeup | `unknown` | mixed | out_of_scope |  | low |
| ai_tools | Relight | `materials.smart_relights` | free | out_of_scope |  | low |
| ai_tools | Quality: enhance, denoise, deflicker, motion blur | `videos[].video_algorithm.{quality_enhance,noise_reduction,deflicker,motion_blur_config}` | pro | out_of_scope |  | low |
| ai_tools | Camera tracking / lens lock / smart motion | `materials.video_trackings, videos[].smart_motion` | pro | out_of_scope |  | low |
| ai_tools | Background removal (auto cutout) | `videos[].matting` | pro | out_of_scope |  | low |
| ai_tools | Auto reframe | `materials.smart_crops` | unknown | out_of_scope |  | low |
| ai_tools | Auto cut / AI shorts | `(app cache) Cache/AiShorts` | unknown | out_of_scope |  | low |
| ai_tools | Digital humans / AI avatars | `materials.digital_humans, digital_human_model_dressing` | mixed | out_of_scope |  | low |
| ai_tools | AI translate / multi-language | `materials.ai_translates, multi_language_refs, config.multi_language_*` | pro | out_of_scope |  | low |
| ai_tools | Video templates | `(app) templateDraft, AETemplate` | mixed | impossible | impossible: Needs a CapCut-downloaded template bundle (templateDraft / AETemplate cache) from the online template store; not a native draft edit | low |
| color | Basic adjust (brightness, contrast, saturation, exposure, temperature, tint, highlight, shadow, sharpen, vignette, fade, grain, clarity) | `materials.effects[] one per slider, effect_id = resource_id = 7501974767453474064, types: brightness (Exposicion) v2, contrast v3, saturation v1, temperature v3, tone (Tinte) v3, highlight (Iluminar) v3, shadow v3, white '', black '', light_sensation (Luminosidad) '', vignetting v1, sharpen (Enfocar) v1, clear (Claridad) '', particle (Particulas) v2, fade (Desvanecer) '', value = UI/50 for -50..50 sliders; UI/100 for sharpen, clarity, grain, fade (0..100) ...` | free | yes | capcut_set_clip (adjust), capcut_add_adjustment_layer (adjust), capcut_add_keyframes (brightness, contrast, saturation) | high |
| color | HSL | `materials.hsl[] {hsl_color_type (1 = red), hue, saturation, lightness (raw -100..100), custom_color '#FFE64444', resource_id 7501974767453474064}, segment.enable_hsl true` | free | yes | capcut_set_clip (hsl: {red/orange/yellow/green/cyan/blue/purple/magenta: {hue, saturation, lightness}}) | high |
| color | Curves | `materials.color_curves[] {panel 'adjust_collection', luma/red/green/blue [{anchor{x,y}, left_control, right_control, sync_direction_control}] (0..1), select_channel}` | free | yes | capcut_set_clip (curves: {luma/red/green/blue: [[x,y],...]}) | high |
| color | Color wheels | `materials.primary_color_wheels[] {lift/gamma/gain/offset {red, green, blue, luma, saturation}, intensity 1.0, panel 'adjust_collection'}` | pro | yes | capcut_set_clip (color_wheels: {lift/gamma/gain/offset: {red,green,blue,luma,saturation}, intensity}) [Pro] | high |
| color | LUT | `materials.effects[type=lut] {effect_id = resource_id = 7501974767453474064 (adjust bundle), name = file name, path '<cube file>;<adjust bundle folder>', value = intensity/100, version ''}, segment.extra_material_refs; segment.enable_lut true, import copies the file to $USER_DATA/Resources/Lut/<name>/<file>` | free | yes | capcut_set_clip (lut), capcut_add_adjustment_layer (lut) | high |
| color | Auto color / color match / color correct | `segment.enable_smart_color_adjust, enable_color_match_adjust, enable_color_correct_adjust ...` | pro | out_of_scope |  | low |
| keyframes | Keyframes: position, scale, rotation, opacity | `segment.common_keyframes[].property_type (KFTypePositionX/Y, UNIFORM_SCALE, KFTypeRotation, KFTypeAlpha), keyframe_list[].time_offset, values` | free | yes | capcut_add_keyframes | medium |
| keyframes | Keyframes: volume | `common_keyframes[property_type=KFTypeVolume]` | free | yes | capcut_add_keyframes, capcut_duck_music | medium |
| keyframes | Keyframe easing | `keyframe_list[].curveType 'FreeCurveInOut' (default 'Line'), Aceleracion (ease in): start key right_control.x = 0.42 x gap (us); Desaceleracion (ease out): end key left_control.x = -0.42 x gap; both for ease in-out; y stays 0, end key graphID -> top-level keyframe_graph_list[] {id, resource_id 7418178875479298577, resource_name 'Curva', source_platform 1, graph_points []}` | free | yes | capcut_add_keyframes (ease: linear | in | out | in_out) | high |
| keyframes | Draft-level keyframes | `keyframes.{videos,audios,texts,stickers,filters,adjusts,handwrites,effects}` | free | impossible | impossible: Not a separate native feature: CapCut 9 | medium |
| text | Text overlay | `materials.texts[].content (JSON: text, styles[]), tracks[type=text]` | free | yes | capcut_add_text | high |
| text | Font size and color | `styles[].size, styles[].fill.content.solid.color, font_size ...` | free | yes | capcut_add_text, capcut_style_text | high |
| text | Font family | `font_path, font_id, font_resource_id ...` | mixed | partial | capcut_style_text (local font file) | medium |
| text | Bold / italic / underline | `styles[].bold, styles[].italic, styles[].underline ...` | free | yes | capcut_style_text (bold, italic, underline) | high |
| text | Text stroke (border) | `border_color, border_width = UI x 0.002 (40 -> 0.08, 60 -> 0.12), border_alpha 1 ...` | free | yes | capcut_style_text | high |
| text | Text shadow | `has_shadow, shadow_color, shadow_alpha = UI%/100 ...` | free | yes | capcut_style_text | high |
| text | Text background box | `background_color, background_style 1 \| 2 (two box shapes), background_alpha = UI%/100 ...` | free | yes | capcut_style_text (bg_color, bg_alpha, bg_style, bg_round_radius, bg_width, bg_height, bg_offset_x, bg_offset_y) | high |
| text | Per-word color (highlight) | `styles[] with several range [start,end) (UTF-16)` | free | yes | capcut_style_text | medium |
| text | Wrap width and alignment | `line_max_width, force_apply_line_max_width, alignment (0 left, 1 center, 2 right)` | free | yes | capcut_style_text | medium |
| text | Line and letter spacing | `line_spacing, letter_spacing` | free | yes | capcut_style_text (letter_spacing, line_spacing; UI values) | high |
| text | Text style presets (WordArt) | `materials.effects[type=text_effect] {effect_id = resource_id, name, path $USER_DATA/Cache/effect/<id>/<md5>}, text content style: effectStyle {id, path}; fill.content.render_type 'texture' -> png inside the effect folder; border_color '#000000', text segment extra_material_refs` | mixed | partial | capcut_style_text (wordart) | high |
| text | Text bubbles / shapes | `materials.effects[type=text_shape] {sub_type 'manual_stretch', effect_id = resource_id, third_resource_id, category 'bubble', path}, text segment extra_material_refs` | mixed | yes | capcut_style_text (bubble: {resource_id, third_resource_id}) | high |
| text | Text animations: in / out / loop | `materials.material_animations[type=sticker_animation].animations[] {type in\|out\|loop, start, duration, panel '', material_type 'sticker'}` | mixed | yes | capcut_add_animation | high |
| text | Text templates | `materials.text_templates[] {type 'text_template', effect_id = resource_id, name, path $USER_DATA/Cache/artistEffect/<id>/<md5>, resources[{panel default\|fonts\|flower\|text, path, resource_id}], text_info_resources[{text_material_id, attach_info{start_time, duration, clip}}], non_text_info_resources, check_flag 7}, sub-materials: texts[], effects[type=text_effect] (effect_id ''), material_animations (in 1 s), text segment material_id -> text_templates id (not texts)` | mixed | partial | capcut_copy_text_template | high |
| text | Caption templates | `texts[].caption_template_info.{resource_id,effect_id,category_id}` | mixed | partial | capcut_copy_text_template | medium |
| text | Lyrics templates | `texts[].lyrics_template, is_lyric_effect, lyrics_effects` | mixed | out_of_scope |  | low |
| text | Auto captions (speech to text) | `config.subtitle_recognition_id, config.subtitle_taskinfo, texts[].recognize_* ...` | pro | out_of_scope | capcut_add_subtitles (import an external SRT instead) | medium |
| text | SRT import | `texts[] per cue; segment clip.transform.x (-1..1, default 0)` | free | yes | capcut_add_subtitles (optional x) | high |
| text | SRT export | `texts[] -> .srt` | free | yes | capcut_export_srt | high |
| text | Text to speech | `texts[].text_to_audio_ids, tts_auto_update` | mixed | out_of_scope |  | low |
| text | Text on path / curve | `texts[].text_curve {enable false, angle 72} (added with a bubble)` | free | impossible | impossible: No native control in CapCut 9 | medium |
| text | Auto keyword highlight | `subtitle_keywords, subtitle_keywords_config` | unknown | out_of_scope |  | low |
| text | Stickers | `materials.stickers[] {type 'sticker', sticker_id = resource_id, path $USER_DATA/Cache/artistEffect/<id>/<md5>, icon_url (signed), category_id, radius, shadow/border/background fields, shape_param}, tracks[type=sticker] (render_index 14001)` | mixed | yes | capcut_add_sticker (resource_id, start_s, duration_s, x, y, scale, rotation) | high |
| text | Sticker animations | `materials.material_animations[type=sticker_animation].animations[] {type in\|out\|loop, start 0, duration 500000 default, material_type 'sticker', panel '', third_resource_id '0'}, sticker segment extra_material_refs` | mixed | yes | capcut_add_animation (sticker track; in/out/loop) | high |
| audio | Audio clip (music / voice) | `materials.audios[type=extract_music], tracks[type=audio]` | free | yes | capcut_add_audio | high |
| audio | Volume | `segment.volume, last_nonzero_volume` | free | yes | capcut_add_audio, capcut_set_clip (volume, volume_db) | high |
| audio | Audio fades | `materials.audio_fades[].fade_in_duration/fade_out_duration (us), fade_type` | free | yes | capcut_add_audio, capcut_add_clip, capcut_set_clip | high |
| audio | Video-clip audio fades | `materials.audio_fades[] {type 'audio_fade', fade_type 0, fade_in_duration, fade_out_duration (us)} ref in the VIDEO segment's extra_material_refs, materials.videos[].audio_fade = copy of the same object` | free | yes | capcut_add_clip, capcut_set_clip (fade_in_s, fade_out_s; one writer) | high |
| audio | Ducking (music under voice) | `unknown auto-duck field, manual: KFTypeVolume keyframes` | unknown | partial | capcut_duck_music | medium |
| audio | Music library | `materials.audios[type=music] {music_id, category_id, app_id 1775, path $USER_DATA/Cache/music/<md5>.mp3, duration}, a beats material is added automatically` | mixed | impossible | impossible: Needs a CapCut library download (music_id + cached mp3 fetched by CapCut from its online catalog) | high |
| audio | Sound effects library | `materials.audios[type=sound] {effect_id, category_id, path $USER_DATA/Cache/music/<md5>.mp3}` | mixed | impossible | impossible: Needs a CapCut library download (effect_id + cached mp3 fetched by CapCut) | high |
| audio | Voice changer / filters | `materials.audio_effects[] {type 'audio_effect', name, resource_id, category_id 'sound_effect' (Filtros de voz), sub_type 1, audio_adjust_params[{name strength, value 0..1}]}, audios[].check_flag 1 -> 3` | pro | yes | capcut_set_clip (voice_filter: {resource_id, name, strength}) [Pro] | high |
| audio | Noise reduction | `materials.realtime_denoises[] {type 'realtime_denoise', is_denoise true, denoise_mode 1.0, denoise_rate 0.85, path $APP/audiosami/unet_denoise_44k_music_model_v1.0.model, sami_name 'denoise_v2', sami_version '1.0', sami_type 2, is_from_hd_sounds false}, segment.extra_material_refs` | pro | yes | capcut_set_clip (denoise, denoise_rate) | high |
| audio | Loudness normalization | `materials.loudnesses[] {enable, time_range, file_id (md5), target_loudness -23.0, loudness_param{avg_loudness, peak_loudness}}` | pro | impossible | impossible: Needs CapCut analysis: loudness_param {avg_loudness, peak_loudness} and file_id come from CapCut measuring the file | high |
| audio | Beat detection | `materials.beats[] {enable_ai_beats true, mode 1, gear 0 (Ritmo 1) \| 1 (Ritmo 2), gear_count 2, user_delete_ai_beats{melody_0, beat_0..4}, ai_beats{beats_path .beat, melody_percents}}` | free | impossible | impossible: Needs CapCut analysis: beat times live in an analysed  | high |
| audio | Vocal isolation | `materials.vocal_separations[].choice` | unknown | out_of_scope | default (choice 0) written with every clip | medium |
| audio | Pitch / pan / balance / channel mapping | `materials.sound_channel_mappings[] {type 'none', audio_channel_mapping 0 none \| 1 left->right \| 2 right->left, is_config_open}, audio_pitch_shifts, audio_pannings, audio_balances (arrays stay empty; no UI control found)` | free | partial | capcut_set_clip (audio_channel) | medium |
| audio | Voice enhance | `materials.vocal_beautifys` | pro | out_of_scope |  | low |
| audio | Voice-over recording | `config.record_audio_last_index` | free | impossible | impossible: Needs a live microphone recording inside CapCut | low |
| export | Export resolution | `not in draft (export panel), config.export_range` | mixed | impossible | impossible: Not persisted in the draft: chosen in the Export dialog at render time (480P-8K) | medium |
| export | Export frame rate | `not in draft` | mixed | impossible | impossible: Not persisted in the draft: chosen in the Export dialog at render time (24-60, 29 | medium |
| export | Export bitrate | `not in draft` | free | impossible | impossible: Not persisted in the draft: chosen in the Export dialog at render time | medium |
| export | Export codec and format | `not in draft (export dialog)` | mixed | impossible | impossible: Not persisted in the draft: chosen in the Export dialog (H | high |
| export | Watermark removal | `not in draft` | pro | impossible | impossible: Render-time export option (Pro), not a draft field | medium |
| project | Pro gating per resource | `cache business_info.is_vip / paid_type, videos[].pre_applied_vip_materials` | n/a | partial | capcut_features.json resource counts | medium |

## Resource ids found locally

17166 resources were in the local panel cache (only panels opened on this Mac; not the full catalog). Top groups:

- type 10 fonts: 5450 (2624 Pro)
- type 13 video animations (panel video + in/out/group): 3658 (584 Pro)
- type 48 caption templates: 2998 (1074 Pro)
- type 58 digital humans: 1447 (0 Pro)
- type 11 text-to-speech voices: 1046 (909 Pro)
- type 18 text animations: 856 (82 Pro)
- type 26 voice changer: 361 (261 Pro)
- type 49 unlabelled: 240 (0 Pro)
- type 46 AI painting styles: 235 (0 Pro)
- type 27 canvas / misc (unlabelled): 171 (4 Pro)
- type 34 text bubbles? (unlabelled): 143 (0 Pro)
- type 1 text styles (WordArt): 121 (30 Pro)
- type 22 makeup: 103 (79 Pro)
- type 35 in/out/loop animations (sticker?): 57 (0 Pro)

Verified small id tables are in `verified_ids` (blend modes, masks, speed curves, keyframe curves). Transitions, filters, video effects, stickers, music and sound FX were **not** in the cache; the UI diff gave 1-2 ids each (see `ids` in the JSON). Session 3 re-read the cache (21409 ids). Session 4 added `resource_catalog.cached_ids_session4` to the JSON: every cached id of the first panel tab with title and is_vip: 50 transitions (27 Pro), 50 filters (29 Pro), 100 scene effects (66 Pro), 50 body effects (34 Pro), 50 stickers (34 Pro), 240 text bubbles (all free). Only the Tendencias / Destacado tab is cached, so categories are that one tab; `is_vip` can disagree with the UI.

## Pro vs free

- Per resource: the cache stores `is_vip` and `paid_type: subscribe` (see counts above). Desktop lets you preview Pro items; export needs Pro ([help](https://www.capcut.com/help/why-prompted-to-purchase-capcut-pro)).
- Pro-only features per CapCut docs: auto captions, background removal, motion tracking, noise reduction, AI video/image, 4K/60 fps export, watermark removal ([standard vs pro](https://www.capcut.com/resource/capcut-standard-vs-pro)). Blue diamond = Standard plan, purple = Pro ([help](https://www.capcut.com/help/standard-version-access-to-diamond-items)).
- capcut-mcp writes no Pro resource ids. Blend modes, masks, speed curves and keyframe curves in the local cache are all free. Exception to watch: the speed-curve tab shows a Pro diamond in 9.5 even though its cache ids are free; `capcut_set_speed_curve` says so in its description.

## Export profiles

Export settings are not in the draft (CapCut's export panel). Desktop: resolution up to 3840x2160, up to 60 fps, bitrate Recommended / Higher / Custom (Kbps), H.264 or HEVC in MP4 ([help](https://www.capcut.com/help/export-videos-in-capcut)). Rendering stays out of scope (GAPS #18).

## UI diff results (2026-10-03)

Scratch project `<scratch-project>` (CapCut named it; two copies of `long_shot1_testsrc.mp4`), CapCut 9.5.0 on a Pro account. Driven with osascript + cliclick + screencapture; one change per step; autosave; `draft_info.json` copied and diffed. No login, purchase, cloud AI, export or network capture.

| Finding | Draft shape |
|---|---|
| C6 track order | `tracks[]` order is the layer order (bottom to top), grouped by type: video, effect, text, sticker, adjust, audio. `segment.track_render_index` = track index. `render_index`: main video 0, overlay video 1 (track `flag` 2), effect 11000, text 14000, sticker 14001. |
| C7 volume vs dB | `segment.volume = 10^(dB/20)`: -20 dB = 0.1, -10.5 dB = 0.2985 (so 0.3 = -10.46 dB), 0 dB = 1.0, +6 dB = 1.995, +20 dB (UI max) = 10.0, -60 dB = 0. |
| Transition | `materials.transitions[]` (effect_id = resource_id, duration us, `is_overlap` true), ref on the LEFT clip. Max about half the shorter clip (2.47 s on 5 s clips). Combinar `6724845717472416269` free, Tinta venenosa `7679652398452755719` Pro. |
| Filter | `materials.effects[type=filter]`, `value` = intensity/100. Rollo vintage `7668224318974823701` free. |
| Basic adjust | one `materials.effects[]` per slider (`temperature`, `saturation`, `brightness` = UI Exposicion), resource `7501974767453474064`, value = UI/50. |
| HSL / curves / wheels | `materials.hsl` (color type 1 = red, raw -100..100), `color_curves` (bezier anchors 0..1), `primary_color_wheels` (lift/gamma/gain/offset). Wheels are Pro. |
| Speed curve | `speeds[].mode` 1, `curve_speed {id, name, speed_points}`, speed = average. Montaje `6768648600848175619`. Curve tab is Pro. |
| Mask / chroma | `common_mask` Circle uses `7374021188315517456` (not the cache id). `chromas` color stays empty until picked. |
| Animations | `material_animations[type=sticker_animation].animations[]`: video in Zoom 1 `6740868384637850120`, out Humo `7229983825080619522`; text in Maquina de escribir `7210980292243231233`, loop `7672949037338791182` (text uses `material_type` sticker). |
| Video effect | `video_effects[]` + `effect` track (render_index 11000), `adjust_params` speed/intensity/texture/color. Grafiti de tiza `7434872753355756048`. |
| Sticker / music / SFX | `stickers[]` (`Cache/artistEffect`), `audios[type=music]` (`music_id`, cached mp3), `audios[type=sound]` (`effect_id`); each library audio adds a `beats` entry. |
| Voice filter / normalize | `audio_effects[]` (Voz llena, Pro, `strength` 0..1); `loudnesses[]` (target -23 LUFS, measured avg/peak, Pro). |
| Markers | top-level `time_marks.mark_items[]` {time_range (duration 0), color `#00c1cd`, title}. `capcut_export_chapters` prints them as `HH:MM:SS Title`. |
| Reverse / freeze | `segment.reverse` + rendered `reverse_path`; freeze splits the clip and adds a photo segment from an extracted .jpg (`videos[].freeze`). Both need generated files. |
| Adjustment layer | `tracks[type=adjust]` segment -> `materials.placeholders[type=adjust]`, `enable_adjust/hsl/lut` true, `config.adjust_max_index`. |
| Export dialog | not in draft: 480P-8K, H.264 / HEVC / HEVC alpha / ProRes 422, LT, HQ, 4444, mov or mp4, 24-60 fps (29.97, 59.94). Watermark removal and optical flow are Pro. Dialog cancelled. |

No `is_vip` field appears in the draft when a Pro item is applied; Pro shows only as a diamond in the UI. On this Pro account nothing was blocked.

## UI diff session 2 (2026-10-03, 20:10-20:26)

Test clip with sound: 8 s ffmpeg `testsrc2` + macOS `say` voice + pink noise. LUT: a 2x2x2 `.cube` made on the Mac.

| Finding | Draft shape |
|---|---|
| Video-clip audio fades | `materials.audio_fades[]` (same shape as audio clips) ref on the video segment, plus a copy in `materials.videos[].audio_fade`. 1 s -> 1000000, 1.5 s -> 1500000. |
| Noise reduction | `materials.realtime_denoises[]` {is_denoise true, denoise_mode 1, denoise_rate 0.85, local model path `$APP/audiosami/unet_denoise_44k_music_model_v1.0.model`, sami_name `denoise_v2`}. Pro diamond; local model. |
| Voice changer on a video clip | same `audio_effects[]` shape; `videos[].check_flag` gains bit 2048. Dulce `7320193577613529602` (Pro). |
| WordArt | `effects[type=text_effect]` + text style `effectStyle {id, path}` with a texture fill from the effect folder. `7678508573365751057` free. |
| Text bubble | `effects[type=text_shape]` (sub_type `manual_stretch`, category bubble). `7446995323060227333` free. Also adds `texts[].text_curve {enable false, angle 72}`. |
| Text template | `text_templates[]` (6 bundled resources, `text_info_resources`), plus a text, a text_effect and an in animation; the text segment points to the template. BAM! `7599479427805793544`. Too complex to write from scratch. |
| Body effect | `video_effects[type=face_effect]` on the effect track, `algorithm_artifact_path` = placeholder path CapCut fills. Figura neon `7688574067632377106` free. |
| Effect render_index | 11000 + number of effect segments already present (second effect got 11001 though it starts earlier). |
| Sticker animation | `material_animations[type=sticker_animation]`, `material_type` sticker, default 0.5 s. Tabs: Entrada, Salida, Bucle. Pliegue `7598471787764141329`. |
| Combo animation | `animations[] type group`, start 0, duration = whole clip. Zoom 1 combo `6759078592740594184` free. |
| LUT (panel only) | Import: left tab Ajuste > LUT > Importar (CUBE, 3DL). Apply: right panel Ajustar > Basico > LUT > Nombre, Intensidad 0-100. No Pro diamond. Draft JSON not captured (Mac offline). |


## UI diff session 3 (2026-10-03, 22:10-22:24)

LUT (`effects[type=lut]`, resource `7501974767453474064`, path `<cube>;<bundle>`, value = intensity/100), all 15 basic-adjust sliders, keyframe easing (FreeCurveInOut, 0.42 x gap handles, `keyframe_graph_list`), compound clip (`materials.drafts[type=combination]` + `subdraft/<id>/`), stabilization level 2, canvas colour (lowercase `#rrggbbaa`) and blur levels, auto beats (`enable_ai_beats`, gear 0/1). Details per feature in the JSON.

## UI diff session 4 (2026-10-03, 22:32-22:56)

Native editing only (<owner>, 22:33). Samples in the fixture under `_about4`.

| Finding | Draft shape |
|---|---|
| Stabilization | `videos[].stable.stable_level`: 0 off, 1 Corte minimo, 2 Recomendado, 3 Mas estable. Nothing else changes; `matrix_path` stays empty (CapCut computes it). Pro, local. |
| Channel mapping | Audio > Basico > Completar canal: `sound_channel_mappings[].audio_channel_mapping` 0 none, 1 left to right, 2 right to left; `is_config_open` true when on. |
| Pitch / pan / balance | No control in Audio > Basico (video clip or SFX clip) in 9.5 Mac. `audio_pitch_shifts`, `audio_pannings`, `audio_balances` stay empty. Not writable from evidence. |
| Video stroke / shadow / radius | No control in Video > Basico for a video clip. `video_strokes`, `video_shadows`, `video_radius` stay empty. |
| Text stroke | Texto > Basico > Trazo: `border_width` = UI x 0.002 (40 -> 0.08, 60 -> 0.12); content `strokes[{width, mode 0, content{solid{color}, render_type solid}}]`; `check_flag` bit 8. Disabled while WordArt is on. |
| Text background | Fondo: `background_style` 1 or 2, `background_alpha` / `round_radius` / `height` / `width` = UI%/100 (defaults 1, 0, 0.14, 0.14), `vertical_offset` / `horizontal_offset` = (UI% - 50)/50; bit 16. Not mirrored in content. |
| Text shadow | Sombra: `shadow_alpha` = UI%/100, `shadow_smoothing` = blur% x 0.03, content `diffuse` = blur%/600, `shadow_distance` / `shadow_angle` = UI, `shadow_point` = 0.18 x distance x (cos, sin); bit 32. |
| Masks | `common_mask[].config`: width / height = px / canvas size (defaults 0.28 x 0.5), centerX / centerY = px / half canvas, rotation deg, feather and roundCorner = UI/100, invert. Shape ids: line Dividir 7374020197990011409 (folder 1068046523, height 0); mirror Rollo de pelicula 7374021024985125377 (1068046521); circle Circulo 7374021188315517456 (1068046525); rectangle Rectangulo 7374021450748924432 (1068046526); pentagram Estrellas 7665298069453279761 (4711700584, aspectRatio 1.0471); heart Corazon 7350964630979613186 (1068046520, aspectRatio 1.1148); text Texto 7439320146876830225 (1220399932, uses text_config). Brush and pen are Pro, not covered. |
| Chroma key colour | Swatch has no hex input; the eyedropper pick shows in the UI but `chromas[].color` stays empty and `attachment_editing.json` says `is_use_chroma_key` false. Probably only in the encrypted part of the draft. No writer. |
| WordArt removal | Efectos > Restablecer removes the `text_effect` material and both refs, the texture fill and `effectStyle`. |
| WordArt writer (session 5) | `<Cache>/effect/<id>/<md5>/effectStyle.json` `fill.content.texture` gives `path` (file in the folder), `range`, `scale`; CapCut copies these three into `styles[].fill.content.texture` with `render_type` texture. Built: `capcut_style_text {wordart: id \| null}`; texture verified, solid not seen in a save, gradient refused. |

Session 5 (2026-10-03 23:10, no GUI, read-only cache): WordArt writer built (`capcut_style_text` `wordart`, from the downloaded `effectStyle.json`), WordArt no -> partial. Speed curve: point format known, average-speed formula still not reproducible (see below), so no `capcut_set_speed_curve`. Mask params were already covered by session 4.

UI diff session 6 (2026-10-03 23:18-23:24, 12 steps, speed curves only): **speed-curve rule found**: average speed = 1 / sum(dx / mean(y_i, y_i+1)) over the points (straight segments, harmonic over time), matching all 10 stored values to 1e-7; clip length = source / average, nearest frame. New tool `capcut_set_speed_curve` (6 presets, custom points, null).

Feasibility (no UI needed): compound clip writer = copy a CapCut-made subdraft; not built (embedded draft, cover and config ids; one sample only). Auto beats come from an analysis file; no non-AI writer. Speed-curve average formula, blend `effect_id` choice and export bitrate list stay as before.

Batch 11 (no new UI diff): a `capcut_add_cuts` keep entry may carry `x`, `y` and `scale`, written by the same transform code as `capcut_set_clip`. `srt_out` writes the remapped SRT on the draft frame grid and never overwrites. `capcut_make_short` `sub_style` and `title_style` call `capcut_style_text`.

## Out of scope (AI/cloud, <owner> 2026-10-03)

Retouch: face beauty / skin, Face reshape, Body reshape, Makeup, Relight, Quality: enhance, denoise, deflicker, motion blur, Camera tracking / lens lock / smart motion, Background removal (auto cutout), Auto reframe, Auto cut / AI shorts, Digital humans / AI avatars, AI translate / multi-language, Auto color / color match / color correct, Lyrics templates, Auto captions (speech to text), Text to speech, Auto keyword highlight, Vocal isolation, Voice enhance. Marked `status: out_of_scope` in the JSON and left out of every count. Noise reduction (local model) and stabilization (local) stay in scope.

## Still unknown (5 low confidence, in scope)

Color space and HDR, Combination presets, Corner pin / surface tracking, Video templates, Voice-over recording.

Open questions at medium: chroma key colour, pitch / pan / balance (no UI), blend `effect_id` vs panel id, bubble writer (`sub_type` per resource, e.g. `manual_stretch`, not in the cache files), solid / gradient WordArt saves.

## Next UI session (needs <owner>'s OK, Mac not in use)

About 10 min on `<scratch-project>`: blend mode (which id CapCut writes in `effect_id`), mask stroke (`video_mask_stroke`), manual beat points, glow (Brillo) on text, export bitrate dropdown. `<scratch-project>` stays (<owner> wants to keep it).
