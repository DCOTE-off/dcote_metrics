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

test("JASSUB worker keeps hardware renderers and the Canvas2D fallback", async () => {
	const [buildScript, worker] = await Promise.all([
		readFile(buildScriptPath, "utf8"),
		readFile(workerPath, "utf8"),
	]);

	assert.doesNotMatch(buildScript, /force-jassub-canvas-2d-renderer/);
	assert.doesNotMatch(buildScript, /webgl\[12\]-renderer\\\.js/);
	assert.match(worker, /new Canvas2DRenderer\(\)/);
	assert.match(worker, /new WebGL1Renderer\(\)/);
	assert.match(worker, /new WebGL2Renderer\(\)/);
});
