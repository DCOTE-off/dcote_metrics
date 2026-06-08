import { copyFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const jassubRoot = join(projectRoot, "node_modules", "jassub");
const outputDir = join(projectRoot, "public", "vendor", "jassub");

await mkdir(outputDir, { recursive: true });

await Promise.all([
	build({
		entryPoints: [join(jassubRoot, "dist", "jassub.js")],
		outfile: join(outputDir, "jassub.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		legalComments: "eof",
	}),
	build({
		entryPoints: [join(jassubRoot, "dist", "worker", "worker.js")],
		outfile: join(outputDir, "jassub-worker.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		legalComments: "eof",
	}),
]);

await Promise.all([
	copyFile(
		join(jassubRoot, "dist", "wasm", "jassub-worker.wasm"),
		join(outputDir, "jassub-worker.wasm"),
	),
	copyFile(
		join(jassubRoot, "dist", "wasm", "jassub-worker-modern.wasm"),
		join(outputDir, "jassub-worker-modern.wasm"),
	),
	copyFile(join(jassubRoot, "LICENSE"), join(outputDir, "LICENSE")),
]);
