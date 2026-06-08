import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createReadStream } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";
import { readFile, stat } from "fs/promises";
import metricsRoute from "./metrics/router.js";

const fastify = Fastify({
	//logger: true,
	trustProxy: true,
});

fastify.get("/health", async (req, reply) => {
	return { ok: true };
});

const videoPlayerPath = join(process.cwd(), "public", "player.html");
const videoPlayerFile = await readFile(videoPlayerPath);
const subtitleFontPath = join(
	process.cwd(),
	"public",
	"fonts",
	"vag-rounded-next-bold.woff2",
);
const subtitleFontFile = await readFile(subtitleFontPath);
const jassubVendorRootPath = join(
	process.cwd(),
	"public",
	"vendor",
	"jassub",
);
const jassubVendorAssets = new Map([
	["jassub.js", "application/javascript"],
	["jassub-worker.js", "application/javascript"],
	["jassub-worker.wasm", "application/wasm"],
	["jassub-worker-modern.wasm", "application/wasm"],
	["LICENSE", "text/plain"],
]);
const sitePresenceTrackerPath = join(
	process.cwd(),
	"public",
	"site-presence-tracker.js",
);
const sitePresenceTrackerFile = await readFile(sitePresenceTrackerPath);
const testAssetsRootPath = resolve(process.cwd(), "test");
const testAssetTypes = new Map([
	[".m3u8", "application/vnd.apple.mpegurl"],
	[".ts", "video/mp2t"],
	[".vtt", "text/vtt"],
	[".ass", "text/plain; charset=utf-8"],
	[".mp4", "video/mp4"],
	[".m4s", "video/iso.segment"],
	[".m4a", "audio/mp4"],
	[".aac", "audio/aac"],
]);

function getTestAssetType(filePath) {
	return testAssetTypes.get(extname(filePath).toLowerCase())
		|| "application/octet-stream";
}

fastify.get("/videoplayer", async (req, reply) => {
	reply.type("text/html").send(videoPlayerFile);
});

async function sendSubtitleFont(req, reply) {
	reply.type("font/woff2").send(subtitleFontFile);
}

fastify.get("/fonts/vag-rounded-next-bold.woff2", sendSubtitleFont);
fastify.get("/metrics-api/fonts/vag-rounded-next-bold.woff2", sendSubtitleFont);

async function sendJassubVendorAsset(req, reply) {
	const assetName = req.params.file;
	const contentType = jassubVendorAssets.get(assetName);
	if (!contentType) {
		return reply.code(404).send({ error: "Not found" });
	}

	reply.header("Cache-Control", "public, max-age=31536000, immutable");
	reply.type(contentType);
	return reply.send(createReadStream(join(jassubVendorRootPath, assetName)));
}

fastify.get("/vendor/jassub/:file", sendJassubVendorAsset);
fastify.get("/metrics-api/vendor/jassub/:file", sendJassubVendorAsset);

fastify.get("/site-presence-tracker.js", async (req, reply) => {
	reply.type("application/javascript").send(sitePresenceTrackerFile);
});

fastify.get("/metrics-api/site-presence-tracker.js", async (req, reply) => {
	reply.type("application/javascript").send(sitePresenceTrackerFile);
});

fastify.get("/test/*", async (req, reply) => {
	const requestPath = req.params["*"] || "";
	if (requestPath.includes("\0")) {
		return reply.code(400).send({ error: "Bad request" });
	}

	let decodedPath;
	try {
		decodedPath = decodeURIComponent(requestPath);
	} catch {
		return reply.code(400).send({ error: "Bad request" });
	}

	const filePath = resolve(testAssetsRootPath, decodedPath);
	const pathInsideTestRoot = relative(testAssetsRootPath, filePath);
	if (
		pathInsideTestRoot.startsWith("..")
		|| isAbsolute(pathInsideTestRoot)
	) {
		return reply.code(403).send({ error: "Forbidden" });
	}

	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) {
			return reply.code(404).send({ error: "Not found" });
		}
	} catch {
		return reply.code(404).send({ error: "Not found" });
	}

	reply.header("Cache-Control", "no-store");
	reply.type(getTestAssetType(filePath));
	return reply.send(createReadStream(filePath));
});

fastify.register(fastifyWebsocket);
fastify.register(metricsRoute, { prefix: "/metrics" });
fastify.register(metricsRoute, { prefix: "/metrics-api/metrics" });

const start = async () => {
	try {
		const port = Number(process.env.PORT) || 3000;
		const host = process.env.HOST || "0.0.0.0";
		await fastify.listen({ port, host });
	} catch (err) {
		console.error(err);
		fastify.log.error(err);
		process.exit(1);
	}
};
start();
