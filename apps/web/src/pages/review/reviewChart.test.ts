import assert from "node:assert/strict";
import test from "node:test";
import { bandCentres, bars, compactNumber, linePath, scaleLinear, ticks, yDomain } from "./reviewChart";

test("a scale maps the data domain onto the pixel range, and clamps outside it", () => {
  const scale = scaleLinear(0, 100, 0, 400);
  assert.equal(scale(0), 0);
  assert.equal(scale(50), 200);
  assert.equal(scale(100), 400);
  assert.equal(scale(-20), 0, "values below the domain never escape the chart");
  assert.equal(scale(180), 400);
  assert.ok(Number.isFinite(scale(Number.NaN)), "a NaN input cannot produce a NaN coordinate");
});

test("a zero-width domain collapses to the range start instead of dividing by zero", () => {
  const scale = scaleLinear(500, 500, 10, 300);
  assert.equal(scale(500), 10);
  assert.equal(scale(900), 10);
});

test("ticks land on values a reader can hold in their head", () => {
  assert.deepEqual(ticks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(ticks(0, 1000, 4), [0, 250, 500, 750, 1000]);
  assert.deepEqual(ticks(0, 3, 3), [0, 1, 2, 3]);
  assert.deepEqual(ticks(5, 5, 4), [5], "a single value still gets an axis");
});

test("the y domain starts at zero and contains both lines", () => {
  const domain = yDomain([
    [0, 120, 240],
    [0, 300, 410],
  ]);
  assert.equal(domain.min, 0, "a cumulative hours chart never truncates its axis");
  assert.ok(domain.max >= 410);
  assert.equal(yDomain([[], []]).max, 1, "an empty project still gets a drawable axis");
});

test("the line path starts with M, then L, and is empty for no data", () => {
  const x = scaleLinear(0, 2, 0, 200);
  const y = scaleLinear(0, 100, 100, 0);
  const path = linePath([0, 50, 100], x, y, 200);
  assert.match(path, /^M0,100 L100,50 L200,0$/);
  assert.equal(linePath([], x, y, 200), "", "no points, no path");
});

test("bars sit inside their slot and a zero bar has no height", () => {
  const rects = bars([10, 0, 20], 300, 100, 20);
  assert.equal(rects.length, 3);
  assert.equal(rects[1].height, 0, "a zero is drawn as nothing, not as a confident bar");
  assert.equal(rects[2].height, 100, "the largest value fills the plot");
  for (const rect of rects) {
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 300);
    assert.ok(rect.y + rect.height <= 100);
  }
});

test("band centres line up with the slots bars are drawn in", () => {
  assert.deepEqual(bandCentres(4, 400), [50, 150, 250, 350]);
  assert.deepEqual(bandCentres(0, 400), []);
});

test("axis labels are compact but never invented", () => {
  assert.equal(compactNumber(0), "0");
  assert.equal(compactNumber(950), "950");
  assert.equal(compactNumber(12_400), "12.4k");
  assert.equal(compactNumber(2_000_000), "2M");
  assert.equal(compactNumber(Number.NaN), "–");
});
