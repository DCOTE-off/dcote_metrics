import { copyFile, mkdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const jassubRoot = join(projectRoot, "node_modules", "jassub");
const outputDir = join(projectRoot, "public", "vendor", "jassub");

const forceCanvas2DRendererPlugin = {
	name: "force-jassub-canvas-2d-renderer",
	setup(buildContext) {
		buildContext.onLoad(
			{
				filter:
					/[\\/]jassub[\\/]dist[\\/]worker[\\/]renderers[\\/]webgl[12]-renderer\.js$/,
			},
			({ path }) => {
				const rendererName = path.includes("webgl2")
					? "WebGL2Renderer"
					: "WebGL1Renderer";
				return {
					// Подменяем только renderer-модули через стабильную границу
					// сборщика, не переписывая исходный код worker регуляркой.
					contents:
						`export { Canvas2DRenderer as ${rendererName} } `
						+ 'from "./2d-renderer.js";',
					loader: "js",
					resolveDir: dirname(path),
				};
			},
		);
	},
};

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
		plugins: [forceCanvas2DRendererPlugin],
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
