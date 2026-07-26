import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAnalyticsStore, DAY_MS } from "../src/analytics/store.js";
import { buildApp } from "../src/app.js";
import { getRuntimeConfig } from "../src/runtimeConfig.js";

const START = Date.UTC(2026, 0, 1);

function record(store, metric, eventId, occurredAtMs, labels = {}, value = 1) {
	return store.recordEvent({
		metric,
		eventId,
		occurredAtMs,
		labels,
		value,
	});
}

test("analytics combines daily totals with exact boundary events", () => {
	const store = createAnalyticsStore({ path: ":memory:", now: START });
	assert.deepEqual(
		store.queryAggregate(
			"dcote_video_views",
			"none",
			START,
			START + DAY_MS,
		),
		[{ labels: {}, value: 0 }],
	);
	const labels = {
		country: "NL",
		season: "1",
		episode: "1",
		voice: "A",
	};

	assert.equal(record(
		store,
		"video_view",
		"view-before",
		START + 12 * 60 * 60 * 1000,
		labels,
	), true);
	assert.equal(record(
		store,
		"video_view",
		"view-left-boundary",
		START + DAY_MS + 60 * 60 * 1000,
		labels,
	), true);
	assert.equal(record(
		store,
		"video_view",
		"view-full-day",
		START + 2 * DAY_MS + 2 * 60 * 60 * 1000,
		labels,
	), true);
	assert.equal(record(
		store,
		"video_view",
		"view-after",
		START + 3 * DAY_MS + 3 * 60 * 60 * 1000,
		labels,
	), true);
	assert.equal(record(
		store,
		"video_view",
		"view-full-day",
		START + 2 * DAY_MS + 2 * 60 * 60 * 1000,
		labels,
	), false);

	const from = START + DAY_MS + 30 * 60 * 1000;
	const to = START + 3 * DAY_MS + 2 * 60 * 60 * 1000;
	assert.deepEqual(
		store.queryAggregate("dcote_video_views", "none", from, to),
		[{ labels: {}, value: 2 }],
	);
	assert.deepEqual(
		store.queryAggregate("dcote_video_views", "episode_voice", from, to),
		[{
			labels: { season: "1", episode: "1", voice: "A" },
			value: 2,
		}],
	);
	assert.deepEqual(store.getKnownLabels("video"), [labels]);

	record(
		store,
		"viewing_duration",
		"duration-1",
		START + DAY_MS,
		labels,
		30,
	);
	record(
		store,
		"viewing_duration",
		"duration-2",
		START + 2 * DAY_MS,
		labels,
		90,
	);
	assert.equal(
		store.queryAggregate(
			"dcote_viewing_duration_seconds",
			"none",
			START,
			START + 3 * DAY_MS,
		)[0].value,
		120,
	);
	assert.equal(
		store.queryAggregate(
			"dcote_viewing_duration_average_seconds",
			"none",
			START,
			START + 3 * DAY_MS,
		)[0].value,
		60,
	);
	store.close();
});

test("analytics persists deduplication and exact presence extrema", () => {
	const directory = mkdtempSync(join(tmpdir(), "dcote-analytics-"));
	const path = join(directory, "analytics.sqlite");
	try {
		let store = createAnalyticsStore({ path, now: START });
		assert.equal(record(
			store,
			"site_visit",
			"visit-1",
			START + 1000,
		), true);
		store.recordPresence("active_viewers", 2, START + 2000);
		store.recordPresence("active_viewers", 7, START + 3000);
		store.recordPresence("active_viewers", 1, START + 4000);
		store.close();

		store = createAnalyticsStore({ path, now: START + 5000 });
		assert.equal(record(
			store,
			"site_visit",
			"visit-1",
			START + 1000,
		), false);
		assert.deepEqual(
			store.queryAggregate(
				"dcote_site_visits",
				"none",
				START,
				START + 10_000,
			),
			[{ labels: {}, value: 1 }],
		);
		const extrema = store.getPresenceExtrema(
			"active_viewers",
			START,
			START + 4500,
		);
		assert.equal(extrema.minimum.value, 0);
		assert.equal(extrema.maximum.value, 7);
		const range = store.queryPresenceRange(
			"active_viewers",
			START,
			START + 4500,
			2000,
		);
		assert.ok(range.some(([, value]) => value === 7));
		assert.ok(range.length <= 5003);
		store.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Grafana-compatible analytics API returns vectors and bounded matrices", async (t) => {
	const store = createAnalyticsStore({ path: ":memory:", now: START });
	record(
		store,
		"video_view",
		"api-view",
		START + 1000,
		{ country: "NL", season: "1", episode: "1", voice: "A" },
	);
	store.recordPresence("active_viewers", 3, START + 2000);
	const config = getRuntimeConfig({
		METRICS_ALLOWED_ORIGINS: "https://dcote.net",
		METRICS_AUTH_TOKEN_FILE: "Z:/missing/metrics-token",
		ANALYTICS_DATABASE_PATH: ":memory:",
	});
	const app = await buildApp({
		config,
		analyticsStore: store,
		logger: false,
		initializeGeoDatabase: false,
	});
	t.after(async () => {
		await app.close();
		store.close();
	});

	const query = new URLSearchParams({
		query: 'dcote_video_views{range_s="10",group_by="none"}',
		time: String((START + 5000) / 1000),
	});
	const response = await app.inject({
		method: "POST",
		url: "/analytics/api/v1/query",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		payload: query.toString(),
	});
	assert.equal(response.statusCode, 200);
	assert.equal(response.json().data.result[0].value[1], "1");

	const rangeQuery = new URLSearchParams({
		query: 'dcote_presence{metric="active_viewers"}',
		start: String(START / 1000),
		end: String((START + 5000) / 1000),
		step: "1s",
	});
	const rangeResponse = await app.inject({
		method: "POST",
		url: "/analytics/api/v1/query_range",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		payload: rangeQuery.toString(),
	});
	assert.equal(rangeResponse.statusCode, 200);
	const values = rangeResponse.json().data.result[0].values;
	assert.ok(values.some(([, value]) => value === "3"));
	assert.ok(values.length <= 5003);
});
