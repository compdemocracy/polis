import { test } from "node:test";
import assert from "node:assert/strict";
import closestPointOnPath from "../closestPointOnPath.js";

function path(length, pointAtLength) {
  return {
    getTotalLength: () => length,
    getPointAtLength: (position) => {
      assert.ok(position >= 0 && position <= length, "path sampling stays in bounds");
      return pointAtLength(position);
    }
  };
}

test("finds the perpendicular projection onto a horizontal path and its distance", () => {
  const point = [13, 4];
  const result = closestPointOnPath(
    path(40, (x) => ({ x, y: 0 })),
    point
  );
  assert.deepEqual(Array.from(result), [13, 0]);
  assert.equal(result.distance, 4);
  assert.deepEqual(point, [13, 4]);
});

test("projects onto a vertical path with translated coordinates", () => {
  const result = closestPointOnPath(
    path(32, (position) => ({ x: -7, y: position - 10 })),
    [-10, 3]
  );
  assert.deepEqual(Array.from(result), [-7, 3]);
  assert.equal(result.distance, 3);
});

test("a point before the path start selects the endpoint", () => {
  const result = closestPointOnPath(
    path(32, (x) => ({ x, y: 0 })),
    [-3, 4]
  );
  assert.deepEqual(Array.from(result), [0, 0]);
  assert.equal(result.distance, 5);
});

test("a point beyond the path end selects the endpoint", () => {
  const result = closestPointOnPath(
    path(32, (x) => ({ x, y: 0 })),
    [35, 4]
  );
  assert.deepEqual(Array.from(result), [32, 0]);
  assert.equal(result.distance, 5);
});

test("a path shorter than the coarse sampling interval is refined", () => {
  const result = closestPointOnPath(
    path(3, (x) => ({ x, y: 0 })),
    [2, 3]
  );
  assert.deepEqual(Array.from(result), [2, 0]);
  assert.equal(result.distance, 3);
});

test("a zero-length path returns its only point", () => {
  const result = closestPointOnPath(
    path(0, () => ({ x: 2, y: 3 })),
    [5, 7]
  );
  assert.deepEqual(Array.from(result), [2, 3]);
  assert.equal(result.distance, 5);
});

test("curved-path projection stays within the algorithm's sampling precision", () => {
  const radius = 10;
  const arc = path(Math.PI * radius, (position) => ({
    x: radius * Math.cos(position / radius),
    y: radius * Math.sin(position / radius)
  }));
  const result = closestPointOnPath(arc, [0, 15]);
  assert.ok(Math.abs(result[0]) <= 0.5);
  assert.ok(Math.abs(result[1] - 10) <= 0.05);
  assert.ok(Math.abs(result.distance - 5) <= 0.05);
  assert.equal(result.distance, Math.hypot(result[0], result[1] - 15));
});
