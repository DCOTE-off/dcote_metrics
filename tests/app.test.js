import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import { getRuntimeConfig } from "../src/runtimeConfig.js";

function createConfig(overrides = {}) {
	return {
		...getRuntimeConfig({
			METRICS_ALLOWED_ORIGINS: "https://dcote.net",
			METRICS_AUTH_TOKEN_FILE: "Z:/missing/metrics-token",
			ANALYTICS_DATABASE_PATH: ":memory:",
		}),
		...overrides,
	};
}

test("player and health stay available when optional services are absent", async (t) => {
	const app = await buildApp({
		config: createConfig(),
		logger: false,
		initializeGeoDatabase: false,
	});
	t.after(() => app.close());

	const health = await app.inject({ method: "GET", url: "/health" });
	assert.equal(health.statusCode, 200);
	assert.deepEqual(health.json(), {
		ok: true,
		metricsConfigured: false,
		geoDatabaseReady: false,
		analyticsReady: true,
	});
	const player = await app.inject({ method: "GET", url: "/videoplayer" });
	assert.equal(player.statusCode, 200);
	assert.doesNotMatch(player.body, /cdn\.jsdelivr\.net/);
	assert.equal(
		(await app.inject({
			method: "GET",
			url: "/vendor/shaka/shaka-player.ui.js",
		})).statusCode,
		200,
	);
	assert.equal(
		(await app.inject({ method: "GET", url: "/metrics" })).statusCode,
		503,
	);
});

test("scrape token, origins, labels and bounded overflow series are enforced", async (t) => {
	const app = await buildApp({
		config: createConfig({ maxVideoSeries: 1 }),
		metricsAuthToken: "test-secret",
		logger: false,
		initializeGeoDatabase: false,
		getCountry: () => "NL",
	});
	t.after(() => app.close());

	const forbiddenScrape = await app.inject({ method: "GET", url: "/metrics" });
	assert.equal(forbiddenScrape.statusCode, 403);
	const scrape = await app.inject({
		method: "GET",
		url: "/metrics",
		headers: { authorization: "Bearer test-secret" },
	});
	assert.equal(scrape.statusCode, 200);
	assert.match(scrape.body, /video_views_total/);

	const disallowed = await app.inject({
		method: "POST",
		url: "/metrics/view-labels",
		headers: { origin: "https://attacker.example" },
		payload: { season: "1", episode: "1", voice: "A" },
	});
	assert.equal(disallowed.statusCode, 403);

	const invalid = await app.inject({
		method: "POST",
		url: "/metrics/view-labels",
		headers: { origin: "https://dcote.net" },
		payload: { season: "not-a-season", episode: "1", voice: "A" },
	});
	assert.equal(invalid.statusCode, 400);

	const first = await app.inject({
		method: "POST",
		url: "/metrics/view-labels",
		headers: { origin: "https://dcote.net" },
		payload: { season: "1", episode: "1", voice: "A" },
	});
	assert.equal(first.statusCode, 200);
	const overflow = await app.inject({
		method: "POST",
		url: "/metrics/view-labels",
		headers: { origin: "https://dcote.net" },
		payload: { season: "1", episode: "2", voice: "A" },
	});
	assert.equal(overflow.statusCode, 200);
	const viewStartedPayload = {
		eventId: "view-started:test-event-0001",
		seconds: 30,
		season: "1",
		episode: "1",
		voice: "A",
	};
	const countedView = await app.inject({
		method: "POST",
		url: "/metrics/view-started",
		headers: { origin: "https://dcote.net" },
		payload: viewStartedPayload,
	});
	const duplicateView = await app.inject({
		method: "POST",
		url: "/metrics/view-started",
		headers: { origin: "https://dcote.net" },
		payload: viewStartedPayload,
	});
	assert.deepEqual(countedView.json(), { ok: true, duplicate: false });
	assert.deepEqual(duplicateView.json(), { ok: true, duplicate: true });
	const metricsAfterEvents = await app.inject({
		method: "GET",
		url: "/metrics",
		headers: { authorization: "Bearer test-secret" },
	});
	assert.match(
		metricsAfterEvents.body,
		/video_views_total\{country="Other",season="Unknown",episode="Unknown",voice="Other"\} 0/,
	);
	assert.match(
		metricsAfterEvents.body,
		/subtitles_enabled_total\{country="NL",season="1",episode="1"\} 0/,
	);
	assert.match(
		metricsAfterEvents.body,
		/viewing_duration_seconds_count\{country="NL",season="1",episode="1",voice="A"\} 0/,
	);
	assert.match(
		metricsAfterEvents.body,
		/video_views_total\{country="NL",season="1",episode="1",voice="A"\} 1/,
	);
});

test("site presence websocket accepts bounded valid messages", async (t) => {
	const app = await buildApp({
		config: createConfig(),
		logger: false,
		initializeGeoDatabase: false,
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	t.after(() => app.close());
	const address = app.server.address();
	const socket = new WebSocket(
		`ws://127.0.0.1:${address.port}/metrics/site/ws`,
		{ headers: { Origin: "https://dcote.net" } },
	);
	t.after(() => socket.close());

	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	socket.send(JSON.stringify({
		page: "/anime",
		sessionId: "session-test",
		tabId: "tab-test",
		userId: "user-hash",
		visitId: "visit-test",
		visitStarted: true,
		pageViewId: "page-view-test",
		pageViewStarted: true,
	}));
	const response = await new Promise((resolve, reject) => {
		socket.once("message", (message) => resolve(JSON.parse(message)));
		socket.once("error", reject);
	});
	assert.deepEqual(response, {
		ok: true,
		visitAcknowledged: "visit-test",
		pageViewAcknowledged: "page-view-test",
	});
});
