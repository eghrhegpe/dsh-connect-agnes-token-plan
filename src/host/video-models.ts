/**
 * The Agnes VIDEO model roster — family recognition and catalog selection.
 *
 * Part of the 2026-10 split of `video.ts` (see that file's header for the
 * family map; behaviour was frozen by `video.test.mjs` before and after).
 * This module owns the two questions that are about the CATALOG rather than
 * the wire:
 *
 *   - WHICH entries are video models — delegated to `modality.ts`, so this
 *     roster and the chat roster can never disagree about which entries exist;
 *   - WHICH family each video model speaks — the platform's own naming carries
 *     the generation (`2.5` in the id means the seconds scheme), so the split
 *     needs no table.
 *
 * The catalog lists two families that speak MUTUALLY EXCLUSIVE parameter
 * systems: the V2.0 family (`agnes-video-v2.0`) takes `width` / `height` /
 * `num_frames` / `frame_rate` (`video-protocol.ts`), and the 2.5 family
 * (`agnes-video-2.5` / `agnes-video-2.5-flash`) takes `mode` / `seconds` /
 * `size` / `aspect_ratio` (`video-protocol-25.ts`). {@link pickVideoModel}
 * may address EITHER family, and the tool dispatches the matching body
 * builder per model. `2.5-flash` is tighter (720P only, ≤5 reference images)
 * and is converged by {@link isVideo25Flash} rather than being silently sent
 * a 400.
 *
 * @module dsh-connect-agnes-token-plan/video-models
 */

import { str } from "./util.ts";
import { isVideoGenModel } from "./modality.ts";

/**
 * The documented V2.0 model id.
 *
 * Only a last-resort label for messages and schema defaults: the model actually
 * dispatched is always resolved from the live catalog (or an explicit
 * `model` / `videoModelId`), so an upstream rename needs no code change here.
 */
export const VIDEO_DEFAULT_MODEL = "agnes-video-v2.0";

/**
 * Whether a model id belongs to the 2.5 family (a DIFFERENT parameter system).
 *
 * The platform's own naming carries the generation, so the split needs no
 * table: anything with `2.5` in it speaks `mode`/`seconds`/`size`, everything
 * else speaks the V2.0 `width`/`num_frames`/`frame_rate` system.
 * @param {string} model - the catalog id.
 * @returns {boolean}
 */
export function isVideo25Family(model) {
  return /2\.5/.test(str(model, ""));
}

/**
 * Whether a model id is the `-flash` variant of the 2.5 family.
 *
 * Flash is the same parameter system with TIGHTER limits (720P only, ≤5
 * reference images); the split is by name, the same no-table approach as
 * {@link isVideo25Family}.
 * @param {string} model - the catalog id.
 * @returns {boolean}
 */
export function isVideo25Flash(model) {
  return isVideo25Family(model) && /flash/i.test(str(model, ""));
}

/**
 * The video-generation model ids of one catalog, de-duplicated in first-seen order.
 *
 * Recognition is delegated to `modality.ts`, so this list and the chat roster
 * can never disagree about which entries exist.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function videoGenModelIds(entries) {
  const position = new Map();
  const out: string[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isVideoGenModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    if (position.has(id)) {
      out[position.get(id)] = id;
    } else {
      position.set(id, out.length);
      out.push(id);
    }
  }
  return out;
}

/**
 * The subset of video ids this module can actually address — the V2.0 family.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function videoV2ModelIds(entries) {
  return videoGenModelIds(entries).filter((id) => !isVideo25Family(id));
}

/**
 * The subset of video ids that speak the 2.5 parameter system
 * (`mode` / `seconds` / `size` / `aspect_ratio`).
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function video25ModelIds(entries) {
  return videoGenModelIds(entries).filter((id) => isVideo25Family(id));
}

/**
 * Choose the model one video call addresses.
 *
 * Precedence mirrors `pickDrawModel`: an explicitly requested id wins even when
 * the catalog does not list it (a manual override — the platform answers the
 * error itself if the id is wrong), then the configured preference when the
 * catalog confirms it (ANY family — a 2.5 preference is honoured, because the
 * tool now drives both systems), then the auto-pick: the first V2.0 id, and
 * only when the catalog holds NO V2.0 model at all does it fall through to the
 * first 2.5 id. An empty catalog yields `null`, and the caller turns that into
 * an actionable message rather than dispatching a request.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string} [requested] - the tool call's `model` parameter.
 * @param {string} [preferred] - the configured default (`videoModelId`).
 * @returns {string|null} the chosen id, or `null` when nothing can be picked.
 */
export function pickVideoModel(entries, requested, preferred) {
  const want = str(requested, "").trim();
  if (want !== "") return want;
  const allVideo = videoGenModelIds(entries);
  if (allVideo.length === 0) return null;
  const config = str(preferred, "").trim();
  if (config !== "" && allVideo.includes(config)) return config;
  const v2 = videoV2ModelIds(entries);
  if (v2.length > 0) return v2[0];
  return allVideo[0];
}
