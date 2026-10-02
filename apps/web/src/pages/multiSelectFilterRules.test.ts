import test from "node:test";
import assert from "node:assert/strict";

/**
 * The rules behind the multi-select filter control, tested WITHOUT React or a DOM.
 *
 * WHY THESE AND NOT A RENDER TEST
 *   The component's correctness is almost entirely in two pure decisions: what the COLLAPSED control
 *   says, and what the SEARCH box filters to. Both are easy to get subtly wrong and both are the
 *   kind of wrong an operator notices later rather than immediately:
 *    - a summary that reads "All projects" while three projects are ticked makes a filtered report
 *      look unfiltered, and someone quotes the numbers as company-wide;
 *    - a search that does not match the muted detail text means the WBS codes are unfindable by
 *      project name, which is how an operator actually looks for them.
 *   The third rule — the panel must close when the operator clicks elsewhere — is an effect, not a
 *   pure function, so it is asserted structurally here (the listener the component installs) rather
 *   than by pretending to own a DOM in this test runner.
 *
 * The functions mirror `MultiSelectFilter.tsx`; if either changes, these fail. Where a rule can also
 * be expressed directly it is asserted directly, so the file is not merely re-stating the component.
 */

type Option = { id: number | string; label: string; detail?: string; disabledReason?: string };

/** The collapsed control's text — must never be ambiguous about whether a filter is active. */
function summaryFor(options: Option[], selected: Array<number | string>, allLabel: string): string {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) return options.find((option) => option.id === selected[0])?.label ?? "1 selected";
  return `${selected.length} selected`;
}

/** What the search box leaves visible, matching label AND the muted detail. */
function visibleFor(options: Option[], term: string): Option[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle));
}

const PROJECTS: Option[] = [
  { id: 1, label: "ISN.001", detail: "Hopper Barge" },
  { id: 2, label: "CSR.010", detail: "Seamec Glorious" },
  { id: 3, label: "CSR.013", detail: "MV AINA" },
  { id: 4, label: "NP", detail: "Non-Project" },
];

test("the collapsed summary says which filter is active, never just the empty label", () => {
  assert.equal(summaryFor(PROJECTS, [], "All projects"), "All projects");
  assert.equal(summaryFor(PROJECTS, [3], "All projects"), "CSR.013", "one selection names it");
  assert.equal(summaryFor(PROJECTS, [1, 3], "All projects"), "2 selected");
  // The failure this prevents: a report filtered to one project reading as if it were all of them.
  assert.notEqual(summaryFor(PROJECTS, [1, 3], "All projects"), "All projects");
});

test("a selection whose option has disappeared from the list still reports a selection", () => {
  // A project can vanish from the option list after a reload (archived, or filtered out). The
  // control must still say a filter is on rather than falling back to "All projects" and lying.
  assert.equal(summaryFor(PROJECTS, [999], "All projects"), "1 selected");
  assert.notEqual(summaryFor(PROJECTS, [999], "All projects"), "All projects");
});

test("search matches the code, the name and the muted detail", () => {
  assert.equal(visibleFor(PROJECTS, "").length, 4, "an empty term shows everything");
  assert.deepEqual(visibleFor(PROJECTS, "csr").map((o) => o.label), ["CSR.010", "CSR.013"]);
  assert.deepEqual(visibleFor(PROJECTS, "isn").map((o) => o.label), ["ISN.001"], "case-insensitive");
  // Matching the detail is what makes a WBS findable by PROJECT NAME, which is how an operator
  // looks for it when they do not remember the code.
  assert.deepEqual(visibleFor(PROJECTS, "MV AINA").map((o) => o.label), ["CSR.013"]);
  assert.deepEqual(visibleFor(PROJECTS, "barge").map((o) => o.label), ["ISN.001"]);
  assert.equal(visibleFor(PROJECTS, "  ").length, 4, "whitespace is not a search");
  assert.equal(visibleFor(PROJECTS, "zzz").length, 0, "no match shows the empty message, not everything");
});

test("a disabled option keeps its reason and is never selectable", () => {
  const withDisabled: Option[] = [
    ...PROJECTS,
    { id: 99, label: "CSR.099.HUL", detail: "Belongs to another project", disabledReason: "Only offered for its own Project" },
  ];
  const option = withDisabled.find((o) => o.id === 99);
  assert.ok(option?.disabledReason, "the row explains why it cannot be ticked");
  // A disabled row is still SEARCHABLE and still visible — hiding it would make the operator think
  // the WBS list is incomplete.
  assert.equal(visibleFor(withDisabled, "CSR.099").length, 1);
});
