import { defineConfig, envField } from "astro/config";

// Public site URL used to build absolute links (optional so local builds
// keep working without any environment). In Pages CI this is passed from
// actions/configure-pages outputs; build validation refuses non-HTTPS URLs.
const SITE_URL = process.env.EXAMERFRAME_SITE_URL;
const BASE_PATH = process.env.EXAMERFRAME_BASE_PATH;

// `actions/configure-pages` reports "/" for user sites and "/<repo>/" for
// project sites; Astro accepts undefined for root deployments.
function normalizeBase(value) {
  if (value === undefined || value === "") return undefined;
  if (value === "/") return undefined;
  return value.endsWith("/") ? value : `${value}/`;
}

export default defineConfig({
  output: "static",
  site: SITE_URL || undefined,
  base: normalizeBase(BASE_PATH),
  env: {
    schema: {
      EXAMERFRAME_PRIVACY_RETENTION: envField.string({ context: "server", access: "public", optional: true }),
      EXAMERFRAME_PRIVACY_CONTACT: envField.string({ context: "server", access: "public", optional: true }),

      // Optional locally to keep `npm run dev`/`npm run build` dependency-free;
      // the Pages workflow validates both before building.
      PUBLIC_SUPABASE_URL: envField.string({
        context: "client",
        access: "public",
        optional: true,
        url: true,
      }),
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: envField.string({
        context: "client",
        access: "public",
        optional: true,
        startsWith: "sb_publishable_",
      }),
    },
  },
});
