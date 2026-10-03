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

/** The track: a pill whose fill is the checked state. */
const TRACK_STYLE = {
  width: 30,
  height: 17,
  borderRadius: 999,
  flex: "none",
  position: "relative",
  border: "1px solid var(--dsw-alias-border-l2, #36373b)",
  transition: "background .15s, border-color .15s"
} as const;

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
        width: 30,
        height: 17,
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
            ? "var(--dsw-alias-state-success-primary, #12b76a)"
            : "var(--dsw-alias-bg-layer-2, #2a2b31)"
        }
      },
      h("span", {
        style: {
          position: "absolute",
          top: 1.5,
          left: checked ? 14 : 1.5,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: checked ? "#fff" : "var(--dsw-alias-label-tertiary, #999)",
          transition: "left .15s, background .15s"
        }
      })
    ),
    h("span", { style: { ...LABEL_STYLE, ...(labelStyle ?? {}) } }, label)
  );
}