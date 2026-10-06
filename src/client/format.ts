/** Time and number formatters, verbatim from the pre-split `client.js`. */

/** `HH:MM` for one epoch second. */
export function clock(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `MM-DD HH:mm` for one epoch second. */
export function clockLong(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `HH:mm` for a same-day instant, `MM-DD HH:mm` across days.
 *
 * The card's bottom row is a single short caption line shared with the used
 * counts, so every character the stamp spends crowds the pair. On the common
 * same-day case the date carries no information — the panel re-renders well
 * before the day turns and the reader is looking at a live figure — so it
 * collapses to the clock alone. A reset that lands on a different calendar day
 * keeps `MM-DD HH:mm`, because there the date IS the information: without it
 * the reader cannot tell whether 00:00 means tonight or tomorrow night.
 */
export function clockSameDay(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? clock(epoch) : clockLong(epoch);
}

/**
 * A credit figure as text: 2-decimal precision under 10 000, whole with
 * thousands separators at or above it. The switch is deliberate — a pool
 * limit of 60 000 reads as "60,000", a live balance of 47.5 as "47.5".
 */
export function count(value: unknown): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (number >= 10000) return Math.round(number).toLocaleString();
  return String(Math.round(number * 100) / 100);
}

/** Fill a `{token}` template from a dictionary entry. */
export function format(template: string, vars?: Record<string, unknown> | null): string {
  let text = template;
  for (const [key, value] of Object.entries(vars || {})) {
    text = text.split(`{${key}}`).join(String(value));
  }
  return text;
}

/**
 * A price as text, from the platform's minor units: `2500` + `cny` -> `¥25.00`.
 *
 * The catalogue quotes prices in cents (`price_minor`), so dividing by 100 is
 * the platform's own convention rather than a guess. An unrecognised currency
 * keeps its code rather than being dressed in the wrong symbol.
 */
export function money(minor: unknown, currency: unknown): string {
  const amount = typeof minor === "number" && Number.isFinite(minor) ? minor / 100 : 0;
  const code = typeof currency === "string" ? currency.toLowerCase() : "";
  const symbol = code === "cny" || code === "rmb" ? "¥" : code === "usd" ? "$" : "";
  return symbol === "" ? `${amount.toFixed(2)} ${code}`.trim() : `${symbol}${amount.toFixed(2)}`;
}

/**
 * A token count the way the platform names it: 1048576 → "1M", 65536 → "64K",
 * 128000 → "128K". Returns "" for a figure that is not a positive number, so
 * an unknown value draws no segment instead of a zero.
 *
 * Why two bases: the catalogue mixes them — windows and ceilings arrive as
 * powers of two (1048576), while the plugin's own 128k fallback is the round
 * decimal 128 000. A flat /1000 rounding once printed "1049k" for the 1M
 * window and it read like a placeholder bug. The guards below therefore run
 * in the order the code checks them, largest first:
 *
 *   - anything ≥ 1G goes to G — the account-lifetime token total (billions)
 *     must not print as a four-digit "5214M";
 *   - anything ≥ 1M goes to M — a 1M window (1048576) reads "1M", never
 *     "1049k" or "1024k";
 *   - below 1M, figures divisible by 1000 keep the decimal reading they were
 *     written with (128000 → "128K");
 *   - binary-only figures get the binary one (262144 → "256K", 65536 → "64K").
 */
export function tokenSize(value: unknown): string {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (number <= 0) return "";
  if (number >= 1_000_000_000) return `${Math.round(number / 100_000_000) / 10}G`;
  if (number >= 1_000_000) return `${Math.round(number / 100_000) / 10}M`;
  if (number % 1000 === 0) return `${number / 1000}K`;
  if (number % 1024 === 0) return `${number / 1024}K`;
  return `${Math.round(number / 1000)}K`;
}
