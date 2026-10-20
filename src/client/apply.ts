/**
 * The Host-facing mount: dictionary registration, the plugin config card, and
 * the composer usage pill.
 *
 * The panel lives inside the Plugins page (`plugins.bundle.config` slot) —
 * it appears as an inline card between the bundle description and the Loader
 * row, always expanded (`view: "page"` only, no summary state). There is no
 * sidebar entry and no standalone `main` page; the user reaches it by
 * opening the Plugins panel and navigating to this bundle.
 *
 * The pill is the plugin's ONE surface outside that page: the
 * `conversation.input.right` seat in a session's composer, which shows the
 * console quota of the model that session is actually pointed at. Both mounts
 * fail soft and independently — a shell that refuses one still gets the other.
 */
import { NS } from "./const.ts";
import { en, zh } from "./i18n.ts";
import { PanelPage } from "./panel-page.ts";
import { ComposerUsagePill } from "./composer-usage-pill.ts";
import type { Tt } from "./runtime.ts";

/** Required services: the slot system, the locale registry. */
export const inject = ["slots", "locale"];

/** The minimal client-root face `apply` touches; the rest of ctx is opaque. */
export interface ClientCtx {
  effect: (fn: () => unknown, name?: string) => unknown;
  locale: {
    register: (ns: string, dicts: { zh: typeof zh; en: typeof en }) => unknown;
    bind: (ns: string) => (key: string) => string;
    subscribe: (fn: () => void) => unknown;
  };
  slots: {
    inject: (slot: string, register: () => unknown) => unknown;
    register: (declaration: Record<string, unknown>, component: unknown) => unknown;
  };
}

/**
 * Register the dictionaries and the plugin config card.
 *
 * The card is rendered inside the Plugins page by the Host's
 * `renderSlot("plugins.bundle.config", …)` call. No `onClose` is passed —
 * the Plugins page owns navigation; the card has no close button.
 */
export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en });
    } catch {
      return () => {};
    }
  }, `${NS}: dictionaries`);

  let translate: Tt = (key) => key;
  try {
    translate = ctx.locale.bind(NS);
  } catch {
    // A shell without the locale service still renders the keys.
  }
  const tt: Tt = (key) => {
    try {
      return translate(key);
    } catch {
      return key;
    }
  };

  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: NS,
            locale: NS,
            inject: () => ({ tt, localeSubscribe: ctx.locale.subscribe.bind(ctx.locale) })
          },
          PanelPage
        )
      ) as () => void
    );
  } catch (error) {
    // No `redactSecrets` here, on purpose. What this catches is the slot
    // system's registration failure — built from this plugin's own registration
    // data, with no upstream HTTP body anywhere on the path — so there is no
    // credential in it to strip. The client half also cannot reach the Host's
    // redaction helper (the two-halves boundary in `docs/ARCHITECTURE.md`, and
    // `test/dup-gate.mjs` would flag a copied rule set), so the alternative is
    // a second list that drifts from the first — the failure mode that let a
    // `Basic` value stand in the Host's rules until 2026-10-20. Sister plugins
    // warn the same way.
    console.warn(`[${NS}] config card registration failed:`, error);
  }

  // The composer usage pill: the `conversation.input.right` seat. The slot
  // system materializes this component's `useProjection` prop itself (a
  // session-scoped keyed hook, strictly required — a missing source throws
  // `SlotAssemblyError`), so `inject` here only supplies the plugin's own
  // dictionary lookup. A registration failure degrades exactly like the card's
  // above (§5 invariant 2): the panel keeps working and this module is absent.
  try {
    disposers.push(
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: `${NS}-composer-pill`,
            locale: NS,
            // List seats sort occupants by `order` ascending (default 0, ties
            // keep registration order). DSH's own conversation bundle renders
            // this seat but ships no built-in entries — it is plugin-only — so
            // 4 is not a contractual seat position; it merely sorts this pill
            // after default-0 occupants if another plugin ever registers here.
            order: 4,
            inject: () => ({ tt })
          },
          ComposerUsagePill
        )
      ) as () => void
    );
  } catch (error) {
    // Same reasoning as the card's catch above: a registration failure, not an
    // upstream body.
    console.warn(`[${NS}] composer pill registration failed:`, error);
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Already released with its owning declaration.
      }
    }
  }, `${NS}: ui mounts`);
}
