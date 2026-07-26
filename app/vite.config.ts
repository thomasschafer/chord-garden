import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The app is built, not dev-served.
 *
 * A Vite dev server would be a second origin, and the session token, the Origin
 * check and the sample endpoint all belong to the one origin the dev server owns
 * (PLAN.md §10). Building into `app/dist` and letting that server mount it under
 * `/app/` keeps a single origin and matches how a packaged desktop build will
 * serve the same files. `npm run watch -w @chord-garden/app` covers iteration.
 */
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
