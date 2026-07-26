import { copyFile, mkdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const jassubRoot = join(projectRoot, "node_modules", "jassub");
const outputDir = join(projectRoot, "public", "vendor", "jassub");

const forceCanvas2DRendererPlugin = {
	name: "force-jassub-canvas-2d-renderer",
	setup(buildContext) {
		buildContext.onLoad(
			{ filter: /[\\/]jassub[\\/]dist[\\/]worker[\\/]worker\.js$/ },
			async ({ path }) => {
				const source = await readFile(path, "utf8");
				const rendererSelection =
					/^        try \{[\s\S]*?^        \}\r?\n        this\._gpurender\.setCanvas\(ctrl\);/m;

				if (!rendererSelection.test(source)) {
					throw new Error("Unable to locate the JASSUB renderer selection.");
				}

				return {
					contents: source.replace(
						rendererSelection,
						[
							"        // Прозрачный WebGL-canvas в Chromium иногда перекрывает",
							"        // аппаратное видео чёрным кадром. Canvas2D медленнее, но надёжно композитится.",
							"        this._gpurender = new Canvas2DRenderer();",
							"        this._gpurender.setCanvas(ctrl);",
						].join("\n"),
					),
					loader: "js",
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
