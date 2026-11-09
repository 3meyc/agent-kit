// The slice of the vitest API the session plugin's tests were written against, on `node:test` and
// `node:assert`, so the tests could move here without being rewritten line by line. Only what
// they use: `describe`, `it` (with `it.each`), the four hooks and the `expect` matchers below.
import assert from "node:assert/strict";
import { after, before, afterEach as nodeAfterEach, beforeEach as nodeBeforeEach, describe, it as nodeIt } from "node:test";

export { describe };
export const beforeAll = before;
export const afterAll = after;
export const beforeEach = nodeBeforeEach;
export const afterEach = nodeAfterEach;

/** `it`, plus `it.each(rows)(name, fn)` with vitest's `%s`/`%i`/`%j` placeholders. */
export const it = (name, fn, ...rest) => nodeIt(name, fn, ...rest);
it.skip = nodeIt.skip;
it.only = nodeIt.only;
it.todo = nodeIt.todo;
it.each =
  (rows) =>
  (name, fn) => {
    for (const row of rows) {
      const args = Array.isArray(row) ? row : [row];
      let i = 0;
      const title = name.replace(/%[sdijo]/g, () => {
        const value = args[i++];
        return typeof value === "string" ? value : JSON.stringify(value);
      });
      nodeIt(title, () => fn(...args));
    }
  };

/** Deep equality as vitest's `toEqual`: plain objects, arrays, Maps and Sets compared by content. */
function equal(actual, expected) {
  assert.deepStrictEqual(normalize(actual), normalize(expected));
}

/** `toEqual` ignores `undefined` properties and prototypes of plain records; strict assert does not. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, normalize(v)]));
  if (value instanceof Set) return new Set([...value].map(normalize));
  if (value && typeof value === "object" && !(value instanceof RegExp) && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = normalize(v);
    return out;
  }
  return value;
}

/** Whether `actual` holds every key of `subset`, recursively (`toMatchObject`). */
function matchesObject(actual, subset) {
  if (subset === null || typeof subset !== "object") return Object.is(actual, subset);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(subset)) {
    return Array.isArray(actual) && actual.length === subset.length && subset.every((v, i) => matchesObject(actual[i], v));
  }
  return Object.entries(subset).every(([key, value]) => matchesObject(actual[key], value));
}

function contains(actual, item) {
  if (typeof actual === "string") return actual.includes(item);
  if (actual instanceof Set || actual instanceof Map) return actual.has(item);
  return Array.from(actual ?? []).some((value) => Object.is(value, item));
}

function matchers(actual, negate) {
  const check = (pass, message) => {
    if (pass === negate) assert.fail(negate ? `not ${message}` : message);
  };
  const show = (value) => {
    try {
      return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  return {
    toBe(expected) {
      if (negate) assert.notStrictEqual(actual, expected);
      else assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      if (negate) assert.notDeepStrictEqual(normalize(actual), normalize(expected));
      else equal(actual, expected);
    },
    toStrictEqual(expected) {
      if (negate) assert.notDeepStrictEqual(actual, expected);
      else assert.deepStrictEqual(actual, expected);
    },
    toContain(item) {
      check(contains(actual, item), `expected ${show(actual)} to contain ${show(item)}`);
    },
    toMatch(pattern) {
      const pass = typeof pattern === "string" ? String(actual).includes(pattern) : pattern.test(String(actual));
      check(pass, `expected ${show(actual)} to match ${pattern}`);
    },
    toMatchObject(subset) {
      check(matchesObject(actual, subset), `expected ${show(actual)} to match object ${show(subset)}`);
    },
    toHaveLength(length) {
      check(actual?.length === length, `expected length ${length}, got ${actual?.length}`);
    },
    toBeNull() {
      check(actual === null, `expected ${show(actual)} to be null`);
    },
    toBeUndefined() {
      check(actual === undefined, `expected ${show(actual)} to be undefined`);
    },
    toBeDefined() {
      check(actual !== undefined, "expected a defined value");
    },
    toBeTruthy() {
      check(Boolean(actual), `expected ${show(actual)} to be truthy`);
    },
    toBeFalsy() {
      check(!actual, `expected ${show(actual)} to be falsy`);
    },
    toBeGreaterThan(n) {
      check(actual > n, `expected ${actual} > ${n}`);
    },
    toBeGreaterThanOrEqual(n) {
      check(actual >= n, `expected ${actual} >= ${n}`);
    },
    toBeLessThan(n) {
      check(actual < n, `expected ${actual} < ${n}`);
    },
    toBeLessThanOrEqual(n) {
      check(actual <= n, `expected ${actual} <= ${n}`);
    },
    /** A string snapshot written inline, as vitest stores one: indented, wrapped in double quotes. */
    toMatchInlineSnapshot(snapshot) {
      const lines = String(snapshot).split("\n");
      while (lines.length && lines[0].trim() === "") lines.shift();
      while (lines.length && lines.at(-1).trim() === "") lines.pop();
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
      const text = lines
        .map((l) => l.slice(indent))
        .join("\n")
        .replace(/^"|"$/g, "")
        .replace(/\\"/g, '"');
      if (negate) assert.notStrictEqual(actual, text);
      else assert.strictEqual(actual, text);
    },
    toThrow(expected) {
      let thrown = null;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      let pass = thrown !== null;
      if (pass && typeof expected === "string") pass = message.includes(expected);
      if (pass && expected instanceof RegExp) pass = expected.test(message);
      check(pass, `expected a throw${expected ? ` matching ${expected}` : ""}, got ${thrown === null ? "none" : message}`);
    },
  };
}

/** `expect(value).<matcher>()` and `expect(value).not.<matcher>()`. */
export function expect(actual) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true) });
}
