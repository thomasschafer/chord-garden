import { join } from "node:path";
import { buildWebBundles, REPO_ROOT } from "./bundle.js";

/** `npm run build:web`: produce the browser bundles and fail loudly if they are not loadable. */
const outDir = join(REPO_ROOT, "tools/dev-server/build");
buildWebBundles(outDir)
  .then((outputs) => {
    for (const output of outputs) {
      process.stdout.write(`bundled ${output.name} (${(output.bytes / 1024).toFixed(1)} kB) → ${output.path}\n`);
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
