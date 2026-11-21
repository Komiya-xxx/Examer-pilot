import { isUuid, participantRequest, platformKey, rpcRequestHeaders } from "../_shared/participant.ts";

const encoder = new TextEncoder();

function normalizeUsername(value: unknown) {
  if (typeof value !== "string" || value.length > 200) return null;
  const name = value.normalize("NFKC").trim().toLowerCase();
  const length = [...name].length;
  return length >= 3 && length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_.-]*$/u.test(name) ? name : null;
}

async function internalEmail(name: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(name)));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex + "@students.examerframe.invalid";
}

Deno.serve(participantRequest("POST", async (request, { headers, error, invalidRequest, rateLimited, unavailable }) => {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return invalidRequest();
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 3 || !["register", "login"].includes(body.action)) return invalidRequest();
  const username = normalizeUsername(body.username);
  if (!username) {
    return error(400, "INVALID_USERNAME", "账户名需为 3–32 个字符，以字母或数字开头，可使用汉字、数字和 _.-。");
  }
  const password = body.password;
  if (typeof password !== "string" || !password || encoder.encode(password).length > 72 ||
    (body.action === "register" && [...password].length < 8)) {
    return error(400, "INVALID_PASSWORD", "请输入至少 8 个字符、最多 72 字节的密码。");
  }

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = platformKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const serviceKey = platformKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !serviceKey) return unavailable();

  const post = (path: string, key: string, data: object) => fetch(new URL(path, url), {
    method: "POST",
    headers: rpcRequestHeaders(key),
    body: JSON.stringify(data),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  try {
    const email = await internalEmail(username);
    if (body.action === "register") {
      const slot = await post("/rest/v1/rpc/take_student_signup_slot", serviceKey, {});
      if (!slot.ok) return unavailable();
      if (await slot.json() !== true) return rateLimited();

      const created = await post("/auth/v1/admin/users", serviceKey, {
        email, password, email_confirm: true, app_metadata: { examerframe_username: username },
      });
      if (created.status === 429) return rateLimited();
      if (!created.ok) {
        const details = await created.json().catch(() => null);
        if (["email_exists", "user_already_exists"].includes(details?.error_code ?? created.headers.get("x-sb-error-code"))) {
          return error(409, "USERNAME_TAKEN", "该账户名已注册，请登录或换一个名称。");
        }
        if (details?.error_code === "weak_password") {
          return error(400, "INVALID_PASSWORD", "密码未达到安全要求，请换一个密码。");
        }
        return unavailable();
      }
    }

    const signedIn = await post("/auth/v1/token?grant_type=password", publishableKey, { email, password });
    if (signedIn.status === 429) return rateLimited();
    const invalidCredentials = () => error(401, "INVALID_CREDENTIALS", "账户名或密码不正确。");
    if (signedIn.status === 400 || signedIn.status === 401 || signedIn.status === 403) return invalidCredentials();
    if (!signedIn.ok) return unavailable();

    const session = await signedIn.json();
    if (!isUuid(session?.user?.id) || session.user.is_anonymous === true ||
      typeof session.access_token !== "string" || typeof session.refresh_token !== "string") return unavailable();
    const profile = await post("/rest/v1/rpc/get_student_profile", serviceKey, { p_participant_id: session.user.id });
    if (profile.status === 403) return invalidCredentials();
    if (!profile.ok) return unavailable();
    const account = await profile.json();
    if (account?.username !== username || account.id !== session.user.id) return invalidCredentials();

    return Response.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      account,
    }, { headers });
  } catch {
    return unavailable();
  }
}));
