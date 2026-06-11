// @ts-check
import { defineConfig } from "astro/config";

// Project pages: https://ossia.github.io/dashboard
// DASHBOARD_BASE=/ for local preview or a custom domain.
const base = process.env.DASHBOARD_BASE ?? "/dashboard";

export default defineConfig({
  site: "https://ossia.github.io",
  base,
  output: "static",
  trailingSlash: "never",
  build: {
    // One request per page: styles are small and hand-written.
    inlineStylesheets: "always",
  },
  devToolbar: { enabled: false },
});
