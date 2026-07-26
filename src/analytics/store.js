import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_COLUMNS = ["country", "season", "episode", "voice", "page"];
const PRESENCE_METRICS = new Set([
	"active_viewers",
	"active_site_users",
	"active_site_tabs",
	"active_site_sessions",
]);
const AGGREGATE_METRICS = Object.freeze({
	dcote_video_views: {
		source: "video_view",
		calculation: "sum",
		groups: {
			none: [],
			country: ["country"],
			season: ["season"],
			voice: ["voice"],
			episode: ["season", "episode"],
			episode_voice: ["season", "episode", "voice"],
		},
	},
	dcote_viewing_duration_seconds: {
		source: "viewing_duration",
		calculation: "sum",
		groups: { none: [] },
	},
	dcote_viewing_duration_average_seconds: {
		source: "viewing_duration",
		calculation: "average",
		groups: { none: [] },
	},
	dcote_subtitles_enabled: {
		source: "subtitles_enabled",
		calculation: "sum",
		groups: {
			none: [],
			episode: ["season", "episode"],
		},
	},
	dcote_site_visits: {
		source: "site_visit",
		calculation: "sum",
		groups: { none: [] },
	},
	dcote_site_page_visits: {
		source: "site_page_visit",
		calculation: "sum",
		groups: { page: ["page"] },
	},
});

function getUtcDayStart(timestampMs) {
	return Math.floor(timestampMs / DAY_MS) * DAY_MS;
}

function getNextUtcDayStart(timestampMs) {
	const start = getUtcDayStart(timestampMs);
	return timestampMs === start ? start : start + DAY_MS;
}

function normalizeTimestamp(value, fallback = Date.now()) {
	const timestamp = Number(value);
	return Number.isFinite(timestamp) && timestamp >= 0
		? Math.floor(timestamp)
		: fallback;
}

function normalizeEventId(metric, eventId) {
	const normalized = typeof eventId === "string"
		? eventId.trim().slice(0, 200)
		: "";
	return `${metric}:${normalized || randomUUID()}`;
}

function normalizeLabels(labels = {}) {
	return Object.fromEntries(
		LABEL_COLUMNS.map((column) => [
			column,
			typeof labels[column] === "string"
				? labels[column].slice(0, 160)
				: "",
		]),
	);
}

function createAnalyticsStore({
	path,
	retentionDays = 400,
	now = Date.now(),
} = {}) {
	if (!path) throw new Error("Analytics database path is required");
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

	const database = new DatabaseSync(path);
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;

		CREATE TABLE IF NOT EXISTS analytics_events (
			event_key TEXT PRIMARY KEY,
			metric TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			country TEXT NOT NULL DEFAULT '',
			season TEXT NOT NULL DEFAULT '',
			episode TEXT NOT NULL DEFAULT '',
			voice TEXT NOT NULL DEFAULT '',
			page TEXT NOT NULL DEFAULT '',
			value REAL NOT NULL CHECK (value >= 0)
		) WITHOUT ROWID;

		CREATE INDEX IF NOT EXISTS analytics_events_metric_time
			ON analytics_events (metric, occurred_at_ms);

		CREATE TABLE IF NOT EXISTS analytics_daily (
			day_start_ms INTEGER NOT NULL,
			metric TEXT NOT NULL,
			country TEXT NOT NULL DEFAULT '',
			season TEXT NOT NULL DEFAULT '',
			episode TEXT NOT NULL DEFAULT '',
			voice TEXT NOT NULL DEFAULT '',
			page TEXT NOT NULL DEFAULT '',
			value_sum REAL NOT NULL,
			event_count INTEGER NOT NULL,
			PRIMARY KEY (
				day_start_ms,
				metric,
				country,
				season,
				episode,
				voice,
				page
			)
		) WITHOUT ROWID;

		CREATE INDEX IF NOT EXISTS analytics_daily_metric_time
			ON analytics_daily (metric, day_start_ms);

		CREATE TABLE IF NOT EXISTS analytics_presence_transitions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			metric TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			value INTEGER NOT NULL CHECK (value >= 0)
		);

		CREATE INDEX IF NOT EXISTS analytics_presence_metric_time
			ON analytics_presence_transitions (metric, occurred_at_ms, id);

		CREATE TABLE IF NOT EXISTS analytics_presence_current (
			metric TEXT PRIMARY KEY,
			value INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL
		) WITHOUT ROWID;

		CREATE TABLE IF NOT EXISTS analytics_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		) WITHOUT ROWID;
	`);

	const insertEvent = database.prepare(`
		INSERT OR IGNORE INTO analytics_events (
			event_key,
			metric,
			occurred_at_ms,
			country,
			season,
			episode,
			voice,
			page,
			value
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const updateDaily = database.prepare(`
		INSERT INTO analytics_daily (
			day_start_ms,
			metric,
			country,
			season,
			episode,
			voice,
			page,
			value_sum,
			event_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT (
			day_start_ms,
			metric,
			country,
			season,
			episode,
			voice,
			page
		) DO UPDATE SET
			value_sum = value_sum + excluded.value_sum,
			event_count = event_count + 1
	`);
	const getPresenceCurrent = database.prepare(`
		SELECT value, updated_at_ms
		FROM analytics_presence_current
		WHERE metric = ?
	`);
	const insertPresenceTransition = database.prepare(`
		INSERT INTO analytics_presence_transitions (
			metric,
			occurred_at_ms,
			value
		) VALUES (?, ?, ?)
	`);
	const setPresenceCurrent = database.prepare(`
		INSERT INTO analytics_presence_current (metric, value, updated_at_ms)
		VALUES (?, ?, ?)
		ON CONFLICT (metric) DO UPDATE SET
			value = excluded.value,
			updated_at_ms = excluded.updated_at_ms
	`);
	const setMetadata = database.prepare(`
		INSERT INTO analytics_metadata (key, value)
		VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value
	`);
	const getMetadata = database.prepare(`
		SELECT value FROM analytics_metadata WHERE key = ?
	`);
	const getPresenceAt = database.prepare(`
		SELECT value, occurred_at_ms
		FROM analytics_presence_transitions
		WHERE metric = ? AND occurred_at_ms <= ?
		ORDER BY occurred_at_ms DESC, id DESC
		LIMIT 1
	`);
	const getPresenceTransitions = database.prepare(`
		SELECT occurred_at_ms, value
		FROM analytics_presence_transitions
		WHERE metric = ?
			AND occurred_at_ms > ?
			AND occurred_at_ms <= ?
		ORDER BY occurred_at_ms, id
	`);

	const retentionMs = Math.max(366, retentionDays) * DAY_MS;
	let closed = false;

	function transaction(callback) {
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			database.exec("COMMIT");
			return result;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}

	function recordEvent({
		metric,
		eventId,
		occurredAtMs = Date.now(),
		labels,
		value = 1,
	}) {
		if (closed) return false;
		if (!Object.values(AGGREGATE_METRICS).some(
			(definition) => definition.source === metric,
		)) {
			throw new Error(`Unknown analytics event metric: ${metric}`);
		}
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue) || numericValue < 0) {
			throw new Error("Analytics event value must be a non-negative number");
		}
		const timestamp = normalizeTimestamp(occurredAtMs);
		const normalizedLabels = normalizeLabels(labels);
		const eventKey = normalizeEventId(metric, eventId);

		return transaction(() => {
			const inserted = insertEvent.run(
				eventKey,
				metric,
				timestamp,
				normalizedLabels.country,
				normalizedLabels.season,
				normalizedLabels.episode,
				normalizedLabels.voice,
				normalizedLabels.page,
				numericValue,
			);
			if (inserted.changes === 0) return false;
			updateDaily.run(
				getUtcDayStart(timestamp),
				metric,
				normalizedLabels.country,
				normalizedLabels.season,
				normalizedLabels.episode,
				normalizedLabels.voice,
				normalizedLabels.page,
				numericValue,
			);
			return true;
		});
	}

	function recordPresence(metric, value, occurredAtMs = Date.now()) {
		if (closed) return false;
		if (!PRESENCE_METRICS.has(metric)) {
			throw new Error(`Unknown presence metric: ${metric}`);
		}
		const numericValue = Math.max(0, Math.floor(Number(value) || 0));
		const timestamp = normalizeTimestamp(occurredAtMs);
		const previous = getPresenceCurrent.get(metric);
		if (previous?.value === numericValue) return false;
		transaction(() => {
			insertPresenceTransition.run(metric, timestamp, numericValue);
			setPresenceCurrent.run(metric, numericValue, timestamp);
		});
		return true;
	}

	function heartbeatPresence(timestamp = Date.now()) {
		if (closed) return;
		const normalized = normalizeTimestamp(timestamp);
		transaction(() => {
			setMetadata.run("last_presence_heartbeat_ms", String(normalized));
		});
	}

	function recoverPresence(timestamp = Date.now(), staleAfterMs = 2 * 60 * 1000) {
		const normalized = normalizeTimestamp(timestamp);
		const lastHeartbeat = Number(
			getMetadata.get("last_presence_heartbeat_ms")?.value,
		);
		for (const metric of PRESENCE_METRICS) {
			const current = getPresenceCurrent.get(metric);
			if (!current) {
				recordPresence(metric, 0, normalized);
				continue;
			}
			if (current.value > 0) {
				const lastKnownAliveAt = Number.isFinite(lastHeartbeat)
					? lastHeartbeat
					: current.updated_at_ms;
				recordPresence(
					metric,
					0,
					Math.min(normalized, lastKnownAliveAt + staleAfterMs),
				);
			}
		}
		heartbeatPresence(normalized);
	}

	function queryAggregate(metricName, groupBy, fromMs, toMs) {
		const definition = AGGREGATE_METRICS[metricName];
		if (!definition) throw new Error(`Unknown aggregate metric: ${metricName}`);
		const groupColumns = definition.groups[groupBy];
		if (!groupColumns) throw new Error(`Unsupported group: ${groupBy}`);

		const from = normalizeTimestamp(fromMs, 0);
		const to = normalizeTimestamp(toMs, Date.now());
		if (to < from) throw new Error("Invalid analytics time range");

		const firstFullDay = getNextUtcDayStart(from);
		const finalFullDay = getUtcDayStart(to);
		const selectLabels = groupColumns.length
			? `${groupColumns.join(", ")},`
			: "";
		const groupClause = groupColumns.length
			? `GROUP BY ${groupColumns.join(", ")}`
			: "";
		const parts = [];
		const parameters = [];

		if (firstFullDay < finalFullDay) {
			if (from < firstFullDay) {
				parts.push(`
					SELECT ${selectLabels} value AS value_sum, 1 AS event_count
					FROM analytics_events
					WHERE metric = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
				`);
				parameters.push(definition.source, from, firstFullDay);
			}
			parts.push(`
				SELECT ${selectLabels} value_sum, event_count
				FROM analytics_daily
				WHERE metric = ? AND day_start_ms >= ? AND day_start_ms < ?
			`);
			parameters.push(definition.source, firstFullDay, finalFullDay);
			if (finalFullDay <= to) {
				parts.push(`
					SELECT ${selectLabels} value AS value_sum, 1 AS event_count
					FROM analytics_events
					WHERE metric = ? AND occurred_at_ms >= ? AND occurred_at_ms <= ?
				`);
				parameters.push(definition.source, finalFullDay, to);
			}
		} else {
			parts.push(`
				SELECT ${selectLabels} value AS value_sum, 1 AS event_count
				FROM analytics_events
				WHERE metric = ? AND occurred_at_ms >= ? AND occurred_at_ms <= ?
			`);
			parameters.push(definition.source, from, to);
		}

		const rows = database.prepare(`
			SELECT
				${selectLabels}
				SUM(value_sum) AS total_value,
				SUM(event_count) AS total_count
			FROM (${parts.join(" UNION ALL ")})
			${groupClause}
		`).all(...parameters);

		if (rows.length === 0 && groupColumns.length === 0) {
			return [{ labels: {}, value: 0 }];
		}
		return rows.map((row) => ({
			labels: Object.fromEntries(
				groupColumns.map((column) => [column, row[column]]),
			),
			value: definition.calculation === "average"
				? (row.total_count > 0 ? row.total_value / row.total_count : 0)
				: Number(row.total_value) || 0,
		}));
	}

	function getPresenceExtrema(metric, fromMs, toMs) {
		if (!PRESENCE_METRICS.has(metric)) {
			throw new Error(`Unknown presence metric: ${metric}`);
		}
		const from = normalizeTimestamp(fromMs, 0);
		const to = normalizeTimestamp(toMs, Date.now());
		const initial = getPresenceAt.get(metric, from) || {
			value: 0,
			occurred_at_ms: from,
		};
		const rows = getPresenceTransitions.all(metric, from, to);
		let minimum = { value: initial.value, timestamp: from };
		let maximum = { value: initial.value, timestamp: from };
		for (const row of rows) {
			if (row.value < minimum.value) {
				minimum = { value: row.value, timestamp: row.occurred_at_ms };
			}
			if (row.value > maximum.value) {
				maximum = { value: row.value, timestamp: row.occurred_at_ms };
			}
		}
		return { minimum, maximum };
	}

	function queryPresenceRange(metric, fromMs, toMs, stepMs) {
		if (!PRESENCE_METRICS.has(metric)) {
			throw new Error(`Unknown presence metric: ${metric}`);
		}
		const from = normalizeTimestamp(fromMs, 0);
		const to = normalizeTimestamp(toMs, Date.now());
		const step = Math.max(1000, Math.floor(Number(stepMs) || 1000));
		const maximumPoints = 5000;
		const effectiveStep = Math.max(step, Math.ceil((to - from) / maximumPoints));
		const values = [];
		for (let timestamp = from; timestamp <= to; timestamp += effectiveStep) {
			const row = getPresenceAt.get(metric, timestamp);
			values.push([timestamp, row?.value || 0]);
		}
		if (values.at(-1)?.[0] !== to) {
			const row = getPresenceAt.get(metric, to);
			values.push([to, row?.value || 0]);
		}

		// Keep exact extrema even though the visual history is reduced to a few
		// thousand points. This makes Grafana's Min/Max calculations exact.
		const { minimum, maximum } = getPresenceExtrema(metric, from, to);
		for (const extremum of [minimum, maximum]) {
			const matchingPoint = values.find(
				([timestamp]) => timestamp === extremum.timestamp,
			);
			if (matchingPoint?.[1] === extremum.value) continue;
			let timestamp = extremum.timestamp;
			while (
				timestamp < to
				&& values.some(([existing]) => existing === timestamp)
			) {
				timestamp += 1;
			}
			while (
				timestamp > from
				&& values.some(([existing]) => existing === timestamp)
			) {
				timestamp -= 1;
			}
			values.push([timestamp, extremum.value]);
		}
		values.sort(([left], [right]) => left - right);
		return values;
	}

	function prune(timestamp = Date.now()) {
		const cutoff = normalizeTimestamp(timestamp) - retentionMs;
		const dayCutoff = getUtcDayStart(cutoff);
		transaction(() => {
			database.prepare(
				"DELETE FROM analytics_events WHERE occurred_at_ms < ?",
			).run(cutoff);
			database.prepare(
				"DELETE FROM analytics_daily WHERE day_start_ms < ?",
			).run(dayCutoff);
			for (const metric of PRESENCE_METRICS) {
				const checkpoint = getPresenceAt.get(metric, cutoff);
				if (checkpoint) {
					insertPresenceTransition.run(metric, cutoff, checkpoint.value);
				}
				database.prepare(`
					DELETE FROM analytics_presence_transitions
					WHERE metric = ? AND occurred_at_ms < ?
				`).run(metric, cutoff);
			}
			setMetadata.run("last_pruned_at_ms", String(timestamp));
		});
	}

	function getDiagnostics() {
		return {
			events: database.prepare(
				"SELECT COUNT(*) AS count FROM analytics_events",
			).get().count,
			dailyRows: database.prepare(
				"SELECT COUNT(*) AS count FROM analytics_daily",
			).get().count,
			presenceTransitions: database.prepare(
				"SELECT COUNT(*) AS count FROM analytics_presence_transitions",
			).get().count,
		};
	}

	function getKnownLabels(kind, limit = 10_000) {
		const definitions = {
			video: {
				metrics: ["video_view", "viewing_duration"],
				columns: ["country", "season", "episode", "voice"],
			},
			subtitle: {
				metrics: ["subtitles_enabled"],
				columns: ["country", "season", "episode"],
			},
			sitePage: {
				metrics: ["site_page_visit"],
				columns: ["page"],
			},
		};
		const definition = definitions[kind];
		if (!definition) throw new Error(`Unknown analytics label kind: ${kind}`);
		const placeholders = definition.metrics.map(() => "?").join(", ");
		const rows = database.prepare(`
			SELECT DISTINCT ${definition.columns.join(", ")}
			FROM analytics_daily
			WHERE metric IN (${placeholders})
			LIMIT ?
		`).all(...definition.metrics, Math.max(1, Math.floor(limit)));
		return rows.map((row) => Object.fromEntries(
			definition.columns.map((column) => [column, row[column]]),
		));
	}

	function close() {
		if (closed) return;
		closed = true;
		database.close();
	}

	recoverPresence(now);
	prune(now);

	return {
		close,
		getDiagnostics,
		getKnownLabels,
		getPresenceExtrema,
		heartbeatPresence,
		prune,
		queryAggregate,
		queryPresenceRange,
		recordEvent,
		recordPresence,
	};
}

export {
	AGGREGATE_METRICS,
	DAY_MS,
	PRESENCE_METRICS,
	createAnalyticsStore,
	getUtcDayStart,
};
