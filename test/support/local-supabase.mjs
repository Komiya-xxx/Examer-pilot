import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

export const localOrigin = "http://127.0.0.1:4321";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPublicKey(key) {
  if (key?.startsWith("sb_publishable_")) return true;

  try {
    const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url"));
    return claims.role === "anon";
  } catch {
    return false;
  }
}

export function localDatabase(sql) {
  const distro = process.env.EXAMERFRAME_TEST_WSL_DISTRO;
  const socket = process.platform === "win32" && !distro
    ? "npipe:////./pipe/docker_engine"
    : "unix:///var/run/docker.sock";
  const dockerArgs = [
    "--host", socket, "exec", "-i", "supabase_db_examerframe",
    "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
  ];
  const command = distro ? "wsl.exe" : "docker";
  const args = distro ? ["--distribution", distro, "--exec", "docker", ...dockerArgs] : dockerArgs;
  const result = spawnSync(command, args, {
    input: sql,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, DOCKER_CONTEXT: "" },
  });

  assert.equal(result.status, 0, `Local fixture SQL failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export function browserStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

export function localFetch(url, options) {
  return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10_000) });
}

export function authClient(base, publicKey, storage) {
  return createClient(base, publicKey, {
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: localFetch },
  });
}

export async function signIn(client, runId) {
  const { data, error } = await client.auth.signInAnonymously({
    options: { data: { examerframe_test_run: runId } },
  });
  assert.ok(!error, `Local anonymous sign-in failed (status ${error?.status ?? "unknown"}).`);
  assert.ok(data.session?.access_token, "Anonymous sign-in returned no session");
  assert.ok(uuid.test(data.user?.id), "Anonymous sign-in returned no user UUID");
  assert.equal(data.user.is_anonymous, true);
  return data.session;
}

export async function expectEdgeJson(response, status, label) {
  assert.equal(response.status, status, label);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/i, label);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i, label);
  return response.json();
}

export function localApiConfig() {
  const api = new URL(process.env.PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  assert.ok(
    api.protocol === "http:" && api.hostname === "127.0.0.1" &&
    api.pathname === "/" && !api.username && !api.password && !api.search && !api.hash,
    "The integration test requires a plain HTTP API on 127.0.0.1",
  );
  const publicKey = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  assert.ok(isPublicKey(publicKey), "Set PUBLIC_SUPABASE_PUBLISHABLE_KEY to the local publishable or anon key");
  return { api, publicKey };
}
