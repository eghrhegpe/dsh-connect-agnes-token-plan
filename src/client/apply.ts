/**
 * The Host-facing mount: dictionary registration, the sidebar row, and the
 * main-slot page. Verbatim logic from the pre-split `client.js`.
 */
import { PanelIcon } from "./cards.js";
import { NS, PANEL_ID } from "./const.js";
import { en, zh } from "./i18n.js";
import { PanelPage } from "./panel-page.js";
import type { Tt } from "./runtime.js";

/** Required services: the slot system, the locale registry, the layout face. */
export const inject = ["slots", "locale"];

/** The minimal client-root face `apply` touches; the rest of ctx is opaque. */
export interface ClientCtx {
  effect: (fn: () => unknown, name?: string) => unknown;
  get: (id: string) => unknown;
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
 * Register the dictionaries, the sidebar row, and the main-slot page.
 */
export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en });
    } catch {
      return () => {};
    }
  }, "dsh-connect-sensenova-token-plan: dictionaries");

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

  const close = () => {
    try {
      (ctx.get("layout") as { selectPanel?: (id: null) => void } | undefined)?.selectPanel?.(null);
    } catch {
      // A shell without the layout face has nothing to close.
    }
  };

  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, label: () => tt("entry.label") },
          PanelIcon
        )
      ) as () => void
    );
  } catch (error) {
    console.warn("[dsh-connect-sensenova-token-plan] sidebar row registration failed:", error);
  }
  try {
    disposers.push(
      ctx.slots.inject("main", () =>
        ctx.slots.register(
          { name: "main", key: PANEL_ID, locale: NS, inject: () => ({ onClose: close, tt, localeSubscribe: ctx.locale.subscribe.bind(ctx.locale) }) },
          PanelPage
        )
      ) as () => void
    );
  } catch (error) {
    console.warn("[dsh-connect-sensenova-token-plan] panel page registration failed:", error);
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Already released with its owning declaration.
      }
    }
  }, "dsh-connect-sensenova-token-plan: ui mounts");
}
