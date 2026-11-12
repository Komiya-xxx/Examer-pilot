import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

// The endpoint reads Deno.env at module load time, so every test installs a
// synthetic Deno global (env plus a serve that captures the handler) before a
// uniquely addressed import of the module and then calls the captured handler
// directly. Nothing here talks to Supabase or any other real host: fetch is
// always mocked, and the values below are deterministic test fixtures.
const staffKey = "synthetic_0Vs2S-brPI3Mqmh3m_KL_EKCCtAx-hiKQ";
const serviceKey = "sb_secret_synthetic_edge_fixture";
const supabaseUrl = "https://synthetic-project.supabase.test";
const localOrigin = "http://127.0.0.1:4321";
const reviewOrigin = "https://review.synthetic.example";
const endpoint = "https://synthetic-project.supabase.test/functions/v1/admin-review";
const fixtureNonce = "0123456789abcdefghijkl";
const questionVersionId = "2f6b1c9e-4d3a-4b7f-8a1d-6c0e5f9b2a34";

const baseEnv = {
  EXAMERFRAME_STAFF_REVIEW_KEY: staffKey,
  EXAMERFRAME_ALLOWED_ORIGINS: `${localOrigin}, ${reviewOrigin}`,
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: serviceKey }),
};

let loads = 0;

// Returns the captured Deno.serve handler for one isolated module instance.
async function loadEndpoint(t, env = baseEnv) {
  const served = [];
  globalThis.Deno = {
    env: { get: (name) => env[name] },
    serve: (handler) => served.push(handler),
  };
  t.after(() => { delete globalThis.Deno; });
  await import(`../supabase/functions/admin-review/index.ts?case=${++loads}`);
  assert.equal(served.length, 1, "the endpoint must register exactly one handler");
  return served[0];
}

function recordFetch(t, reply = () => Response.json({ ok: true })) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    return reply(call, calls.length);
  });
  return calls;
}

function request(handler, body, options = {}) {
  const {
    method = "POST",
    origin = localOrigin,
    authorization,
    contentType = "application/json",
    raw = false,
    url = endpoint,
  } = options;
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (authorization !== undefined) headers.Authorization = authorization;
  if (contentType !== null) headers["Content-Type"] = contentType;
  return handler(new Request(url, {
    method,
    headers,
    body: method === "POST" ? (raw ? body : JSON.stringify(body)) : undefined,
  }));
}

// Mirrors the endpoint's session format so a test can present a correctly
// shaped token signed with the wrong key, or one that has already expired.
function mintSession(expiresAt, { key = staffKey, nonce = fixtureNonce } = {}) {
  const payload = `${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", key)
    .update("examerframe/staff-review/v1:")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function liveSession() {
  return mintSession(Math.floor(Date.now() / 1000) + 600);
}

const unavailableMessage = "审查服务暂不可用，请稍后重试。";
const invalidMessage = "审查请求格式无效。";
const forbiddenMessage = "此来源无权访问审查接口。";
const badKeyMessage = "密钥不正确。";
const badSessionMessage = "审查会话已失效，请重新输入密钥。";

test("the Edge handler serves allowed origins with CORS and no-store", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => {
    throw new Error("login must not reach the backend");
  });

  const preflight = await handler(new Request(endpoint, {
    method: "OPTIONS",
    headers: { Origin: localOrigin, "Access-Control-Request-Method": "POST" },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), localOrigin);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "authorization, apikey, content-type",
  );
  assert.equal(preflight.headers.get("cache-control"), "no-store");
  assert.match(preflight.headers.get("vary"), /\bOrigin\b/i);
  assert.match(preflight.headers.get("vary"), /Access-Control-Request-Method/i);
  assert.equal(await preflight.text(), "");

  const login = await request(handler, { action: "login", key: staffKey });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("access-control-allow-origin"), localOrigin);
  assert.equal(login.headers.get("cache-control"), "no-store");
  assert.match(login.headers.get("vary"), /\bOrigin\b/i);

  // The second configured origin exercises trimming of the comma-separated list.
  const secondOrigin = await request(handler, { action: "login", key: staffKey }, {
    origin: reviewOrigin,
  });
  assert.equal(secondOrigin.status, 200);
  assert.equal(secondOrigin.headers.get("access-control-allow-origin"), reviewOrigin);

  // A same-origin or non-browser caller sends no Origin and stays usable, but
  // never receives an allow-origin header it did not ask for.
  const bare = await request(handler, { action: "login", key: staffKey }, { origin: null });
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get("access-control-allow-origin"), null);
  assert.equal(bare.headers.get("cache-control"), "no-store");

  assert.equal(calls.length, 0);
});

test("the Edge handler forbids unknown origins on preflight and actual requests", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => {
    throw new Error("origin policy must run before backend calls");
  });
  const forbiddenOrigin = "https://forbidden.example";

  const preflight = await handler(new Request(endpoint, {
    method: "OPTIONS",
    headers: { Origin: forbiddenOrigin, "Access-Control-Request-Method": "POST" },
  }));
  const actual = await request(handler, { action: "login", key: staffKey }, {
    origin: forbiddenOrigin,
  });

  for (const response of [preflight, actual]) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { message: forbiddenMessage });
  }
  assert.equal(calls.length, 0);
});

test("the Edge handler rejects non-POST requests and unusable bodies before the backend", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => {
    throw new Error("transport checks must run before backend calls");
  });

  const get = await handler(new Request(endpoint, { method: "GET", headers: { Origin: localOrigin } }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  assert.equal(get.headers.get("access-control-allow-origin"), localOrigin);
  assert.deepEqual(await get.json(), { message: "审查接口仅支持 POST。" });

  for (const response of [
    await request(handler, { action: "login", key: staffKey }, { contentType: "text/plain" }),
    await request(handler, { action: "login", key: staffKey }, { contentType: null }),
    await request(handler, { action: "login", key: staffKey }, { url: `${endpoint}?debug=1` }),
    await request(handler, "{not json", { raw: true }),
    await request(handler, [], {}),
    await request(handler, "null", { raw: true }),
  ]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message: invalidMessage });
  }
  assert.equal(calls.length, 0);
});

test("login rejects a wrong, missing or malformed key", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => {
    throw new Error("key checks must run before backend calls");
  });
  const otherKey = "synthetic_wrong_key_9hV2xQ7mR4tL8bN3cK6dJ1fG5zA";

  for (const body of [
    { action: "login" },
    { action: "login", key: 12345 },
    { action: "login", key: "" },
    { action: "login", key: "too-short" },
    { action: "login", key: otherKey },
    { action: "login", key: `${staffKey}x` },
  ]) {
    const response = await request(handler, body);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { message: badKeyMessage });
  }

  // The comparison is exact, so a key differing only in case is still refused.
  const recased = staffKey.replace("synthetic", "SYNTHETIC");
  const recasedResponse = await request(handler, { action: "login", key: recased });
  assert.equal(recasedResponse.status, 401);
  assert.deepEqual(await recasedResponse.json(), { message: badKeyMessage });

  assert.equal(calls.length, 0);
});

test("login fails closed when the staff key is not configured", async (t) => {
  const env = { ...baseEnv };
  delete env.EXAMERFRAME_STAFF_REVIEW_KEY;
  const handler = await loadEndpoint(t, env);
  const calls = recordFetch(t, () => {
    throw new Error("unconfigured endpoint must not reach the backend");
  });

  const response = await request(handler, { action: "login", key: staffKey });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: unavailableMessage });
  assert.equal(calls.length, 0);
});

test("login fails closed when the staff key is malformed", async (t) => {
  const handler = await loadEndpoint(t, { ...baseEnv, EXAMERFRAME_STAFF_REVIEW_KEY: "short" });
  const calls = recordFetch(t, () => {
    throw new Error("malformed endpoint must not reach the backend");
  });

  const response = await request(handler, { action: "login", key: "short" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: unavailableMessage });
  assert.equal(calls.length, 0);
});

test("login returns a signed, expiring session for the fixture key", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => {
    throw new Error("login must not reach the backend");
  });

  const before = Math.floor(Date.now() / 1000);
  const response = await request(handler, { action: "login", key: staffKey });
  const after = Math.floor(Date.now() / 1000);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), localOrigin);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["expires_at", "token"]);
  assert.ok(body.expires_at >= before + 2 * 60 * 60);
  assert.ok(body.expires_at <= after + 2 * 60 * 60);
  assert.match(body.token, /^\d{10}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

  const [expiration, nonce] = body.token.split(".");
  assert.equal(expiration, String(body.expires_at));
  assert.equal(nonce.length, 22);
  assert.equal(body.token, mintSession(body.expires_at, { nonce }));
  assert.equal(calls.length, 0);
});

test("missing, forged and expired sessions are rejected before the RPC", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => {
    throw new Error("session checks must run before backend calls");
  });
  const now = Math.floor(Date.now() / 1000);

  for (const authorization of [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    "Bearer not-a-token",
    "Basic abc",
    liveSession(),
    `Bearer ${mintSession(now + 600, { key: "synthetic_wrong_key_9hV2xQ7mR4tL8bN3cK6dJ1fG5zA" })}`,
    `Bearer ${mintSession(now - 1)}`,
    `Bearer ${mintSession(now + 600, { nonce: "short" })}`,
    `Bearer ${liveSession()}.extra`,
  ]) {
    const response = await request(handler, { action: "list", after: null }, { authorization });
    assert.equal(response.status, 401, `rejected session: ${String(authorization)}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { message: badSessionMessage });
  }

  assert.equal(calls.length, 0);
});

test("list forwards the exact RPC and passes its payload through", async (t) => {
  const handler = await loadEndpoint(t);
  const payload = [{ external_id: "Q-001", prompt: "示例题目", quality: null }];
  const calls = recordFetch(t, () => Response.json(payload));
  const authorization = `Bearer ${liveSession()}`;

  const first = await request(handler, { action: "list", after: null }, { authorization });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.href,
    `${supabaseUrl}/rest/v1/rpc/list_staff_review_questions`,
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.body, '{"p_after_external_id":null}');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const rpcHeaders = new Headers(calls[0].init.headers);
  assert.equal(rpcHeaders.get("apikey"), serviceKey);
  assert.equal(rpcHeaders.get("content-type"), "application/json");
  // sb_secret_ keys are sent as apikey only, never as a bearer token.
  assert.equal(rpcHeaders.get("authorization"), null);

  assert.equal(first.status, 200);
  assert.equal(first.headers.get("access-control-allow-origin"), localOrigin);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), payload);

  const second = await request(handler, { action: "list", after: "Q-001" }, { authorization });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.body, '{"p_after_external_id":"Q-001"}');
  assert.equal(second.status, 200);

  const empty = await request(handler, { action: "list", after: "" }, { authorization });
  assert.equal(calls[2].init.body, '{"p_after_external_id":""}');
  assert.equal(empty.status, 200);
});

test("rate forwards validated versions and qualities, and rejects the rest", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => Response.json({ ok: true }));
  const authorization = `Bearer ${liveSession()}`;

  for (const quality of ["low", "medium", "high"]) {
    const response = await request(handler, {
      action: "rate",
      question_version_id: questionVersionId,
      quality,
    }, { authorization });
    const call = calls.at(-1);
    assert.equal(response.status, 200);
    assert.equal(call.url.href, `${supabaseUrl}/rest/v1/rpc/save_staff_question_rating`);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(call.init.body), {
      p_question_version_id: questionVersionId,
      p_quality: quality,
    });
  }
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].init.body,
    `{"p_question_version_id":"${questionVersionId}","p_quality":"low"}`,
  );

  const forwarded = calls.length;
  for (const body of [
    { action: "rate", question_version_id: questionVersionId, quality: "urgent" },
    { action: "rate", question_version_id: questionVersionId, quality: "HIGH" },
    { action: "rate", question_version_id: questionVersionId, quality: 1 },
    { action: "rate", question_version_id: questionVersionId },
    { action: "rate", question_version_id: "not-a-uuid", quality: "high" },
    { action: "rate", quality: "high" },
    { action: "list", after: 7 },
    { action: "list" },
    { action: "delete", question_version_id: questionVersionId },
    { question_version_id: questionVersionId, quality: "high" },
  ]) {
    const response = await request(handler, body, { authorization });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message: invalidMessage });
  }
  assert.equal(calls.length, forwarded, "invalid rating bodies must not reach the backend");
});

test("backend failures map to stable responses without leaking details", async (t) => {
  const handler = await loadEndpoint(t);
  const replies = [
    () => Response.json({ code: "PT404", message: "question version retired" }, { status: 404 }),
    () => Response.json({ code: "XX000", message: "internal details" }, { status: 500 }),
    () => { throw new Error("connection reset"); },
  ];
  const calls = recordFetch(t, () => replies[calls.length - 1]());
  const authorization = `Bearer ${liveSession()}`;

  const retired = await request(handler, {
    action: "rate",
    question_version_id: questionVersionId,
    quality: "medium",
  }, { authorization });
  assert.equal(retired.status, 404);
  assert.equal(retired.headers.get("cache-control"), "no-store");
  assert.deepEqual(await retired.json(), { message: "题目版本已不可用。" });

  const broken = await request(handler, { action: "list", after: null }, { authorization });
  assert.equal(broken.status, 503);
  assert.deepEqual(await broken.json(), { message: unavailableMessage });

  const dropped = await request(handler, { action: "list", after: null }, { authorization });
  assert.equal(dropped.status, 503);
  assert.deepEqual(await dropped.json(), { message: unavailableMessage });
});

test("a legacy service role key is still forwarded as a bearer token", async (t) => {
  const legacyKey = "synthetic-legacy-service-role-key";
  const env = { ...baseEnv, SUPABASE_SERVICE_ROLE_KEY: legacyKey };
  delete env.SUPABASE_SECRET_KEYS;
  const handler = await loadEndpoint(t, env);
  const calls = recordFetch(t, () => Response.json([]));

  const response = await request(handler, { action: "list", after: null }, {
    authorization: `Bearer ${liveSession()}`,
  });
  assert.equal(response.status, 200);
  const rpcHeaders = new Headers(calls[0].init.headers);
  assert.equal(rpcHeaders.get("apikey"), legacyKey);
  assert.equal(rpcHeaders.get("authorization"), `Bearer ${legacyKey}`);
});

test("the reviewer session never authenticates or writes participant state", async (t) => {
  const handler = await loadEndpoint(t);
  const calls = recordFetch(t, () => Response.json([]));
  const authorization = `Bearer ${liveSession()}`;

  await request(handler, { action: "list", after: null }, { authorization });
  await request(handler, {
    action: "rate",
    question_version_id: questionVersionId,
    quality: "high",
  }, { authorization });

  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url.origin, new URL(supabaseUrl).origin);
    assert.match(
      url.pathname,
      /^\/rest\/v1\/rpc\/(?:list_staff_review_questions|save_staff_question_rating)$/,
    );
    assert.notEqual(url.pathname, "/auth/v1/user");

    const body = JSON.parse(init.body);
    assert.ok(
      Object.keys(body).every((key) =>
        key === "p_after_external_id" || key === "p_question_version_id" || key === "p_quality"
      ),
      `unexpected RPC argument in ${init.body}`,
    );
    for (const forbidden of [
      "p_participant_id",
      "p_session_id",
      "p_assignment_id",
      "p_response_id",
      "p_answer",
    ]) {
      assert.equal(forbidden in body, false);
    }

    const headers = new Headers(init.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
  }
});
