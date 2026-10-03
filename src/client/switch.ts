/**
 * The pill switch, shared by every opt-in toggle in the panel.
 *
 * The repo has never used a CSS class or a `<style>` tag — styles live in the
 * `S` token object as inline `style` props — and an inline style cannot
 * express a `::before` pseudo-element. So instead of Qoder's
 * `appearance: none` + `::before` recipe, the thumb is a nested `<span>`
 * positioned by `checked`: the track is the span itself, the thumb is its
 * child, and `left` is the only thing that moves. The visual is identical to
 * Qoder's pill, but the DOM stays in the repo's inline-styles discipline.
 *
 * The input stays a NATIVE checkbox, transparent but focusable, so the
 * browser's own focus ring draws around the track and assistive tech reads a
 * real checkbox: keyboard focus, form submission and `aria-checked` are free.
 * Nothing is reimplemented as a custom widget.
 *
 * Hook-free on purpose — the caller owns the state (`checked`) and the action
 * (`onChange`), so the Node render suite pins the pill's shape the same way it
 * pins any other presentational component. `title` is where the long
 * consequence goes: the panel shows a short label, the hover explains the rest.
 */
import { h } from "./runtime.ts";

/** The row text style; callers override `color` when the label is a card title. */
const LABEL_STYLE = { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } as const;

/**
 * The track and thumb mirror DSH's own `Switch.module.css` in GEOMETRY (the
 * 36×20 capsule with a 2px-padded 16×16 thumb, `translateX` motion, 120ms
 * ease), but the colour follows THIS plugin's brand token, not the host's
 * neutral: the ON fill is `--agnes-brand` (technology blue `#1E40AF`), the
 * same token as the active tab underline, the quota progress bar and the
 * model checkbox `accent-color`. DSH's `--dsw-alias-brand-primary` resolves to
 * a near-black `#0f1115` in dark mode, which reads as an empty white pill —
 * the switch looked off. The thumb is a fixed white: it contrasts with both
 * the blue ON track and the gray OFF track, in light and dark mode alike.
 * The on/off appearance keys off `checked` — the same contract as DSH's
 * `aria-checked`, because our input IS a native checkbox, so the browser
 * already exposes `aria-checked`.
 */
const TRACK_STYLE = {
  boxSizing: "border-box",
  position: "relative",
  flex: "none",
  width: 36,
  height: 20,
  padding: 2,
  border: "none",
  borderRadius: 999,
  transition: "background 120ms ease"
} as const;

/** The thumb is always white: high contrast on both the brand-blue and gray tracks. */
const THUMB_COLOR = "#fff";

export function Switch({ checked, disabled, onChange, label, title, rowStyle, labelStyle }: {
  checked: boolean;
  disabled?: boolean;
  onChange?: () => void;
  /** The row text (already computed by the caller — busy states included). */
  label: string;
  /** Tooltip on hover; put the long consequence here, not on the panel. */
  title?: string;
  /** Extra styles on the label row (spacing, width, …). */
  rowStyle?: Record<string, unknown>;
  /** Overrides the label text style (default: secondary 12px). */
  labelStyle?: Record<string, unknown>;
}): unknown {
  return h(
    "label",
    {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        cursor: disabled ? "wait" : "pointer",
        position: "relative",
        ...(rowStyle ?? {})
      },
      ...(title !== undefined ? { title } : {})
    },
    h("input", {
      type: "checkbox",
      checked,
      disabled,
      onChange,
      "aria-label": label,
      style: {
        appearance: "none",
        WebkitAppearance: "none",
        position: "absolute",
        left: 0,
        top: "50%",
        transform: "translateY(-50%)",
        width: 36,
        height: 20,
        margin: 0,
        border: "none",
        background: "transparent",
        cursor: "pointer"
      }
    }),
    h(
      "span",
      {
        style: {
          ...TRACK_STYLE,
          background: checked
            ? "var(--agnes-brand, #1E40AF)"
            : "var(--dsw-alias-border-l3)"
        }
      },
      h("span", {
        style: {
          display: "block",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: THUMB_COLOR,
          transition: "transform 120ms ease",
          transform: checked ? "translateX(16px)" : "translateX(0)"
        }
      })
    ),
    h("span", { style: { ...LABEL_STYLE, ...(labelStyle ?? {}) } }, label)
  );
}