/**
 * The site selector every two-row card shares (ADR-021 / ADR-023).
 *
 * This plugin serves TWO upstreams, and BOTH now run on two co-existing site
 * rows (a site is a namespace): the console quota and inference key on
 * `agnes-token-plan` / `agnes-token-plan-intl`, the desktop-app credit pool on
 * `agnescode` / `agnescode-intl`. That is four provider rows and three tabs,
 * and each tab has to answer the same question before anything else: WHICH
 * site am I looking at?
 *
 * It used to answer that question two different ways — the quota and API tabs
 * laid the two sites out as SIDE-BY-SIDE CARDS, while the AgnesCode tab put a
 * pair of buttons at the top of ONE card. Two shapes for one idea is the thing
 * this module removes: the reader learns "a card is an upstream, and the
 * segment picks the site inside it" once, and it holds on every tab.
 *
 * WHY NOT SIDE-BY-SIDE CARDS, which is what this replaces:
 *   - a machine that holds only ONE site's account (the ordinary case) got a
 *     permanently empty card saying「未配置」on every tab, spending a whole
 *     section's height on an absence;
 *   - the two cards were NOT the same shape (on the API tab the CN key editor
 *     lived in its own third card while the INTL key editor sat inside the
 *     INTL card), so "compare the two sites" was never actually possible;
 *   - and with four provider rows the four-cards-per-tab layout pushes the
 *     reader past a screen of chrome before the first number.
 *
 * WHAT THE SEGMENT IS, AND IS NOT. It is a VIEW SELECTOR: clicking it changes
 * which site's facts are on screen and nothing else. It is NOT a power switch
 * and NOT a routing control — the per-site registration switch stays inside
 * the selected panel, writes its own state file, and a flip of THIS control
 * never reroutes an in-flight request. That distinction is the whole reason
 * ADR-021 and ADR-023 rejected a global "current site" switch: a real site
 * switch is a global non-atomic knob that redirects work mid-flight, and a CN
 * credential aimed at the INTL gateway is a guaranteed 401. A view selector
 * carries none of that risk, so it is allowed where the knob was not.
 *
 * WHY THE DOT IS LOAD-BEARING. Without it the segment would HIDE the other
 * site's state — you would have to click into a site to learn whether it is
 * even configured, which is worse than the two cards this replaces. The dot
 * says that up front, so the collapsed half still reports. Its three tones are
 * the same three questions on every tab: `ok` = configured and serving,
 * `warn` = switched on but not usable yet, `off` = never set up.
 */
import { h } from "./runtime.ts";
import { S } from "./styles.ts";
import type { Tt } from "./runtime.ts";

/** The two sites. Same two keys on every tab (ADR-021 / ADR-023). */
export type Site = "cn" | "intl";

/**
 * How one site's dot reads: the collapsed half must still be able to say
 * whether it is usable, or selecting a site would be the only way to find out.
 *
 * `ok`      — configured and serving (registered / signed in);
 * `warn`    — the site is ON but not usable yet (switched on, no key / no login);
 * `off`     — nothing has been set up here (the ordinary state of the site the
 *             reader does not own);
 * `unknown` — this view has NO READING for that site, so it makes no claim.
 *
 * `unknown` exists because the two upstreams do not gather their facts the same
 * way: the quota/API cards read BOTH sites out of ONE snapshot, so they always
 * know both and never use `unknown`; the AgnesCode tab reads ONE site's route at
 * a time (each row has its own store and its own 60 s poll), so before the
 * reader has ever visited a site it genuinely does not know. The first version
 * of this tab filled that gap with `off` = 「未启用」, which printed a false
 * claim over a registered, signed-in row — so the fourth tone is not padding,
 * it is the difference between "off" and "I have not looked".
 */
export type SiteTone = "ok" | "warn" | "off" | "unknown";

/** One segment: which site, what it is called, and how it currently reads. */
export interface SiteOption {
  site: Site;
  label: string;
  tone: SiteTone;
}

/** The dot ink per tone. One map, so render and tests agree by construction. */
const TONE_INK: Record<SiteTone, Record<string, unknown>> = {
  // The success / warn aliases already exist for the pill's tier dots; the two
  // "no good news" tones reuse the same neutral the "unknown" tier uses,
  // because "not set up" and "not readable" are the same amount of ink.
  ok: S.pillTierOk,
  warn: S.pillTierWarn,
  off: S.pillTierUnknown,
  unknown: S.pillTierUnknown
};

/**
 * The dictionary key that names one tone in words.
 *
 * The dot is `aria-hidden` on purpose (it duplicates a state the button's own
 * label would otherwise have to spell), but a colour with NO textual form
 * anywhere is unreadable for a colour-blind reader and for a screen reader
 * alike. So the words ride the button's `title`: visible on hover, announced
 * where the browser exposes it, and never a second paragraph of chrome.
 */
const TONE_KEY: Record<SiteTone, string> = {
  ok: "site.toneOk",
  warn: "site.toneWarn",
  off: "site.toneOff",
  unknown: "site.toneUnknown"
};

/**
 * Resolve one tone from the two booleans every card already has.
 *
 * Kept here — not inlined per card — so the three tabs cannot drift into
 * calling the same combination by different names ("已注册" on one card,
 * "running" on another). The mapping is deliberately the same for all three:
 * a row that is switched on but cannot serve is `warn` everywhere.
 * @param {boolean} on - the row's effective registration / switch value.
 * @param {boolean} serving - whether it is actually registered / signed in.
 * @returns {SiteTone} the tone.
 */
export function siteTone(on: boolean, serving: boolean): SiteTone {
  if (!on) return "off";
  return serving ? "ok" : "warn";
}

/**
 * The segmented site selector.
 *
 * A native `role="tablist"` of real buttons: no custom widget (this repo draws
 * no bespoke controls beyond the shared `Switch`), keyboard-reachable for
 * free, and announced as a tab set rather than as decoration.
 *
 * @param {object} props
 * @param {SiteOption[]} props.options - the sites, in display order.
 * @param {Site} props.active - the site currently on screen.
 * @param {(site: Site) => void} props.onSelect - called ONLY on a real change;
 *   the active segment is a no-op so a stray click cannot retire an in-flight
 *   read for nothing.
 * @param {Tt} props.tt - the dictionary.
 * @param {string} [props.className] - test selector for this instance.
 * @returns {unknown} the selector.
 */
export function SiteTabs({ options, active, onSelect, tt, className }: {
  options: SiteOption[];
  active: Site;
  onSelect: (site: Site) => void;
  tt: Tt;
  className?: string;
}) {
  return h(
    "div",
    {
      role: "tablist",
      "aria-label": tt("site.label"),
      "data-dsh-agnes-sites": "true",
      ...(className === undefined ? {} : { className }),
      style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }
    },
    options.map((option) => {
      const selected = option.site === active;
      return h(
        "button",
        {
          key: option.site,
          type: "button",
          role: "tab",
          "aria-selected": selected,
          // The tone in words, so the colour is never the only carrier of the
          // state. Hover on the button, and exposed to assistive tech wherever
          // the browser surfaces `title`.
          title: tt(TONE_KEY[option.tone]),
          "data-site": option.site,
          "data-tone": option.tone,
          onClick: () => {
            if (selected) return;
            onSelect(option.site);
          },
          style: {
            appearance: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            fontSize: 12,
            cursor: "pointer",
            // The selected segment is the panel's own card surface; an
            // unselected one is the bare page, so the selected half reads as
            // "this is on screen" without a second colour system.
            background: selected ? "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))" : "transparent",
            border: "1px solid",
            borderColor: selected
              ? "var(--dsw-alias-border-l1)"
              : "transparent",
            color: selected
              ? "var(--dsw-alias-label-primary)"
              : "var(--dsw-alias-label-secondary)",
            fontWeight: selected ? 600 : 400
          }
        },
        // The dot reports the OTHER half too — see the module header: without
        // it, selecting a site would be the only way to learn its state.
        h("span", {
          "aria-hidden": "true",
          "data-dsh-agnes-site-dot": option.tone,
          style: { ...S.pillDot, ...TONE_INK[option.tone] }
        }),
        option.label
      );
    })
  );
}
