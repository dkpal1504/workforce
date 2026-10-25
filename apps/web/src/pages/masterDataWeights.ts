import { normaliseWeightShares } from "@workforce/shared";

/**
 * The arithmetic behind the WBS weight dialog.
 *
 * The dialog asks for PERCENTAGES because that is what a planner thinks in, but the server stores a relative
 * weight and normalises it. These helpers turn the typed percentages into the payload, and turn the payload back
 * into the percentages the curve will actually use — through `normaliseWeightShares`, the same function the
 * server draws with. A preview that used its own copy of the rule would eventually lie.
 */

export type WeightRow = { wbsId: number; plannedWeight: number | null; budgetHours: number };

/** What the operator typed, per row. An empty box is "no opinion". */
export type WeightInputs = Record<number, string>;

/**
 * The payload for PUT …/wbs-weights.
 *
 * A blank box and a typed `0` BOTH mean "no opinion": a zero share would quietly drop the node out of the plan
 * while the screen still listed it, which is the sort of quiet that a review exists to prevent. To exclude a
 * node from the curve, its Job Orders are left without planned dates — that is visible in the readiness panel.
 */
export function weightPayload(rows: readonly WeightRow[], inputs: WeightInputs): Array<{ wbsId: number; plannedWeight: number | null }> {
  return rows.map((row) => {
    const typed = Number((inputs[row.wbsId] ?? "").trim());
    const positive = Number.isFinite(typed) && typed > 0;
    return { wbsId: row.wbsId, plannedWeight: positive ? typed : null };
  });
}

export type WeightPreview = {
  /** The share each node will carry, as a percentage with two decimals. */
  sharePct: Map<number, number>;
  /** How many nodes carry a weight of their own (the rest take the average). */
  configuredCount: number;
  /** The percentages as typed. A number, so the dialog can say "these add up to 92%". */
  enteredTotal: number;
  /** The percentage an unweighted node will take, or null when every node is weighted. */
  averagePct: number | null;
  /** True when nothing has been typed, i.e. the project is on an equal share. */
  allBlank: boolean;
};

export function previewWeights(rows: readonly WeightRow[], inputs: WeightInputs): WeightPreview {
  const payload = weightPayload(rows, inputs);
  const shares = normaliseWeightShares(payload.map((row) => ({ id: row.wbsId, plannedWeight: row.plannedWeight })));

  const sharePct = new Map<number, number>();
  for (const row of rows) {
    sharePct.set(row.wbsId, Math.round((shares.get(row.wbsId) ?? 0) * 10_000) / 100);
  }

  const configured = payload.filter((row) => row.plannedWeight !== null);
  const enteredTotal = configured.reduce((sum, row) => sum + (row.plannedWeight as number), 0);
  const averagePct = configured.length && configured.length < rows.length
    ? Math.round((enteredTotal / configured.length) * 100) / 100
    : null;

  return {
    sharePct,
    configuredCount: configured.length,
    enteredTotal: Math.round(enteredTotal * 100) / 100,
    averagePct,
    allBlank: configured.length === 0,
  };
}

/**
 * "Follow the money": each node's percentage of the project's budgeted hours.
 *
 * A node whose Job Orders carry no budget gets no entry at all, so it takes the average rather than a meaningless
 * 0%. That is also why this is a starting point, not a rule — the planner edits what they disagree with.
 */
export function budgetSplit(rows: readonly WeightRow[]): WeightInputs {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.budgetHours), 0);
  const inputs: WeightInputs = {};
  if (total <= 0) return equalSplit(rows);
  for (const row of rows) {
    if (row.budgetHours <= 0) continue;
    inputs[row.wbsId] = String(Math.round((row.budgetHours / total) * 10_000) / 100);
  }
  return inputs;
}

/** An equal split, to one decimal, with the rounding remainder handed to the last row so the total is 100. */
export function equalSplit(rows: readonly WeightRow[]): WeightInputs {
  const inputs: WeightInputs = {};
  if (!rows.length) return inputs;
  const each = Math.round((100 / rows.length) * 10) / 10;
  rows.forEach((row, index) => {
    const value = index === rows.length - 1 ? Math.round((100 - each * (rows.length - 1)) * 10) / 10 : each;
    inputs[row.wbsId] = String(value);
  });
  return inputs;
}
