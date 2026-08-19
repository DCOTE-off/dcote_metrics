import { readFile } from "fs/promises";
import proxyAddr from "@fastify/proxy-addr";

import { normalizeOrigin } from "./metrics/security.js";

const DEFAULT_ALLOWED_ORIGINS = [
	"https://dcote.net",
	"https://www.dcote.net",
	"https://video.dcote.net",
	"https://metrics-api.dcote.net",
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:7654",
	"http://127.0.0.1:7654",
];

const DEFAULT_PUBLIC_METRICS_BASE_URL = "https://metrics-api.dcote.net";

const DEFAULT_TRUSTED_PROXIES = [
	"127.0.0.1",
	"::1",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
];

const TRUE_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off", "disabled"]);

// Number.parseInt останавливается на первом непонятном символе, поэтому
// "1e4" превращалось в 1, а "8080abc" — в 8080. Значение env либо целиком
// является целым числом, либо не годится и заменяется fallback.
function getPositiveInteger(value, fallback, { min = 1, max = 1_000_000 } = {}) {
	if (value === null || value === undefined) return fallback;
	const normalized = String(value).trim();
	if (!normalized) return fallback;
	const parsed = Number(normalized);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
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

// Правила proxy-addr шире и строже самодельного разбора: он принимает
// маски (10.0.0.0/255.0.0.0) и пресеты только в нижнем регистре, но
// отвергает префикс /0. Любое расхождение самописного валидатора с
// библиотекой снова роняло бы процесс на верхнем уровне src/index.js,
// поэтому валидатором служит сама библиотека.
function isTrustProxyList(entries) {
	try {
		proxyAddr.compile(entries);
		return true;
	} catch {
		return false;
	}
}

function parseTrustProxy(value, warn = () => {}) {
	if (value === null || value === undefined) return [...DEFAULT_TRUSTED_PROXIES];
	const normalized = String(value).trim();
	if (!normalized) return [...DEFAULT_TRUSTED_PROXIES];
	const lowered = normalized.toLowerCase();
	if (TRUE_VALUES.has(lowered)) return true;
	if (FALSE_VALUES.has(lowered)) return false;

	const entries = parseCsv(normalized, DEFAULT_TRUSTED_PROXIES);
	if (!entries.length) {
		warn("TRUST_PROXY lists no usable proxy; using the defaults.");
		return [...DEFAULT_TRUSTED_PROXIES];
	}
	if (!isTrustProxyList(entries)) {
		warn(
			"TRUST_PROXY is not a list proxy-addr accepts: "
			+ `${entries.join(", ")}. Falling back to the defaults.`,
		);
		return [...DEFAULT_TRUSTED_PROXIES];
	}
	return entries;
}

// Сравнение идёт с new URL(origin).origin, поэтому список из env обязан
// пройти ту же нормализацию: иначе "https://dcote.net/" в .env молча
// отбрасывает всю телеметрию этого origin.
function parseAllowedOrigins(value, warn = () => {}) {
	const entries = parseCsv(value, DEFAULT_ALLOWED_ORIGINS);
	const normalized = [];
	const invalid = [];
	for (const entry of entries) {
		const origin = normalizeOrigin(entry);
		if (origin) normalized.push(origin);
		else invalid.push(entry);
	}
	if (invalid.length) {
		warn(
			`METRICS_ALLOWED_ORIGINS ignores unparsable entries: `
			+ invalid.join(", "),
		);
	}
	if (!normalized.length) {
		warn(
			"METRICS_ALLOWED_ORIGINS has no usable origin; using the defaults.",
		);
		return DEFAULT_ALLOWED_ORIGINS.map(normalizeOrigin);
	}
	return normalized;
}

function getPublicHttpBaseUrl(value, fallback = DEFAULT_PUBLIC_METRICS_BASE_URL) {
	try {
		const url = new URL(value || fallback);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return fallback;
		}
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/, "");
		return url.href.replace(/\/$/, "");
	} catch {
		return fallback;
	}
}

function getRuntimeConfig(env = process.env) {
	const warnings = [];
	const warn = (message) => warnings.push(message);

	return {
		configWarnings: warnings,
		host: env.HOST || "0.0.0.0",
		port: getPositiveInteger(env.PORT, 3000, { max: 65_535 }),
		logLevel: env.LOG_LEVEL || "info",
		trustProxy: parseTrustProxy(env.TRUST_PROXY, warn),
		allowedOrigins: new Set(parseAllowedOrigins(
			env.METRICS_ALLOWED_ORIGINS,
			warn,
		)),
		publicMetricsBaseUrl: getPublicHttpBaseUrl(
			env.METRICS_PUBLIC_BASE_URL,
		),
		metricsAuthToken: env.METRICS_AUTH_TOKEN?.trim() || null,
		metricsAuthTokenFile:
			env.METRICS_AUTH_TOKEN_FILE || "/run/secrets/metrics_auth_token",
		analyticsDatabasePath:
			env.ANALYTICS_DATABASE_PATH
			|| "/var/lib/dcote-metrics/analytics.sqlite",
		analyticsRetentionDays: getPositiveInteger(
			env.ANALYTICS_RETENTION_DAYS,
			400,
			{ min: 366, max: 3_650 },
		),
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
		maxVideoSeries: getPositiveInteger(env.METRICS_MAX_VIDEO_SERIES, 5_000),
		maxSubtitleSeries: getPositiveInteger(
			env.METRICS_MAX_SUBTITLE_SERIES,
			5_000,
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
	DEFAULT_PUBLIC_METRICS_BASE_URL,
	getPositiveInteger,
	getPublicHttpBaseUrl,
	getRuntimeConfig,
	loadMetricsAuthToken,
	parseAllowedOrigins,
	parseTrustProxy,
};
