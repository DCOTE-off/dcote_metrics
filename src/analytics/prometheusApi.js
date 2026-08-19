import { isIP } from "node:net";

import { isBearerTokenAuthenticated } from "../metrics/security.js";

const SELECTOR_PATTERN = /^\s*([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{([^}]*)\}\s*$/;
const LABEL_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:\\.|[^"])*)"\s*(?:,|$)/g;

// Предыдущая версия для всего, что не IPv4, возвращала
// startsWith("fc"|"fd") — то есть строки вроде "fdsa" считались внутренними.
// Адрес обязан быть разобран как IP, иначе он не внутренний.
function isInternalAddress(value) {
	const raw = String(value ?? "").trim().replace(/^::ffff:/i, "");
	const version = isIP(raw);
	if (version === 4) {
		const octets = raw.split(".").map(Number);
		return octets[0] === 10
			|| octets[0] === 127
			|| (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
			|| (octets[0] === 192 && octets[1] === 168);
	}
	if (version !== 6) return false;
	const address = raw.toLowerCase().split("%")[0];
	if (address === "::1") return true;
	// fc00::/7 — уникальные локальные адреса: первый байт 0xfc или 0xfd.
	return /^f[cd][0-9a-f]{2}:/.test(address);
}

function parseSelector(query) {
	const match = String(query || "").match(SELECTOR_PATTERN);
	if (!match) return null;
	const labels = {};
	let consumed = 0;
	for (const labelMatch of match[2].matchAll(LABEL_PATTERN)) {
		const leading = match[2].slice(consumed, labelMatch.index);
		if (leading.trim()) return null;
		// LABEL_PATTERN пропускает любой \., поэтому неверный escape вроде
		// {a="\x"} доходил сюда и выбрасывал SyntaxError мимо обработчика.
		try {
			labels[labelMatch[1]] = JSON.parse(`"${labelMatch[2]}"`);
		} catch {
			return null;
		}
		consumed = labelMatch.index + labelMatch[0].length;
	}
	if (match[2].slice(consumed).trim()) return null;
	return { metric: match[1], labels };
}

function getRequestParameter(req, name) {
	if (req.query && Object.hasOwn(req.query, name)) return req.query[name];
	if (req.body instanceof URLSearchParams) return req.body.get(name);
	if (req.body && typeof req.body === "object") return req.body[name];
	return null;
}

function parsePrometheusTime(value, fallback = Date.now()) {
	if (value === null || value === undefined || value === "") return fallback;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return Math.floor(numeric * 1000);
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

function parsePrometheusStep(value) {
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric > 0) return numeric * 1000;
	const match = String(value || "").match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
	if (!match) return null;
	const factors = {
		ms: 1,
		s: 1000,
		m: 60 * 1000,
		h: 60 * 60 * 1000,
		d: 24 * 60 * 60 * 1000,
	};
	return Number(match[1]) * factors[match[2]];
}

function success(data) {
	return { status: "success", data };
}

function error(reply, message, errorType = "bad_data") {
	return reply.code(400).send({
		status: "error",
		errorType,
		error: message,
	});
}

function getRangeFromSelector(selector, evaluationTimeMs) {
	const rangeSeconds = Number(selector.labels.range_s);
	if (!Number.isFinite(rangeSeconds) || rangeSeconds <= 0) {
		throw new Error("range_s must be a positive number");
	}
	return {
		fromMs: Math.max(0, evaluationTimeMs - rangeSeconds * 1000),
		toMs: evaluationTimeMs,
	};
}

function vectorResult(metric, rows, timestampMs, { limit } = {}) {
	const sorted = [...rows].sort((left, right) => right.value - left.value);
	const selected = Number.isInteger(limit) && limit > 0
		? sorted.slice(0, limit)
		: sorted;
	return success({
		resultType: "vector",
		result: selected.map((row) => ({
			metric: { __name__: metric, ...row.labels },
			value: [timestampMs / 1000, String(row.value)],
		})),
	});
}

function registerCompatibilityRoutes(app) {
	app.get("/api/v1/status/buildinfo", async () => success({
		version: "dcote-analytics-1",
		revision: "local",
		branch: "main",
		buildUser: "dcote",
		buildDate: "unknown",
		goVersion: "n/a",
	}));
	app.get("/api/v1/status/runtimeinfo", async () => success({
		startTime: new Date().toISOString(),
		cwd: "/usr/local/app",
		reloadConfigSuccess: true,
	}));
	app.get("/api/v1/labels", async () => success([]));
	app.get("/api/v1/series", async () => success([]));
	app.get("/api/v1/metadata", async () => success({}));
	app.get("/api/v1/label/:name/values", async () => success([]));
}

async function analyticsPrometheusApi(app, options) {
	const store = options.store;
	if (!store) throw new Error("Analytics store is required");
	const authToken = options.authToken || null;

	app.addHook("onRequest", async (req, reply) => {
		if (!authToken) {
			return reply.code(503).send({
				status: "error",
				errorType: "unavailable",
				error: "Analytics API is not configured",
			});
		}
		// req.ip следует за X-Forwarded-For, поэтому ACL опирается на
		// фактического пира сокета: заголовок подделывает любой клиент.
		if (!isInternalAddress(req.socket?.remoteAddress ?? req.ip)) {
			return reply.code(403).send({
				status: "error",
				errorType: "forbidden",
				error: "Analytics API is available only inside the metrics network",
			});
		}
		if (!isBearerTokenAuthenticated(req, authToken)) {
			return reply.code(403).send({
				status: "error",
				errorType: "forbidden",
				error: "Analytics API requires the metrics auth token",
			});
		}
	});

	registerCompatibilityRoutes(app);

	app.route({
		method: ["GET", "POST"],
		url: "/api/v1/query",
		handler: async (req, reply) => {
			const query = getRequestParameter(req, "query");
			const evaluationTimeMs = parsePrometheusTime(
				getRequestParameter(req, "time"),
			);
			if (query === "1+1" || query === "vector(1)") {
				return vectorResult("health", [{ labels: {}, value: 1 }], evaluationTimeMs);
			}

			const selector = parseSelector(query);
			if (!selector) return error(reply, "Unsupported analytics query");

			try {
				const range = getRangeFromSelector(selector, evaluationTimeMs);
				if (selector.metric === "dcote_presence_stat") {
					const presenceMetric = selector.labels.metric;
					const stat = selector.labels.stat;
					const extrema = store.getPresenceExtrema(
						presenceMetric,
						range.fromMs,
						range.toMs,
					);
					const selected = stat === "min"
						? extrema.minimum
						: stat === "max"
							? extrema.maximum
							: null;
					if (!selected) return error(reply, "stat must be min or max");
					return vectorResult(
						`dcote_presence_${stat}`,
						[{
							labels: { metric: presenceMetric },
							value: selected.value,
						}],
						evaluationTimeMs,
					);
				}

				const groupBy = selector.labels.group_by || "none";
				const rows = store.queryAggregate(
					selector.metric,
					groupBy,
					range.fromMs,
					range.toMs,
				);
				const limit = Number(selector.labels.limit);
				return vectorResult(
					selector.metric,
					rows,
					evaluationTimeMs,
					{ limit: Number.isInteger(limit) ? limit : undefined },
				);
			} catch (queryError) {
				return error(reply, queryError.message);
			}
		},
	});

	app.route({
		method: ["GET", "POST"],
		url: "/api/v1/query_range",
		handler: async (req, reply) => {
			const selector = parseSelector(getRequestParameter(req, "query"));
			if (!selector || selector.metric !== "dcote_presence") {
				return error(reply, "Unsupported analytics range query");
			}
			const fromMs = parsePrometheusTime(getRequestParameter(req, "start"));
			const toMs = parsePrometheusTime(getRequestParameter(req, "end"));
			const stepMs = parsePrometheusStep(getRequestParameter(req, "step"));
			if (!stepMs || toMs < fromMs) {
				return error(reply, "Invalid analytics range");
			}
			try {
				const metric = selector.labels.metric;
				const values = store.queryPresenceRange(
					metric,
					fromMs,
					toMs,
					stepMs,
				);
				return success({
					resultType: "matrix",
					result: [{
						metric: { __name__: "dcote_presence", metric },
						values: values.map(([timestamp, value]) => [
							timestamp / 1000,
							String(value),
						]),
					}],
				});
			} catch (queryError) {
				return error(reply, queryError.message);
			}
		},
	});

	app.get("/diagnostics", async () => store.getDiagnostics());
}

export {
	analyticsPrometheusApi,
	getRangeFromSelector,
	isInternalAddress,
	parsePrometheusStep,
	parseSelector,
};
