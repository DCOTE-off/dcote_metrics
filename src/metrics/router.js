import { timingSafeEqual } from "crypto";

import {
	register,
	activeViewers,
	viewingDuration,
	videoViews,
	subtitlesEnabled,
} from "./metrics.js";
import { getCountry as defaultGetCountry } from "./maxmind.js";
import {
	registerSitePresenceConnection,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
} from "./sitePresence.js";
import {
	createBoundedKeySet,
	createFixedWindowRateLimiter,
	getSeriesKey,
	isRequestOriginAllowed,
} from "./security.js";

const DEFAULT_COUNTRY_LABEL = "Other";
const DEFAULT_UNKNOWN_LABEL = "Unknown";
const VIDEO_LABEL_NAMES = ["country", "season", "episode", "voice"];
const SUBTITLE_LABEL_NAMES = ["country", "season", "episode"];
const MIN_METRIC_SECONDS = 30;
const MAX_METRIC_SECONDS = 60 * 60;
const MAX_WEBSOCKET_MESSAGE_BYTES = 4096;

function parseWebsocketJsonMessage(message) {
	if (message.length > MAX_WEBSOCKET_MESSAGE_BYTES) {
		return { ok: false, error: "Message is too large" };
	}
	try {
		return { ok: true, data: JSON.parse(message.toString("utf8")) };
	} catch {
		return { ok: false, error: "Invalid JSON" };
	}
}

function tokensMatch(candidate, expected) {
	if (!candidate || !expected) return false;
	const candidateBuffer = Buffer.from(candidate);
	const expectedBuffer = Buffer.from(expected);
	return candidateBuffer.length === expectedBuffer.length
		&& timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isMetricsRequestAuthenticated(req, token) {
	const authorization = req.headers.authorization;
	if (typeof authorization !== "string") return false;
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return tokensMatch(match?.[1], token);
}

function getMetricBody(req) {
	return req.body && typeof req.body === "object" && !Array.isArray(req.body)
		? req.body
		: {};
}

function getValidMetricSeconds(body) {
	const seconds = body.seconds;
	return Number.isFinite(seconds)
		&& seconds >= MIN_METRIC_SECONDS
		&& seconds <= MAX_METRIC_SECONDS
		? seconds
		: null;
}

function normalizeEpisodePart(value) {
	if (value === null || value === undefined || value === "") {
		return DEFAULT_UNKNOWN_LABEL;
	}
	const normalized = String(value).trim();
	return /^\d{1,4}$/.test(normalized) ? normalized : null;
}

function normalizeVoice(value) {
	if (value === null || value === undefined || value === "") {
		return DEFAULT_UNKNOWN_LABEL;
	}
	if (typeof value !== "string" && typeof value !== "number") return null;
	const normalized = String(value)
		.trim()
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ");
	return normalized && normalized.length <= 80 ? normalized : null;
}

function getVideoMetricLabels(req, body, countryLookup) {
	const country = countryLookup(req.ip);
	const season = normalizeEpisodePart(body.season);
	const episode = normalizeEpisodePart(body.episode);
	const voice = normalizeVoice(body.voice);
	if (!season || !episode || !voice) return null;

	return {
		country: typeof country === "string" && /^[A-Z]{2}$/.test(country)
			? country
			: DEFAULT_COUNTRY_LABEL,
		season,
		episode,
		voice,
	};
}

function createMetricsRuntime(config, options = {}) {
	const connectionsByIp = new Map();
	let websocketConnections = 0;
	const httpLimiter = createFixedWindowRateLimiter({
		limit: config.httpRateLimit,
		windowMs: config.httpRateWindowMs,
		maxKeys: config.maxRateLimitKeys,
	});
	const videoSeries = createBoundedKeySet(config.maxVideoSeries);
	const subtitleSeries = createBoundedKeySet(config.maxSubtitleSeries);

	return {
		config,
		metricsAuthToken: options.metricsAuthToken || null,
		getCountry: options.getCountry || defaultGetCountry,
		httpLimiter,
		videoSeries,
		subtitleSeries,
		acquireWebsocket(ip) {
			const ipConnections = connectionsByIp.get(ip) || 0;
			if (
				websocketConnections >= config.maxWebsocketConnections
				|| ipConnections >= config.maxWebsocketConnectionsPerIp
			) {
				return false;
			}
			websocketConnections += 1;
			connectionsByIp.set(ip, ipConnections + 1);
			return true;
		},
		releaseWebsocket(ip) {
			const ipConnections = connectionsByIp.get(ip) || 0;
			if (ipConnections <= 1) connectionsByIp.delete(ip);
			else connectionsByIp.set(ip, ipConnections - 1);
			websocketConnections = Math.max(0, websocketConnections - 1);
		},
	};
}

function validateIngestionRequest(req, reply, runtime) {
	if (!isRequestOriginAllowed(req, runtime.config.allowedOrigins)) {
		reply.code(403).send({ error: "Origin is not allowed" });
		return false;
	}
	if (!runtime.httpLimiter.allow(req.ip)) {
		reply.header("Retry-After", "60");
		reply.code(429).send({ error: "Too many requests" });
		return false;
	}
	return true;
}

function acceptMetricSeries(reply, labels, runtime, subtitle = false) {
	const names = subtitle ? SUBTITLE_LABEL_NAMES : VIDEO_LABEL_NAMES;
	const series = subtitle ? runtime.subtitleSeries : runtime.videoSeries;
	if (series.accept(getSeriesKey(labels, names))) return true;
	reply.code(429).send({ error: "Metric series limit reached" });
	return false;
}

function createSocketMessageLimiter(limit, windowMs) {
	let count = 0;
	let resetAt = Date.now() + windowMs;
	return () => {
		const now = Date.now();
		if (now >= resetAt) {
			count = 0;
			resetAt = now + windowMs;
		}
		count += 1;
		return count <= limit;
	};
}

function setupWebsocket(socket, req, runtime, handlers = {}) {
	if (!isRequestOriginAllowed(req, runtime.config.allowedOrigins)) {
		socket.close(1008, "Origin is not allowed");
		return;
	}
	if (!runtime.acquireWebsocket(req.ip)) {
		socket.close(1013, "Server is busy");
		return;
	}

	const allowMessage = createSocketMessageLimiter(
		runtime.config.wsMessageRateLimit,
		runtime.config.httpRateWindowMs,
	);
	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		handlers.onClose?.();
		runtime.releaseWebsocket(req.ip);
	};

	handlers.onOpen?.();
	socket.on("message", (message) => {
		if (!allowMessage()) {
			socket.close(1008, "Message rate limit exceeded");
			return;
		}
		const parsed = parseWebsocketJsonMessage(message);
		const result = parsed.ok
			? handlers.onMessage?.(parsed.data) ?? { ok: true }
			: parsed;
		if (socket.readyState === 1) {
			socket.send(JSON.stringify(result));
		}
	});
	socket.once("close", cleanup);
	socket.once("error", cleanup);
}

export default async function metricsRoute(app, options) {
	const runtime = options.runtime;

	app.get("/", async (req, reply) => {
		if (!runtime.metricsAuthToken) {
			return reply.code(503).send({ error: "Metrics scrape is not configured" });
		}
		if (!isMetricsRequestAuthenticated(req, runtime.metricsAuthToken)) {
			return reply.code(403).send({ error: "Forbidden" });
		}
		reply.header("Content-Type", register.contentType);
		return register.metrics();
	});

	for (const route of ["/view-labels", "/view-started", "/viewing-time", "/subtitles"]) {
		app.post(route, async (req, reply) => {
			if (!validateIngestionRequest(req, reply, runtime)) return;
			const body = getMetricBody(req);
			const labels = getVideoMetricLabels(req, body, runtime.getCountry);
			if (!labels) return reply.code(400).send({ error: "Invalid metric labels" });

			const needsSeconds = route !== "/view-labels";
			const seconds = needsSeconds ? getValidMetricSeconds(body) : null;
			if (needsSeconds && seconds === null) {
				return reply.code(400).send({ error: "Invalid metric duration" });
			}

			const subtitle = route === "/subtitles";
			const metricLabels = subtitle
				? (({ country, season, episode }) => ({ country, season, episode }))(labels)
				: labels;
			if (!acceptMetricSeries(reply, metricLabels, runtime, subtitle)) return;

			if (route === "/view-labels") videoViews.inc(metricLabels, 0);
			else if (route === "/view-started") videoViews.inc(metricLabels);
			else if (route === "/viewing-time") viewingDuration.observe(metricLabels, seconds);
			else subtitlesEnabled.inc(metricLabels);
			return { ok: true };
		});
	}

	app.get("/ws", { websocket: true }, (socket, req) => {
		setupWebsocket(socket, req, runtime, {
			onOpen: () => activeViewers.inc(),
			onClose: () => activeViewers.dec(),
		});
	});

	app.get("/site/ws", { websocket: true }, (socket, req) => {
		const connectionId = registerSitePresenceConnection();
		setupWebsocket(socket, req, runtime, {
			onMessage: (payload) => touchSitePresenceConnection(connectionId, payload),
			onClose: () => unregisterSitePresenceConnection(connectionId),
		});
	});
}

export {
	createMetricsRuntime,
	getValidMetricSeconds,
	normalizeEpisodePart,
	normalizeVoice,
	parseWebsocketJsonMessage,
	tokensMatch,
};
