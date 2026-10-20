import test from "node:test";
import assert from "node:assert/strict";
import { deliverySummary, emailSubject, escapeHtml, excerpt, linkify, renderBodyHtml } from "./conversationText";
import { extensionOf, inspectUpload, sanitizeFilename } from "./attachments";
import { briefFactsBlock, buildBriefPrompt, templateBrief, type BriefFacts } from "./assistantPrompts";

/** What goes into an e-mail, and which files may be stored. */

test("the subject names the Job Order, the kind and the point", () => {
  const subject = emailSubject(
    { code: "1900000107", name: "Pipe Spool Installation" },
    "FOLLOW_UP",
    "Please confirm the re-sequence plan for the spools by Friday."
  );
  assert.equal(
    subject.startsWith("[JO 1900000107 · Pipe Spool Installation] Follow-up — "),
    true,
    subject
  );
  assert.equal(subject.length <= 60 + "[JO 1900000107 · Pipe Spool Installation] Follow-up — ".length + 2, true);
});

test("a body is escaped before it becomes HTML — no message can inject markup", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  const html = renderBodyHtml("Line one\n<b>bold</b>");
  assert.equal(html.includes("<b>"), false);
  assert.equal(html.includes("&lt;b&gt;"), true);
  assert.equal(html.includes("<br>"), true);
});

test("only bare http(s) URLs become links, and the link text is the escaped URL", () => {
  const html = linkify("see https://swan.example/jo/7 for the plan");
  assert.equal(html.includes('<a href="https://swan.example/jo/7">https://swan.example/jo/7</a>'), true);
  assert.equal(linkify("javascript:alert(1)").includes("<a"), false);
});

test("an excerpt is one line, never longer than asked", () => {
  assert.equal(excerpt("a\n\nb\t c"), "a b c");
  assert.equal(excerpt("x".repeat(200), 20).length, 20);
  assert.equal(excerpt("x".repeat(200), 20).endsWith("…"), true);
});

test("a delivery line never says 'sent' without a recipient", () => {
  assert.deepEqual(deliverySummary([{ email: "a@b.c", state: "SENT" }]), ["emailed to a@b.c"]);
  assert.deepEqual(deliverySummary([{ email: "a@b.c", state: "FAILED" }]), ["could not email a@b.c"]);
  assert.deepEqual(deliverySummary([{ email: "a@b.c", state: "NO_ADDRESS" }]), ["not emailed — no address on file"]);
  assert.deepEqual(deliverySummary([{ email: "a@b.c", state: "EMAIL_OFF" }]), ["not emailed — e-mail is switched off"]);
});

test("the attachment allow-list refuses scripts and executables, and wins over everything", () => {
  assert.equal(inspectUpload({ filename: "drawing.pdf", sizeBytes: 10 }).ok, true);
  assert.equal(inspectUpload({ filename: "photo.JPG", sizeBytes: 10 }).ok, true);
  assert.equal(inspectUpload({ filename: "sheet.xlsx", sizeBytes: 10 }).ok, true);

  for (const name of ["run.exe", "page.html", "logo.svg", "app.js", "script.ps1", "archive.7z", "noext"]) {
    const verdict = inspectUpload({ filename: name, sizeBytes: 10 });
    assert.equal(verdict.ok, false, name);
  }
  assert.equal(inspectUpload({ filename: "big.pdf", sizeBytes: 11 * 1024 * 1024 }).ok, false);
  assert.equal(inspectUpload({ filename: "empty.pdf", sizeBytes: 0 }).ok, false);
});

test("a filename cannot carry a path out of the attachment directory", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Windows\\system32\\evil.pdf"), "evil.pdf");
  assert.equal(sanitizeFilename("   "), "document");
  assert.equal(sanitizeFilename("name\u0000with\u0007controls.txt"), "namewithcontrols.txt");
  assert.equal(extensionOf("A.PDF"), "pdf");
});

test("the brief prompt carries ONLY the numbers the report computed", () => {
  const facts: BriefFacts = {
    code: "1900000107",
    name: "Pipe Spool Installation",
    project: "P-24 · Hull 24",
    wbs: "2.3",
    network: "N-11",
    department: "Production",
    section: "Hull",
    status: "active",
    budgetHours: 1000,
    actualHours: 820,
    burnPct: 0.82,
    hoursBand: "AMBER",
    plannedStart: "2026-09-01",
    plannedEnd: "2026-10-13",
    scheduleBand: "DELAYED",
    daysToEnd: -6,
    targetQty: 120,
    achievedQty: 43,
    qtyCompletePct: 0.36,
    daysSinceActivity: 9,
    unapprovedHours: 40,
    openEscalations: 1,
    promisesOverdue: 2,
    lastMessages: [{ seq: 7, kind: "ESCALATION", role: "PROJECT_MANAGER", body: "Spools are late." }],
  };

  const block = briefFactsBlock(facts);
  assert.equal(block.burn_pct, 82);
  assert.equal(block.quantity_complete_pct, 36);
  assert.equal(block.days_since_last_booking, 9);
  assert.equal(block.days_to_planned_end, -6);

  const prompt = buildBriefPrompt(facts);
  // Every percentage the prompt can legitimately mention comes from the block above.
  for (const value of ["82", "36", "9", "-6", "820", "1000"]) {
    assert.equal(prompt.user.includes(value), true, `missing ${value}`);
  }
  assert.equal(prompt.system.includes("ONLY use the numbers"), true);
  assert.equal(prompt.user.includes("Action for <role>"), true);
});

test("the template brief states the situation without inventing anything", () => {
  const base: BriefFacts = {
    code: "1900000107", name: "Pipe Spool", project: "P-24", wbs: "2.3", network: null,
    department: "Production", section: null, status: "active",
    budgetHours: 0, actualHours: 0, burnPct: null, hoursBand: "UNKNOWN",
    plannedStart: null, plannedEnd: null, scheduleBand: "NO_PLAN", daysToEnd: null,
    targetQty: 0, achievedQty: 0, qtyCompletePct: null, daysSinceActivity: null,
    unapprovedHours: 0, openEscalations: 0, promisesOverdue: 0, lastMessages: [],
  };
  const text = templateBrief(base);
  assert.equal(text.includes("No budget hours are in force"), true);
  assert.equal(text.includes("No booking has ever been made"), true);
  assert.equal(text.includes("Action for Project Manager:"), true);
  // A promise changes the ask, an escalation outranks it.
  assert.equal(templateBrief({ ...base, promisesOverdue: 1 }).includes("Action for Section Head:"), true);
  assert.equal(templateBrief({ ...base, openEscalations: 1 }).includes("Action for HOD:"), true);
});
