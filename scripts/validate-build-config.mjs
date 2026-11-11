// Validate the public GitHub Pages build configuration without printing its values.
function requireConfig(condition, name, instruction) {
  if (!condition) {
    console.error(name + ": " + instruction);
    process.exit(1);
  }
}

function httpsOrigin(value) {
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/?$/i.test(value)) return false;
  try {
    const { hostname } = new URL(value);
    return hostname !== "localhost" && !hostname.endsWith(".localhost") && !hostname.startsWith("127.");
  } catch {
    return false;
  }
}

const env = process.env;
const base = env.EXAMERFRAME_BASE_PATH || "/";
const key = env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";

requireConfig(httpsOrigin(env.EXAMERFRAME_SITE_URL || ""), "EXAMERFRAME_SITE_URL", "provide the HTTPS Pages origin.");
requireConfig(base === "/" || /^\/[a-z0-9_.-]+\/?$/i.test(base) && !/^\/\.{1,2}\/?$/.test(base),
  "EXAMERFRAME_BASE_PATH", "provide / or a single repository path prefix.");
requireConfig(httpsOrigin(env.PUBLIC_SUPABASE_URL || ""), "PUBLIC_SUPABASE_URL", "provide the HTTPS project origin.");
requireConfig(/^sb_publishable_[a-z0-9_-]{12,}$/i.test(key) && key.startsWith("sb_publishable_") && !key.includes("sb_secret_"),
  "PUBLIC_SUPABASE_PUBLISHABLE_KEY", "provide the public project key.");
requireConfig(env.EXAMERFRAME_PRIVACY_RETENTION?.trim(), "EXAMERFRAME_PRIVACY_RETENTION", "provide the approved retention text.");
requireConfig(env.EXAMERFRAME_PRIVACY_CONTACT?.trim(), "EXAMERFRAME_PRIVACY_CONTACT", "provide the approved contact and deletion instructions.");

console.log("Pages build configuration accepted.");
