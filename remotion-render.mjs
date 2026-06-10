import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CLI: node remotion-render.mjs <compositionId> <outputPath> [propsJson]
const [, , compositionId, outputPath, propsJsonStr] = process.argv;

if (!compositionId || !outputPath) {
  console.error("Usage: node remotion-render.mjs <compositionId> <outputPath> [propsJson]");
  process.exit(1);
}

const inputProps = propsJsonStr ? JSON.parse(propsJsonStr) : {};

const entryPoint = path.join(__dirname, "remotion-src", "Root.jsx");

try {
  const bundleLocation = await bundle({
    entryPoint,
    // Chromium path for Railway / nixpacks environment
    ...(process.env.CHROMIUM_PATH ? {} : {}),
  });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    ...(process.env.CHROMIUM_PATH
      ? { browserExecutable: process.env.CHROMIUM_PATH }
      : {}),
  });

  console.log(`✅ Rendered: ${outputPath}`);
} catch (err) {
  console.error("❌ Remotion render failed:", err.message);
  process.exit(1);
}
