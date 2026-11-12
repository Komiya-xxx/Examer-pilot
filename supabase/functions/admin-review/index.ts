import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isHttpOrigin, isUuid, platformKey } from "../_shared/participant.ts";

const passcode = Deno.env.get("EXAMERFRAME_STAFF_REVIEW_KEY") ?? "";
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const sessionLifetimeSeconds = 2 * 60 * 60;
const sessionPattern = /^(\d{10}\.[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const qualities = new Set(["low", "medium", "high"]);
const origins = new Set((Deno.env.get("EXAMERFRAME_ALLOWED_ORIGINS") ?? "")
  .split(",").map((origin) => origin.trim()).filter(isHttpOrigin));
const encoder = new TextEncoder();

function sameText(first: string, second: string) {
  return timingSafeEqual(encoder.encode(first), encoder.encode(second));
}

function signSession(payload: string) {
  return createHmac("sha256", passcode).update("examerframe/staff-review/v1:").update(payload).digest("base64url");
}

function validSession(header: string | null) {
  const token = header?.match(/^Bearer (\S+)$/i)?.[1];
  const session = token && sessionPattern.exec(token);
  return !!session && sameText(session[2], signSession(session[1])) &&
    Number(session[1].split(".")[0]) > Date.now() / 1000;
}

Deno.serve(async (request: Request) => {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  const unavailable = () => json({ message: "审查服务暂不可用，请稍后重试。" }, 503);
  const invalid = () => json({ message: "审查请求格式无效。" }, 400);

  const origin = request.headers.get("Origin");
  if (origin !== null) {
    if (!origins.has(origin)) return json({ message: "此来源无权访问审查接口。" }, 403);
    headers.set("Access-Control-Allow-Origin", origin);
  }
  if (request.method === "OPTIONS" && origin &&
    request.headers.get("Access-Control-Request-Method") === "POST") {
    headers.append("Vary", "Access-Control-Request-Method");
    headers.set("Access-Control-Allow-Methods", "POST");
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type");
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    headers.set("Allow", "POST, OPTIONS");
    return json({ message: "审查接口仅支持 POST。" }, 405);
  }

  if (!keyPattern.test(passcode)) return unavailable();
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" || new URL(request.url).search) return invalid();
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();

  if (body.action === "login") {
    if (typeof body.key !== "string" || !keyPattern.test(body.key) || !sameText(body.key, passcode)) {
      return json({ message: "密钥不正确。" }, 401);
    }
    const expiresAt = Math.floor(Date.now() / 1000) + sessionLifetimeSeconds;
    const payload = `${expiresAt}.${randomBytes(16).toString("base64url")}`;
    return json({ token: `${payload}.${signSession(payload)}`, expires_at: expiresAt });
  }

  if (!validSession(request.headers.get("Authorization"))) {
    return json({ message: "审查会话已失效，请重新输入密钥。" }, 401);
  }

  let rpc: string;
  let args: Record<string, string | null>;
  if (body.action === "list" && (body.after === null || typeof body.after === "string")) {
    rpc = "list_staff_review_questions";
    args = { p_after_external_id: body.after };
  } else if (body.action === "rate" && isUuid(body.question_version_id) && qualities.has(body.quality)) {
    rpc = "save_staff_question_rating";
    args = { p_question_version_id: body.question_version_id, p_quality: body.quality };
  } else {
    return invalid();
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = platformKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return unavailable();
  const rpcHeaders = new Headers({ apikey: serviceKey, "Content-Type": "application/json" });
  if (!serviceKey.startsWith("sb_secret_")) rpcHeaders.set("Authorization", `Bearer ${serviceKey}`);

  try {
    const result = await fetch(new URL(`/rest/v1/rpc/${rpc}`, url), {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify(args),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const data = await result.json();
    if (result.status === 404 && data?.code === "PT404") return json({ message: "题目版本已不可用。" }, 404);
    return result.ok ? json(data) : unavailable();
  } catch {
    return unavailable();
  }
});
