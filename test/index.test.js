import assert from "node:assert/strict";
import test from "node:test";
import Deezer, { Deezer as NamedDeezer } from "../src/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("exports preserve the Deezer class", () => {
  assert.equal(Deezer, NamedDeezer);
  assert.equal(typeof Deezer, "function");
});

test("authentication sends ARL then uses the returned session for API requests", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ results: { SESSION_ID: "session-123", checkForm: "token-123", OFFER_NAME: "Deezer Premium", USER: { OPTIONS: { license_token: "license-123" } } } }));
    }
    return new Response(JSON.stringify({ results: { ok: true } }));
  };

  const result = await new Deezer("arl-secret").api("test.method", { hello: "world" });
  assert.deepEqual(result, { results: { ok: true } });
  assert.equal(requests[0].options.headers.cookie, "arl=arl-secret");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.headers.cookie, "sid=session-123");
  assert.equal(requests[1].options.body, JSON.stringify({ hello: "world" }));
});

test("get preserves track response parsing", async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return new Response(JSON.stringify({ results: { SESSION_ID: "session-track", checkForm: "token-track", OFFER_NAME: "Deezer Free", USER: { OPTIONS: { license_token: "license-track" } } } }));
    return new Response(JSON.stringify({ results: { data: [{ SNG_ID: "123", SNG_TITLE: "Test" }] } }));
  };
  const entity = await new Deezer().get("123", "track");
  assert.equal(entity.type, "track");
  assert.equal(entity.info.SNG_ID, "123");
  assert.deepEqual(entity.tracks, [entity.info]);
});

test("invalid JSON responses reject", async () => {
  globalThis.fetch = async () => new Response("not-json");
  await assert.rejects(() => new Deezer("unique-invalid-json-arl").api("bad.response", {}), SyntaxError);
});
