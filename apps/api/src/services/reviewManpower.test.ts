import assert from "node:assert/strict";
import test from "node:test";
import { buildHistogram } from "./reviewManpower";

const buckets = [
  { key: "2026-10-12", start: "2026-10-12", end: "2026-10-18" },
  { key: "2026-10-19", start: "2026-10-19", end: "2026-10-25" },
];

test("one man in two slots on one day is one head", () => {
  const histogram = buildHistogram({
    buckets: [buckets[0]],
    contractRows: [
      { workDate: "2026-10-12", employeeId: 1, hours: 4 },
      { workDate: "2026-10-12", employeeId: 1, hours: 4 },
      { workDate: "2026-10-13", employeeId: 1, hours: 8 },
      { workDate: "2026-10-13", employeeId: 2, hours: 8 },
    ],
    payrollRows: [],
  });
  assert.equal(histogram.buckets[0].contractPeople, 2);
  assert.equal(histogram.buckets[0].contractHours, 24);
  assert.equal(histogram.headcount, 2);
});

test("the two series are reported side by side and never added together", () => {
  const histogram = buildHistogram({
    buckets: [buckets[0]],
    contractRows: [{ workDate: "2026-10-12", employeeId: 1, hours: 8 }],
    payrollRows: [
      { workDate: "2026-10-12", employeeId: 1, hours: 10 },
      { workDate: "2026-10-12", employeeId: 2, hours: 6 },
    ],
  });
  const bucket = histogram.buckets[0];
  assert.equal(bucket.contractHours, 8);
  assert.equal(bucket.payrollHours, 16);
  assert.equal(bucket.contractPeople, 1);
  assert.equal(bucket.payrollPeople, 2);
  assert.equal(bucket.people, 2, "the same man is counted once across both series");
  assert.equal(histogram.headcount, 2);
});

test("an empty bucket is marked, so the chart cannot draw a confident zero", () => {
  const histogram = buildHistogram({
    buckets,
    contractRows: [{ workDate: "2026-10-13", employeeId: 1, hours: 8 }],
    payrollRows: [],
  });
  assert.equal(histogram.buckets[0].hasData, true);
  assert.equal(histogram.buckets[1].hasData, false);
  assert.equal(histogram.buckets[1].people, 0);
  assert.equal(histogram.peakKey, "2026-10-12");
  assert.equal(histogram.peakPeople, 1);
});

test("hours outside every bucket are not silently counted everywhere", () => {
  const histogram = buildHistogram({
    buckets: [buckets[1]],
    contractRows: [
      { workDate: "2026-10-12", employeeId: 1, hours: 8 },
      { workDate: "2026-10-20", employeeId: 2, hours: 8 },
    ],
    payrollRows: [],
  });
  assert.equal(histogram.buckets[0].contractHours, 8, "only the 20th is in this bucket");
  assert.equal(histogram.headcount, 2, "but the window head-count still sees both men");
});

test("the printed definition names both series, because a reader will otherwise add them", () => {
  const histogram = buildHistogram({ buckets, contractRows: [], payrollRows: [] });
  assert.match(histogram.definition, /never added together/);
  assert.match(histogram.definition, /distinct people/);
  assert.equal(histogram.averagePeople, 0);
  assert.equal(histogram.peakKey, null);
});
