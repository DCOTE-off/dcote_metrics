import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const buildScriptPath = new URL(
	"../scripts/build-player-vendor.mjs",
	import.meta.url,
);
const workerPath = new URL(
	"../public/vendor/jassub/jassub-worker.js",
	import.meta.url,
);

test("JASSUB Canvas2D build uses module substitution instead of source rewriting", async () => {
	const [buildScript, worker] = await Promise.all([
		readFile(buildScriptPath, "utf8"),
		readFile(workerPath, "utf8"),
	]);

	assert.match(buildScript, /webgl\[12\]-renderer\\\.js/);
	assert.match(buildScript, /Canvas2DRenderer as \$\{rendererName\}/);
	assert.doesNotMatch(buildScript, /source\.replace|rendererSelection/);
	assert.match(worker, /new Canvas2DRenderer\(\)/);
	assert.doesNotMatch(worker, /new WebGL[12]Renderer\(\)/);
});
