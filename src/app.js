import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createReadStream } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";
import { readFile, stat } from "fs/promises";

import metricsRoute, { createMetricsRuntime } from "./metrics/router.js";
import { initializeCountryLookup } from "./metrics/maxmind.js";
import { configureSitePresence } from "./metrics/sitePresence.js";
import { getRuntimeConfig, loadMetricsAuthToken } from "./runtimeConfig.js";

const jsonError = (error) => ({ error });
const LEGACY_METRICS_AUTH_TOKEN = "SUPERSECRETPASSWORD";

async function buildApp(options = {}) {
	const config = options.config || getRuntimeConfig();
	const projectRoot = options.projectRoot || process.cwd();
	const publicPath = (...segments) => join(projectRoot, "public", ...segments);
	const app = Fastify({
		logger: options.logger ?? { level: config.logLevel },
		trustProxy: config.trustProxy,
		bodyLimit: 16 * 1024,
	});

	const configuredMetricsAuthToken = options.metricsAuthToken ?? await loadMetricsAuthToken(
		config,
		(error) => app.log.warn({ error }, "Unable to read metrics auth secret"),
	);
	// Keep the existing Prometheus deployment working until the secret rotation
	// is shipped as a separate infrastructure change.
	const metricsAuthToken = configuredMetricsAuthToken || LEGACY_METRICS_AUTH_TOKEN;
	if (!configuredMetricsAuthToken) {
		app.log.warn("Using the legacy metrics scrape token; rotate it in a dedicated deploy");
	}
	const geoDatabaseReady = options.initializeGeoDatabase === false
		? false
		: await initializeCountryLookup(
			options.countryDatabasePath,
			(error) => app.log.warn(
				{ error },
				"Country database is unavailable; using fallback label",
			),
		);

	configureSitePresence({
		maxSitePages: config.maxSitePages,
		maxRecentSessions: config.maxRecentSessions,
		maxRecentTabs: config.maxRecentTabs,
	});
	const runtime = createMetricsRuntime(config, {
		metricsAuthToken,
		getCountry: options.getCountry,
	});

	app.addHook("onSend", async (req, reply, payload) => {
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("Referrer-Policy", "same-origin");
		return payload;
	});

	app.setErrorHandler((error, req, reply) => {
		req.log.error({ error }, "Request failed");
		const statusCode = error.statusCode && error.statusCode < 500
			? error.statusCode
			: 500;
		reply.code(statusCode).send({
			error: statusCode === 500 ? "Internal server error" : error.message,
		});
	});

	app.get("/health", async () => ({
		ok: true,
		metricsConfigured: Boolean(metricsAuthToken),
		geoDatabaseReady,
	}));

	const videoPlayerFile = await readFile(publicPath("player.html"));
	const subtitleFontFile = await readFile(
		publicPath("fonts", "vag-rounded-next-bold.woff2"),
	);
	const jassubVendorRootPath = publicPath("vendor", "jassub");
	const jassubVendorAssets = new Map([
		["jassub.js", "application/javascript"],
		["jassub-worker.js", "application/javascript"],
		["jassub-worker.wasm", "application/wasm"],
		["jassub-worker-modern.wasm", "application/wasm"],
		["LICENSE", "text/plain"],
	]);
	const shakaVendorRootPath = join(
		projectRoot,
		"node_modules",
		"shaka-player",
		"dist",
	);
	const shakaVendorAssets = new Map([
		["shaka-player.ui.js", "application/javascript"],
		["controls.css", "text/css"],
	]);
	const sitePresenceTrackerFile = await readFile(
		publicPath("site-presence-tracker.js"),
	);
	const fileXIcon = await readFile(publicPath("icons", "file-x.svg"));
	const testAssetsRootPath = resolve(projectRoot, "test");
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

	function registerGetAliases(paths, handler) {
		for (const path of paths) app.get(path, handler);
	}

	function getSafeTestAssetPath(requestPath) {
		if (requestPath.includes("\0")) {
			return { ok: false, status: 400, error: "Bad request" };
		}
		let decodedPath;
		try {
			decodedPath = decodeURIComponent(requestPath);
		} catch {
			return { ok: false, status: 400, error: "Bad request" };
		}
		const filePath = resolve(testAssetsRootPath, decodedPath);
		const pathInsideTestRoot = relative(testAssetsRootPath, filePath);
		if (pathInsideTestRoot.startsWith("..") || isAbsolute(pathInsideTestRoot)) {
			return { ok: false, status: 403, error: "Forbidden" };
		}
		return { ok: true, filePath };
	}

	async function sendVideoPlayer(req, reply) {
		reply.header("Cache-Control", "no-store");
		reply.header(
			"Content-Security-Policy",
			`frame-ancestors 'self' ${[...config.allowedOrigins].join(" ")}`,
		);
		reply.type("text/html");
		return reply.send(videoPlayerFile);
	}
	app.get("/videoplayer", sendVideoPlayer);

	async function sendSubtitleFont(req, reply) {
		reply.type("font/woff2");
		return reply.send(subtitleFontFile);
	}
	registerGetAliases([
		"/fonts/vag-rounded-next-bold.woff2",
		"/metrics-api/fonts/vag-rounded-next-bold.woff2",
	], sendSubtitleFont);

	async function sendJassubVendorAsset(req, reply) {
		const assetName = req.params.file;
		const contentType = jassubVendorAssets.get(assetName);
		if (!contentType) return reply.code(404).send(jsonError("Not found"));
		reply.header("Cache-Control", "public, max-age=0, must-revalidate");
		reply.type(contentType);
		return reply.send(createReadStream(join(jassubVendorRootPath, assetName)));
	}
	registerGetAliases([
		"/vendor/jassub/:file",
		"/metrics-api/vendor/jassub/:file",
	], sendJassubVendorAsset);

	async function sendShakaVendorAsset(req, reply) {
		const assetName = req.params.file;
		const contentType = shakaVendorAssets.get(assetName);
		if (!contentType) return reply.code(404).send(jsonError("Not found"));
		reply.header("Cache-Control", "public, max-age=86400, immutable");
		reply.type(contentType);
		return reply.send(createReadStream(join(shakaVendorRootPath, assetName)));
	}
	registerGetAliases([
		"/vendor/shaka/:file",
		"/metrics-api/vendor/shaka/:file",
	], sendShakaVendorAsset);

	async function sendSitePresenceTracker(req, reply) {
		reply.type("application/javascript");
		return reply.send(sitePresenceTrackerFile);
	}
	registerGetAliases([
		"/site-presence-tracker.js",
		"/metrics-api/site-presence-tracker.js",
	], sendSitePresenceTracker);

	async function sendFileXIcon(req, reply) {
		reply.header("Cache-Control", "public, max-age=86400, immutable");
		reply.type("image/svg+xml");
		return reply.send(fileXIcon);
	}
	registerGetAliases([
		"/icons/file-x.svg",
		"/metrics-api/icons/file-x.svg",
	], sendFileXIcon);

	app.get("/test/*", async (req, reply) => {
		const asset = getSafeTestAssetPath(req.params["*"] || "");
		if (!asset.ok) return reply.code(asset.status).send(jsonError(asset.error));
		try {
			if (!(await stat(asset.filePath)).isFile()) {
				return reply.code(404).send(jsonError("Not found"));
			}
		} catch {
			return reply.code(404).send(jsonError("Not found"));
		}
		reply.header("Cache-Control", "no-store");
		reply.type(
			testAssetTypes.get(extname(asset.filePath).toLowerCase())
			|| "application/octet-stream",
		);
		return reply.send(createReadStream(asset.filePath));
	});

	await app.register(fastifyWebsocket);
	await app.register(metricsRoute, { prefix: "/metrics", runtime });
	await app.register(metricsRoute, {
		prefix: "/metrics-api/metrics",
		runtime,
	});

	return app;
}

export { buildApp };
