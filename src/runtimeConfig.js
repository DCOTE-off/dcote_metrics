import { readFile } from "fs/promises";

const DEFAULT_ALLOWED_ORIGINS = [
	"https://dcote.net",
	"https://www.dcote.net",
	"https://video.dcote.net",
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:7654",
	"http://127.0.0.1:7654",
];

const DEFAULT_TRUSTED_PROXIES = [
	"127.0.0.1",
	"::1",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
];

function getPositiveInteger(value, fallback, { min = 1, max = 1_000_000 } = {}) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		return fallback;
	}
	return parsed;
}

function parseCsv(value, fallback) {
	if (!value) return [...fallback];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseTrustProxy(value) {
	if (!value) return [...DEFAULT_TRUSTED_PROXIES];
	if (value === "false") return false;
	if (value === "true") return true;
	return parseCsv(value, DEFAULT_TRUSTED_PROXIES);
}

function getRuntimeConfig(env = process.env) {
	return {
		host: env.HOST || "0.0.0.0",
		port: getPositiveInteger(env.PORT, 3000, { max: 65_535 }),
		logLevel: env.LOG_LEVEL || "info",
		trustProxy: parseTrustProxy(env.TRUST_PROXY),
		allowedOrigins: new Set(parseCsv(
			env.METRICS_ALLOWED_ORIGINS,
			DEFAULT_ALLOWED_ORIGINS,
		)),
		metricsAuthToken: env.METRICS_AUTH_TOKEN?.trim() || null,
		metricsAuthTokenFile:
			env.METRICS_AUTH_TOKEN_FILE || "/run/secrets/metrics_auth_token",
		httpRateLimit: getPositiveInteger(env.METRICS_HTTP_RATE_LIMIT, 240),
		httpRateWindowMs: getPositiveInteger(
			env.METRICS_HTTP_RATE_WINDOW_MS,
			60_000,
			{ min: 1_000 },
		),
		wsMessageRateLimit: getPositiveInteger(
			env.METRICS_WS_MESSAGE_RATE_LIMIT,
			120,
		),
		maxRateLimitKeys: getPositiveInteger(
			env.METRICS_MAX_RATE_LIMIT_KEYS,
			10_000,
		),
		maxVideoSeries: getPositiveInteger(env.METRICS_MAX_VIDEO_SERIES, 500),
		maxSubtitleSeries: getPositiveInteger(
			env.METRICS_MAX_SUBTITLE_SERIES,
			500,
		),
		maxSitePages: getPositiveInteger(env.METRICS_MAX_SITE_PAGES, 200),
		maxRecentSessions: getPositiveInteger(
			env.METRICS_MAX_RECENT_SESSIONS,
			20_000,
		),
		maxRecentTabs: getPositiveInteger(
			env.METRICS_MAX_RECENT_TABS,
			40_000,
		),
		maxWebsocketConnections: getPositiveInteger(
			env.METRICS_MAX_WS_CONNECTIONS,
			2_000,
		),
		maxWebsocketConnectionsPerIp: getPositiveInteger(
			env.METRICS_MAX_WS_CONNECTIONS_PER_IP,
			40,
		),
	};
}

async function loadMetricsAuthToken(config, onError = () => {}) {
	if (config.metricsAuthToken) return config.metricsAuthToken;

	try {
		const token = (await readFile(config.metricsAuthTokenFile, "utf8")).trim();
		return token || null;
	} catch (error) {
		if (error?.code !== "ENOENT") onError(error);
		return null;
	}
}

export {
	DEFAULT_ALLOWED_ORIGINS,
	getPositiveInteger,
	getRuntimeConfig,
	loadMetricsAuthToken,
};
