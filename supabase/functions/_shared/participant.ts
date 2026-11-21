const signedJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type Method = "GET" | "POST";
// Browser-facing copy of the fixed write window the database enforces, sent as
// Retry-After so a denied client can wait out the current window.
const WRITE_RETRY_AFTER_SECONDS = 60;
// Participant identity is supplied by participantEndpoint after Auth verification.
export type ParticipantAnswer = string | string[] | boolean;
export type RpcArguments = Record<string, ParticipantAnswer | number | null>;
type ReadArguments = (request: Request) => Promise<RpcArguments | null>;
type RpcError = { status: number; code: string; message: string };
type RpcErrorMapping = {
  sqlState: string;
  status: number;
  // Distinguishes failures that share one SQLSTATE, such as ROUND_NOT_OPEN and
  // QUESTION_POOL_TOO_SMALL, using the database's stable error message.
  marker: string;
  code: string;
  message: string;
};

// Stable, readable failures the database raises for participant requests. The HTTP
// status, SQLSTATE and message must all match before a code is revealed; any other
// database error stays hidden behind the generic 503 response.
const rpcErrorMappings: readonly RpcErrorMapping[] = [
  { sqlState: "PT403", status: 403, marker: "STUDENT_ACCOUNT_REQUIRED", code: "STUDENT_ACCOUNT_REQUIRED",
    message: "请登录已注册的学生账户。" },
  { sqlState: "PT404", status: 404, marker: "QUESTION_NOT_FOUND", code: "QUESTION_NOT_FOUND",
    message: "这道题目前不在练习目录中。" },
  { sqlState: "PT400", status: 400, marker: "INVALID_REQUEST", code: "INVALID_REQUEST",
    message: "请求参数无效。" },
  { sqlState: "PT400", status: 400, marker: "INVALID_COMMENT", code: "INVALID_COMMENT",
    message: "请填写 1–2000 字的反馈意见。" },
  { sqlState: "PT409", status: 409, marker: "COMMENT_ALREADY_SUBMITTED", code: "COMMENT_ALREADY_SUBMITTED",
    message: "该题已经保存过意见。" },
  { sqlState: "PT409", status: 409, marker: "RETRY_ALREADY_SUBMITTED", code: "RETRY_ALREADY_SUBMITTED",
    message: "这次复练已经提交。" },
  { sqlState: "PT400", status: 400, marker: "INVALID_QUALITY", code: "INVALID_QUALITY",
    message: "请选择低或高。" },
  {
    sqlState: "PT409",
    status: 409,
    marker: "ROUND_NOT_OPEN",
    code: "ROUND_NOT_OPEN",
    message: "当前没有可参与的批次，请稍后再试。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "QUESTION_POOL_TOO_SMALL",
    code: "QUESTION_POOL_TOO_SMALL",
    message: "当前批次的题目不足，请稍后再试。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "NEXT_SET_POOL_TOO_SMALL",
    code: "NEXT_SET_POOL_TOO_SMALL",
    message: "暂时凑不齐一组与本组不同的题目，你仍可回看本组解析。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "NEXT_SET_MIN_ANSWERS_REQUIRED",
    code: "NEXT_SET_MIN_ANSWERS_REQUIRED",
    message: "本组已提交的答案还不够，暂时不能换题。",
  },
  {
    sqlState: "PT404",
    status: 404,
    marker: "SESSION_NOT_FOUND",
    code: "SESSION_NOT_FOUND",
    message: "没有找到你的答题会话。",
  },
  {
    sqlState: "PT404",
    status: 404,
    marker: "ASSIGNMENT_NOT_FOUND",
    code: "ASSIGNMENT_NOT_FOUND",
    message: "没有找到对应的题目分配。",
  },
  {
    sqlState: "PT400",
    status: 400,
    marker: "INVALID_ANSWER",
    code: "INVALID_ANSWER",
    message: "答案格式不正确。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "ANSWER_ALREADY_SUBMITTED",
    code: "ANSWER_ALREADY_SUBMITTED",
    message: "该题已经提交过答案。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "SESSION_COMPLETED",
    code: "SESSION_COMPLETED",
    message: "本次答题已经结束。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "NOT_CURRENT_QUESTION",
    code: "NOT_CURRENT_QUESTION",
    message: "这不是当前需要作答的题目。",
  },
  {
    sqlState: "PT404",
    status: 404,
    marker: "RESPONSE_NOT_FOUND",
    code: "RESPONSE_NOT_FOUND",
    message: "没有找到对应的答题记录。",
  },
  {
    sqlState: "PT409",
    status: 409,
    marker: "RATING_ALREADY_SUBMITTED",
    code: "RATING_ALREADY_SUBMITTED",
    message: "该题已经提交过评价。",
  },
];

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

// Write RPCs take one participant write slot per accepted attempt.
// Reads are deliberately absent, so every endpoint is limited by the RPC name it calls
// rather than by a caller-supplied flag that a future write could forget to set.
const limitedWriteRpcNames = new Set<string>([
  "save_student_position",
  "submit_student_answer",
  "review_student_mistake",
  "submit_student_retry",
  "save_student_rating",
  "save_student_comment",
]);

// Reads a JSON body that must hold exactly one UUID field and maps it to the
// matching RPC parameter, for example `round_id` becomes `p_round_id`.
export async function readUuidBody(
  request: Request,
  key: string,
): Promise<RpcArguments | null> {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return null;
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const entries = Object.entries(body);
  if (entries.length !== 1 || entries[0][0] !== key || !isUuid(entries[0][1])) {
    return null;
  }

  return { ["p_" + key]: entries[0][1] };
}

export function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value &&
      (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

export function platformKey(dictionaryName: string, legacyName: string): string | undefined {
  const dictionary = Deno.env.get(dictionaryName);
  if (dictionary) {
    try {
      const key = JSON.parse(dictionary)?.default;
      if (typeof key === "string" && key) {
        return key;
      }
    } catch {
      // Older local runtimes may provide only the legacy environment variables.
    }
  }

  return Deno.env.get(legacyName);
}

// PostgREST reports a raised SQLSTATE and message in its error payload. The HTTP
// status, SQLSTATE and message must all match a known triple before any stable code
// is revealed.
function diagnoseRpcError(payload: unknown, responseStatus: number): RpcError | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const { code, message } = payload as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string") {
    return null;
  }

  const mapping = rpcErrorMappings.find((candidate) =>
    candidate.sqlState === code &&
    candidate.status === responseStatus &&
    candidate.marker === message
  );
  return mapping
    ? { status: mapping.status, code: mapping.code, message: mapping.message }
    : null;
}

type RequestContext = {
  headers: Headers;
  error: (status: number, code: string, message: string) => Response;
  unavailable: () => Response;
  invalidRequest: () => Response;
  rateLimited: () => Response;
};

export function participantRequest(
  method: Method,
  handle: (request: Request, context: RequestContext) => Response | Promise<Response>,
) {
  const allowedOrigins = new Set(
    (Deno.env.get("EXAMERFRAME_ALLOWED_ORIGINS") ?? "").split(",")
      .map((origin) => origin.trim()).filter(isHttpOrigin),
  );

  return async (request: Request): Promise<Response> => {
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const error = (status: number, code: string, message: string) =>
      Response.json({ code, message }, { status, headers });
    const unavailable = () =>
      error(503, "SERVICE_UNAVAILABLE", "服务暂时无法使用，请稍后重试。");
    const invalidRequest = () =>
      error(400, "INVALID_REQUEST", "请求参数无效。");
    const wrongMethod = () => {
      headers.set("Allow", method + ", OPTIONS");
      return error(405, "METHOD_NOT_ALLOWED", "此接口不支持该请求方法。");
    };
    // The header is set before the CORS check, so only allowed origins may read
    // it; the preflight below advertises it for those origins as well.
    const rateLimited = () => {
      headers.set("Retry-After", String(WRITE_RETRY_AFTER_SECONDS));
      return error(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。");
    };

    const origin = request.headers.get("Origin");
    if (origin !== null) {
      if (!allowedOrigins.has(origin)) {
        return error(403, "ORIGIN_FORBIDDEN", "此来源无权访问答题接口。");
      }
      headers.set("Access-Control-Allow-Origin", origin);
      // Exposed on both preflight and actual responses so a denied cross-origin
      // client can read Retry-After from the real 429, not only from OPTIONS.
      headers.set("Access-Control-Expose-Headers", "Retry-After");
    }

    if (request.method === "OPTIONS") {
      headers.append("Vary", "Access-Control-Request-Method");
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (origin === null || !requestedMethod) {
        return invalidRequest();
      }
      if (requestedMethod !== method) {
        return wrongMethod();
      }

      headers.set("Access-Control-Allow-Methods", method);
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization, apikey, content-type, x-client-info",
      );
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== method) {
      return wrongMethod();
    }
    if (new URL(request.url).search) return invalidRequest();
    return handle(request, { headers, error, unavailable, invalidRequest, rateLimited });
  };
}

export function legacyParticipantWriteEndpoint() {
  return participantRequest("POST", (_request, { error }) =>
    error(409, "REFRESH_AND_SIGN_IN", "复习入口已更新，请刷新页面并登录学生账户。"));
}

export function rpcRequestHeaders(key: string): Headers {
  const headers = new Headers({ apikey: key, "Content-Type": "application/json" });
  if (signedJwt.test(key)) headers.set("Authorization", "Bearer " + key);
  return headers;
}

export type ReadStudentOperation = (request: Request) => Promise<
  { rpcName: string; args: RpcArguments } | null | "INVALID_ANSWER" | "INVALID_QUALITY" | "INVALID_COMMENT"
>;

export function participantEndpoint(
  method: Method,
  route: string | ReadStudentOperation,
  readArguments?: ReadArguments,
) {
  const registered = typeof route !== "string";
  return participantRequest(method, async (request, { headers, error, unavailable, invalidRequest, rateLimited }) => {
    const unauthorized = () =>
      error(401, "UNAUTHORIZED", "登录会话已失效，请重新登录。");

    const token = request.headers.get("Authorization")?.match(/^Bearer +(\S+)$/i)?.[1];
    if (!token || !signedJwt.test(token)) {
      return unauthorized();
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = platformKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
    const serviceKey = platformKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !publishableKey || !serviceKey) {
      return unavailable();
    }

    try {
      const auth = await fetch(new URL("/auth/v1/user", supabaseUrl), {
        headers: { apikey: publishableKey, Authorization: "Bearer " + token },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (auth.status === 401 || auth.status === 403) {
        return unauthorized();
      }
      if (auth.status === 429) {
        return rateLimited();
      }
      if (!auth.ok) {
        return unavailable();
      }

      const user = await auth.json();
      if (!isUuid(user?.id)) {
        return unauthorized();
      }
      if (registered && user.is_anonymous !== false) {
        return error(403, "STUDENT_ACCOUNT_REQUIRED", "请登录已注册的学生账户。");
      }
      if (!registered && user.is_anonymous !== true) {
        return error(403, "ANONYMOUS_REQUIRED", "请使用匿名会话参与答题。");
      }

      const parsed = registered ? await route(request) : {
        rpcName: route, args: readArguments ? await readArguments(request) : {},
      };
      if (parsed === null) return invalidRequest();
      if (parsed === "INVALID_ANSWER") {
        return error(400, "INVALID_ANSWER", "答案格式不正确。");
      }
      if (parsed === "INVALID_QUALITY") {
        return error(400, "INVALID_QUALITY", "请选择低或高。");
      }
      if (parsed === "INVALID_COMMENT") {
        return error(400, "INVALID_COMMENT", "请填写 1–2000 字的反馈意见。");
      }

      const { rpcName, args } = parsed;
      if (args === null) return invalidRequest();
      const rpcHeaders = rpcRequestHeaders(serviceKey);

      // Write slot: a valid, verified request costs one slot before the business
      // RPC runs. A rate-limited answer is a boolean, never a missing row, and a
      // failed or malformed limiter call fails closed with the generic 503 so no
      // write slips past a broken limiter.
      if (limitedWriteRpcNames.has(rpcName)) {
        const slot = await fetch(
          new URL("/rest/v1/rpc/take_participant_write_slot", supabaseUrl),
          {
            method: "POST",
            headers: rpcHeaders,
            body: JSON.stringify({ p_participant_id: user.id }),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (slot.status === 429) {
          return rateLimited();
        }
        if (!slot.ok) {
          return unavailable();
        }
        const slotAccepted = await slot.json().catch(() => null);
        if (slotAccepted === null) {
          return unavailable();
        }
        if (slotAccepted !== true) {
          return rateLimited();
        }
      }

      const result = await fetch(new URL("/rest/v1/rpc/" + rpcName, supabaseUrl), {
        method: "POST",
        headers: rpcHeaders,
        body: JSON.stringify({ ...args, p_participant_id: user.id }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) {
        const diagnosed = diagnoseRpcError(await result.json().catch(() => null), result.status);
        return diagnosed
          ? error(diagnosed.status, diagnosed.code, diagnosed.message)
          : unavailable();
      }

      return Response.json(await result.json(), { headers });
    } catch {
      return unavailable();
    }
  });
}
