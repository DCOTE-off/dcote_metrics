import Fastify from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyWebsocket from "@fastify/websocket";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	brotliCompressSync,
	constants as zlibConstants,
	gzipSync,
} from "node:zlib";
import { extname, isAbsolute, join, relative, resolve } from "path";
import { readFile, stat } from "fs/promises";

import { analyticsPrometheusApi } from "./analytics/prometheusApi.js";
import { createAnalyticsStore } from "./analytics/store.js";
import metricsRoute, { createMetricsRuntime } from "./metrics/router.js";
import { initializeCountryLookup } from "./metrics/maxmind.js";
import { configureSitePresence } from "./metrics/sitePresence.js";
import { getRuntimeConfig, loadMetricsAuthToken } from "./runtimeConfig.js";

const jsonError = (error) => ({ error });
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const STATIC_COMPRESSION_THRESHOLD = 1024;

function getContentHash(content) {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function createStaticAsset(body, contentType, version = getContentHash(body)) {
	const representations = new Map();
	const addRepresentation = (encoding, representationBody) => {
		representations.set(encoding, {
			body: representationBody,
			etag: `"${getContentHash(representationBody)}"`,
		});
	};
	addRepresentation("identity", body);
	if (
		body.length >= STATIC_COMPRESSION_THRESHOLD
		&& (
			contentType.startsWith("text/")
			|| contentType === "application/javascript"
			|| contentType === "application/wasm"
			|| contentType === "image/svg+xml"
		)
	) {
		const brotliBody = brotliCompressSync(body, {
			params: {
				[zlibConstants.BROTLI_PARAM_QUALITY]: 5,
			},
		});
		const gzipBody = gzipSync(body, { level: 6 });
		if (brotliBody.length < body.length) {
			addRepresentation("br", brotliBody);
		}
		if (gzipBody.length < body.length) {
			addRepresentation("gzip", gzipBody);
		}
	}
	return {
		contentType,
		representations,
		version,
	};
}

function selectStaticRepresentation(request, asset) {
	const acceptEncoding = request.headers["accept-encoding"];
	if (typeof acceptEncoding !== "string" || !acceptEncoding.trim()) {
		return ["identity", asset.representations.get("identity")];
	}

	const qualities = new Map();
	for (const item of acceptEncoding.toLowerCase().split(",")) {
		const [rawEncoding, ...parameters] = item.trim().split(";");
		if (!rawEncoding) continue;
		let quality = 1;
		for (const parameter of parameters) {
			const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/);
			if (match) quality = Number(match[1]);
		}
		qualities.set(rawEncoding, quality);
	}
	const wildcardQuality = qualities.get("*");
	const getQuality = (encoding) => {
		if (qualities.has(encoding)) return qualities.get(encoding);
		if (encoding === "identity") {
			return wildcardQuality === 0 ? 0 : 0.001;
		}
		return wildcardQuality ?? 0;
	};

	let selected = null;
	let selectedQuality = 0;
	for (const encoding of ["br", "gzip", "identity"]) {
		const representation = asset.representations.get(encoding);
		const quality = representation ? getQuality(encoding) : 0;
		if (quality > selectedQuality) {
			selected = [encoding, representation];
			selectedQuality = quality;
		}
	}
	return selected;
}

async function buildApp(options = {}) {
	const config = options.config || getRuntimeConfig();
	const projectRoot = options.projectRoot || process.cwd();
	const publicPath = (...segments) => join(projectRoot, "public", ...segments);
	const app = Fastify({
		logger: options.logger ?? { level: config.logLevel },
		trustProxy: config.trustProxy,
		bodyLimit: 16 * 1024,
	});
	app.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string" },
		(req, body, done) => done(null, new URLSearchParams(body)),
	);
	await app.register(fastifyCompress, {
		global: true,
		threshold: 1024,
	});

	const metricsAuthToken = options.metricsAuthToken ?? await loadMetricsAuthToken(
		config,
		(error) => app.log.warn({ error }, "Unable to read metrics auth secret"),
	);
	const geoDatabaseReady = options.initializeGeoDatabase === false
		? false
		: await initializeCountryLookup(
			options.countryDatabasePath,
			(error) => app.log.warn(
				{ error },
				"Country database is unavailable; using fallback label",
			),
		);
	const ownsAnalyticsStore = !options.analyticsStore;
	const analyticsStore = options.analyticsStore || createAnalyticsStore({
		path: config.analyticsDatabasePath,
		retentionDays: config.analyticsRetentionDays,
	});

	configureSitePresence({
		maxSitePages: config.maxSitePages,
		maxRecentSessions: config.maxRecentSessions,
		maxRecentTabs: config.maxRecentTabs,
		initialPages: analyticsStore
			.getKnownLabels("sitePage", config.maxSitePages)
			.map(({ page }) => page),
		recordVisitEvent: ({ eventId, occurredAtMs }) => analyticsStore.recordEvent({
			metric: "site_visit",
			eventId,
			occurredAtMs,
		}),
		recordPageViewEvent: ({ eventId, page, occurredAtMs }) =>
			analyticsStore.recordEvent({
				metric: "site_page_visit",
				eventId,
				occurredAtMs,
				labels: { page },
			}),
		recordGlobalPresence: ({ tabs, sessions, users, occurredAtMs }) => {
			analyticsStore.recordPresence("active_site_tabs", tabs, occurredAtMs);
			analyticsStore.recordPresence(
				"active_site_sessions",
				sessions,
				occurredAtMs,
			);
			analyticsStore.recordPresence("active_site_users", users, occurredAtMs);
		},
	});
	const runtime = createMetricsRuntime(config, {
		metricsAuthToken,
		getCountry: options.getCountry,
		analyticsStore,
	});
	const analyticsHeartbeatTimer = setInterval(
		() => analyticsStore.heartbeatPresence(),
		30 * 1000,
	);
	analyticsHeartbeatTimer.unref?.();
	const analyticsPruneTimer = setInterval(
		() => analyticsStore.prune(),
		24 * 60 * 60 * 1000,
	);
	analyticsPruneTimer.unref?.();
	app.addHook("onClose", async () => {
		clearInterval(analyticsHeartbeatTimer);
		clearInterval(analyticsPruneTimer);
		const timestamp = Date.now();
		for (const metric of [
			"active_viewers",
			"active_site_users",
			"active_site_tabs",
			"active_site_sessions",
		]) {
			analyticsStore.recordPresence(metric, 0, timestamp);
		}
		analyticsStore.heartbeatPresence(timestamp);
		if (ownsAnalyticsStore) analyticsStore.close();
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
		analyticsReady: true,
	}));

	const videoPlayerTemplate = await readFile(
		publicPath("player.html"),
		"utf8",
	);
	const playerStyleTemplate = await readFile(
		publicPath("player.css"),
		"utf8",
	);
	const playerScriptFile = await readFile(publicPath("player.js"));
	const playerSubtitlesScriptFile = await readFile(
		publicPath("player-subtitles.js"),
	);
	const subtitleFontFile = await readFile(
		publicPath("fonts", "vag-rounded-next-bold.woff2"),
	);
	const subtitleFontAsset = createStaticAsset(
		subtitleFontFile,
		"font/woff2",
	);
	const jassubVendorRootPath = publicPath("vendor", "jassub");
	const jassubVendorAssetTypes = new Map([
		["jassub.js", "application/javascript"],
		["jassub-worker.js", "application/javascript"],
		["jassub-worker.wasm", "application/wasm"],
		["jassub-worker-modern.wasm", "application/wasm"],
		["LICENSE", "text/plain"],
	]);
	const jassubVendorFiles = new Map(await Promise.all(
		[...jassubVendorAssetTypes].map(async ([filename, contentType]) => [
			filename,
			{
				body: await readFile(join(jassubVendorRootPath, filename)),
				contentType,
			},
		]),
	));
	const jassubVersionHash = createHash("sha256");
	for (const [filename, asset] of jassubVendorFiles) {
		jassubVersionHash.update(filename).update("\0").update(asset.body);
	}
	const jassubVersion = jassubVersionHash.digest("hex").slice(0, 16);
	const jassubVendorAssets = new Map(
		[...jassubVendorFiles].map(([filename, asset]) => [
			filename,
			createStaticAsset(asset.body, asset.contentType, jassubVersion),
		]),
	);
	const shakaVendorRootPath = join(
		projectRoot,
		"node_modules",
		"shaka-player",
		"dist",
	);
	const shakaVendorAssetTypes = new Map([
		["shaka-player.ui.js", "application/javascript"],
		["controls.css", "text/css"],
	]);
	const shakaVendorAssets = new Map(await Promise.all(
		[...shakaVendorAssetTypes].map(async ([filename, contentType]) => {
			let body = await readFile(join(shakaVendorRootPath, filename));
			if (filename === "controls.css") {
				body = Buffer.from(
					body.toString("utf8").replace(
						/@font-face\{font-family:Roboto[^}]*\}/g,
						"",
					),
				);
			}
			return [filename, createStaticAsset(body, contentType)];
		}),
	));
	const sitePresenceTrackerFile = await readFile(
		publicPath("site-presence-tracker.js"),
	);
	const fileXIcon = await readFile(publicPath("icons", "file-x.svg"));
	const fileXIconAsset = createStaticAsset(fileXIcon, "image/svg+xml");
	const playerStyleFile = Buffer.from(
		playerStyleTemplate.replace(
			"fonts/vag-rounded-next-bold.woff2",
			`fonts/vag-rounded-next-bold.woff2?v=${subtitleFontAsset.version}`,
		),
	);
	const playerStyleAsset = createStaticAsset(playerStyleFile, "text/css");
	const playerScriptAsset = createStaticAsset(
		playerScriptFile,
		"application/javascript",
	);
	const playerSubtitlesScriptAsset = createStaticAsset(
		playerSubtitlesScriptFile,
		"application/javascript",
	);
	const shakaScriptVersion =
		shakaVendorAssets.get("shaka-player.ui.js").version;
	const shakaStyleVersion = shakaVendorAssets.get("controls.css").version;
	const videoPlayerFile = Buffer.from(
		videoPlayerTemplate
			.replace(
				"vendor/shaka/shaka-player.ui.js",
				`vendor/shaka/shaka-player.ui.js?v=${shakaScriptVersion}`,
			)
			.replace(
				"vendor/shaka/controls.css",
				`vendor/shaka/controls.css?v=${shakaStyleVersion}`,
			)
			.replace(
				'href="player.css"',
				`href="player.css?v=${playerStyleAsset.version}"`,
			)
			.replace(
				'src="icons/file-x.svg"',
				`src="icons/file-x.svg?v=${fileXIconAsset.version}"`,
			)
			.replace(
				'<script defer src="player.js"></script>',
				`<script defer src="player.js?v=${playerScriptAsset.version}" `
				+ `data-jassub-version="${jassubVersion}" `
				+ `data-subtitle-font-version="${subtitleFontAsset.version}">`
				+ "</script>",
			)
			.replace(
				'<script defer src="player-subtitles.js"></script>',
				`<script defer src="player-subtitles.js?v=`
				+ `${playerSubtitlesScriptAsset.version}"></script>`,
			),
	);
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

	function registerGetAliases(paths, handler, options) {
		for (const path of paths) {
			app.get(path, options || {}, handler);
		}
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

	function sendStaticAsset(req, reply, asset) {
		const selectedRepresentation = selectStaticRepresentation(req, asset);
		if (!selectedRepresentation) {
			return reply.code(406).send(jsonError("No acceptable encoding"));
		}
		const [encoding, representation] = selectedRepresentation;
		const requestedVersion = req.query?.v;
		reply.header(
			"Cache-Control",
			requestedVersion === asset.version
				? IMMUTABLE_CACHE_CONTROL
				: REVALIDATE_CACHE_CONTROL,
		);
		if (asset.representations.size > 1) {
			reply.header("Vary", "Accept-Encoding");
		}
		if (encoding !== "identity") {
			reply.header("Content-Encoding", encoding);
		}
		reply.header("ETag", representation.etag);
		const ifNoneMatch = req.headers["if-none-match"];
		if (
			typeof ifNoneMatch === "string"
			&& ifNoneMatch.split(",").some((candidate) => {
				const value = candidate.trim();
				return value === "*"
					|| value === representation.etag
					|| value === `W/${representation.etag}`;
			})
		) {
			return reply.code(304).send();
		}
		reply.type(asset.contentType);
		return reply.send(representation.body);
	}

	function createStaticAssetHandler(asset) {
		return async function sendAsset(req, reply) {
			return sendStaticAsset(req, reply, asset);
		};
	}
	registerGetAliases([
		"/player.css",
		"/metrics-api/player.css",
	], createStaticAssetHandler(playerStyleAsset), { compress: false });
	registerGetAliases([
		"/player.js",
		"/metrics-api/player.js",
	], createStaticAssetHandler(playerScriptAsset), { compress: false });
	registerGetAliases([
		"/player-subtitles.js",
		"/metrics-api/player-subtitles.js",
	], createStaticAssetHandler(playerSubtitlesScriptAsset), {
		compress: false,
	});

	async function sendSubtitleFont(req, reply) {
		return sendStaticAsset(req, reply, subtitleFontAsset);
	}
	registerGetAliases([
		"/fonts/vag-rounded-next-bold.woff2",
		"/metrics-api/fonts/vag-rounded-next-bold.woff2",
	], sendSubtitleFont, { compress: false });

	async function sendJassubVendorAsset(req, reply) {
		const assetName = req.params.file;
		const asset = jassubVendorAssets.get(assetName);
		if (!asset) return reply.code(404).send(jsonError("Not found"));
		return sendStaticAsset(req, reply, asset);
	}
	registerGetAliases([
		"/vendor/jassub/:file",
		"/metrics-api/vendor/jassub/:file",
	], sendJassubVendorAsset, { compress: false });

	async function sendShakaVendorAsset(req, reply) {
		const assetName = req.params.file;
		const asset = shakaVendorAssets.get(assetName);
		if (!asset) return reply.code(404).send(jsonError("Not found"));
		return sendStaticAsset(req, reply, asset);
	}
	registerGetAliases([
		"/vendor/shaka/:file",
		"/metrics-api/vendor/shaka/:file",
	], sendShakaVendorAsset, { compress: false });

	async function sendSitePresenceTracker(req, reply) {
		reply.type("application/javascript");
		return reply.send(sitePresenceTrackerFile);
	}
	registerGetAliases([
		"/site-presence-tracker.js",
		"/metrics-api/site-presence-tracker.js",
	], sendSitePresenceTracker);

	async function sendFileXIcon(req, reply) {
		return sendStaticAsset(req, reply, fileXIconAsset);
	}
	registerGetAliases([
		"/icons/file-x.svg",
		"/metrics-api/icons/file-x.svg",
	], sendFileXIcon, { compress: false });

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
	await app.register(analyticsPrometheusApi, {
		prefix: "/analytics",
		store: analyticsStore,
	});
	await app.register(metricsRoute, { prefix: "/metrics", runtime });
	await app.register(metricsRoute, {
		prefix: "/metrics-api/metrics",
		runtime,
	});

	return app;
}

export { buildApp };
