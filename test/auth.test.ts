import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerToken, isOriginAllowed, safeEqual } from "../src/auth.ts";

test("safeEqual matches identical strings", () => {
  assert.equal(safeEqual("secret-token", "secret-token"), true);
});

test("safeEqual rejects different strings, including different lengths", () => {
  assert.equal(safeEqual("secret-token", "secret-tokeX"), false);
  assert.equal(safeEqual("short", "a-much-longer-string"), false);
  assert.equal(safeEqual("", "x"), false);
});

test("bearerToken extracts the token", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123");
  assert.equal(bearerToken("  Bearer abc123  "), "abc123");
});

test("bearerToken rejects malformed headers", () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken(""), null);
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken("Bearer"), null);
});

test("isOriginAllowed with wildcard allows everything", () => {
  assert.equal(isOriginAllowed("https://evil.example", "*"), true);
  assert.equal(isOriginAllowed(undefined, "*"), true);
});

test("isOriginAllowed with a list", () => {
  const allowed = ["https://app.example.com", "http://localhost:5173"];
  assert.equal(isOriginAllowed("https://app.example.com", allowed), true);
  assert.equal(isOriginAllowed("https://app.example.com/", allowed), true);
  assert.equal(isOriginAllowed("http://localhost:5173", allowed), true);
  assert.equal(isOriginAllowed("https://other.example.com", allowed), false);
});

test("isOriginAllowed lets non-browser clients (no Origin) through", () => {
  assert.equal(isOriginAllowed(undefined, ["https://app.example.com"]), true);
  assert.equal(isOriginAllowed(null, ["https://app.example.com"]), true);
});
