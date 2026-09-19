/**
 * Project colour tokens.
 *
 * `projects.color_key` is a free-form 1-4 character token, chosen by the PM team (the real
 * one in use is "AINA" for MV AINA). The stylesheets only ever defined colours for the
 * tokens they were written against - `a` to `f` and `n` - so a project with any other token
 * rendered with NO colour: the Timesheet Entry slot cells looked blank after an assignment
 * (they carried the class `assigned-aina`, which matches no rule), the Allocations slot fell
 * back to grey, and the Summary column headers were transparent. The assignment itself was
 * saved - the row counter read 2/4 - which is what made it look like a broken save.
 *
 * This module makes any token produce a stable colour:
 *   - the curated tokens keep the existing CSS variables, so the demo look is unchanged;
 *   - every other token gets a colour from the palette, chosen by a stable hash so the same
 *     project is always the same colour on every screen and in every session;
 *   - the colour is published as `--project-<token>` on :root, which is how the Summary and
 *     Allocations screens already asked for it, and exposed as a plain value for inline styles.
 */

/** Curated tokens with a hand-picked colour already defined in themes.css. */
const CURATED = new Set(["a", "b", "c", "d", "e", "f", "n"]);

/** Accessible, mutually distinguishable colours for everything else. */
const PALETTE = [
  "#2563a8", "#1f7a4c", "#7c3a9a", "#0f766e", "#a16207", "#b91c1c",
  "#0e7490", "#4d7c0f", "#9333ea", "#c2410c", "#1d4ed8", "#047857",
];

/** Stable hash so a token always maps to the same palette entry. */
function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) hash = (hash * 31 + token.charCodeAt(i)) % 100000;
  return hash;
}

/** The colour for a token, as a CSS value usable in an inline style. */
export function projectColorToken(colorKey: string | null | undefined): string {
  const token = String(colorKey ?? "").trim().toLowerCase() || "n";
  if (CURATED.has(token)) return `var(--project-${token})`;
  return PALETTE[hashToken(token) % PALETTE.length];
}

/**
 * Publish `--project-<token>` for every token in use, so any rule or inline style that asks
 * for `var(--project-<token>)` resolves. Curated tokens are left to the stylesheet.
 */
export function applyProjectColorVars(colorKeys: Iterable<string | null | undefined>): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of colorKeys) {
    const token = String(key ?? "").trim().toLowerCase();
    if (!token || CURATED.has(token)) continue;
    root.style.setProperty(`--project-${token}`, PALETTE[hashToken(token) % PALETTE.length]);
  }
}
