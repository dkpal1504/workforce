/**
 * Shared CSV parser used by the Employee and Job Order uploads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CSV_MAX_BYTES,
  buildCsvText,
  columnIndexByName,
  findCsvInjectionIndex,
  isCsvInjection,
  isPlainNumber,
  parseCsv,
  readCsvFile,
  rowReader,
} from "./csvParser";

test("parseCsv handles quoting, embedded commas, doubled quotes and blank lines", () => {
  const rows = parseCsv('A,B\n"x, y",2\n"say ""hi""",3\n\nlast,6\n');
  assert.deepEqual(rows, [["A", "B"], ["x, y", "2"], ['say "hi"', "3"], ["last", "6"]]);

  // CRLF files (what Excel exports) split the same way.
  assert.deepEqual(parseCsv("A,B\r\n1,2\r\n"), [["A", "B"], ["1", "2"]]);
  assert.deepEqual(parseCsv(""), []);
});

test("readCsvFile reports the shared failure codes", () => {
  assert.deepEqual(readCsvFile(undefined), { ok: false, status: 400, code: "EMPTY_CSV", error: "csv data is required (send raw CSV text)." });
  assert.deepEqual(readCsvFile("   "), { ok: false, status: 400, code: "EMPTY_CSV", error: "csv data is required (send raw CSV text)." });
  assert.deepEqual(readCsvFile({ csv: "A,B\n1,2" }), { ok: false, status: 400, code: "EMPTY_CSV", error: "csv data is required (send raw CSV text)." }, "the body itself, not the field, is passed in");
  const headerOnly = readCsvFile("A,B\n");
  assert.equal(headerOnly.ok, false);
  if (!headerOnly.ok) assert.equal(headerOnly.code, "INVALID_CSV");
  const oversized = readCsvFile(`A,B\n${"x".repeat(CSV_MAX_BYTES)}`);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.deepEqual({ status: oversized.status, code: oversized.code, error: oversized.error },
    { status: 400, code: "FILE_TOO_LARGE", error: "CSV file exceeds 2MB limit." });

  const good = readCsvFile("A,B\n1,2\n");
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.rows, [["A", "B"], ["1", "2"]]);
});

test("a header row reads case-insensitively and a missing column reads as an empty cell", () => {
  const columns = columnIndexByName([" Project_ID ", "WBS_NO"]);
  const get = rowReader(["PRJ-A", "A.HULL.0010.100"], columns);
  assert.equal(get("project_id"), "PRJ-A");
  assert.equal(get("WBS_NO"), "A.HULL.0010.100");
  assert.equal(get("Network_ID"), "", "an absent column is empty, never undefined");
  assert.equal(rowReader(["  padded  "], columnIndexByName(["a"]))("a"), "padded");
});

test("formula injection is rejected, except for a plain signed number", () => {
  for (const cell of ["=1+1", "+cmd", "@SUM", "-cmd", " =2"]) {
    assert.equal(isCsvInjection(cell), true, cell);
  }
  assert.equal(isCsvInjection("plain"), false);

  assert.equal(isPlainNumber("-5"), true);
  assert.equal(isPlainNumber("+5.5"), true);
  assert.equal(isPlainNumber("1e3"), true);
  assert.equal(isPlainNumber("-5 pcs"), false);

  assert.equal(findCsvInjectionIndex(["ok", "also ok"]), -1);
  assert.equal(findCsvInjectionIndex(["ok", "=SUM(A1:A9)"]), 1);
  assert.equal(findCsvInjectionIndex(["-5", "ok"]), -1, "a negative number in a numeric column is data");
  assert.equal(findCsvInjectionIndex(["ok", "-5 pcs"]), 1);
});

test("buildCsvText quotes only what needs quoting, and round-trips through parseCsv", () => {
  const text = buildCsvText([["A", "B"], ['x, y', 'say "hi"']]);
  assert.equal(text, 'A,B\n"x, y","say ""hi"""\n');
  assert.deepEqual(parseCsv(text), [["A", "B"], ["x, y", 'say "hi"']]);
});
