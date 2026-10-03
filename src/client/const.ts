/**
 * The bundle id and the same-origin routes the client half talks to.
 *
 * `PANEL_ID` is the ONE client-side spelling of the bundle id: the Host names
 * the same string in `host-config.ts` (`name`), and every route on both sides
 * is derived from it. The client cannot import the Host, so the routes are
 * spelled out here as literals — but they are built from this one constant
 * rather than hand-written per route, and `test/contract.test.mjs` §11 parses
 * both sides and fails when the two sets of paths stop matching.
 */

/**
 * The bundle id: the Host's `name`, the route prefix, the locale namespace
 * and the config-card slot key are all the same string.
 */
export const PANEL_ID = "dsh-connect-agnes-token-plan";

/** Dictionary namespace this plugin owns (same string as {@link PANEL_ID}). */
export const NS = PANEL_ID;

/** The Host snapshot route. Relative, same-origin. */
export const SNAPSHOT_PATH = `/api/${PANEL_ID}/snapshot`;

/** The account route: lets the panel configure itself, no `.env` editing. */
export const ACCOUNT_PATH = `/api/${PANEL_ID}/account`;

/** The inference API-key route: saves the provider's API key (free `sk-…` or Token Plan `cpk-…`). */
export const API_KEY_PATH = `/api/${PANEL_ID}/api-key`;

/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
export const PROVIDER_PATH = `/api/${PANEL_ID}/provider`;

/** The model-roster route: which of this key's models get pushed to DSH. */
export const MODELS_PATH = `/api/${PANEL_ID}/models`;

/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
export const DRAW_PATH = `/api/${PANEL_ID}/draw`;

/** The video-tool switch route (mirrors `DRAW_PATH`; the tool drives both video parameter families). */
export const VIDEO_PATH = `/api/${PANEL_ID}/video`;

/** The AgnesCode provider route (third upstream provider, ROADMAP §6.3). */
export const AGNESCODE_PATH = `/api/${PANEL_ID}/agnescode`;

/**
 * The official sign-up / Token Plan console entry. The panel points new
 * users here to register and obtain their free quota (account + API key).
 * A plain public URL — the client only ever opens it in a new tab, never
 * sends it in a credentialed request.
 */
export const AGNES_SIGNUP_URL = "https://platform.agnes-ai.cn";

/**
 * The AgnesCode（爱思编程）product page — where the desktop App comes from.
 * Same discipline as {@link AGNES_SIGNUP_URL}: plain public URL, opened in a
 * new tab only, never a credentialed request target.
 */
export const AGNESCODE_SITE_URL = "https://agnes-ai.cn/agnescode";