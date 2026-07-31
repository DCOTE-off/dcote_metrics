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
	const playerStyleUrl = player.body.match(
		/href="(player\.css\?v=[a-f0-9]+)"/,
	)?.[1];
	const playerScriptUrl = player.body.match(
		/src="(player\.js\?v=[a-f0-9]+)"/,
	)?.[1];
	const playerSubtitlesScriptUrl = player.body.match(
		/src="(player-subtitles\.js\?v=[a-f0-9]+)"/,
	)?.[1];
	const jassubVersion = player.body.match(
		/data-jassub-version="([a-f0-9]+)"/,
	)?.[1];
	const subtitleFontVersion = player.body.match(
		/data-subtitle-font-version="([a-f0-9]+)"/,
	)?.[1];
	assert.ok(playerStyleUrl);
	assert.ok(playerScriptUrl);
	assert.ok(playerSubtitlesScriptUrl);
	assert.ok(jassubVersion);
	assert.ok(subtitleFontVersion);

	for (const [url, contentType, marker] of [
		[`/${playerStyleUrl}`, "text/css", "#player-container"],
		[
			`/metrics-api/${playerStyleUrl}`,
			"text/css",
			"#player-container",
		],
		[`/${playerScriptUrl}`, "application/javascript", "destroyPlayerSession"],
		[
			`/metrics-api/${playerScriptUrl}`,
			"application/javascript",
			"destroyPlayerSession",
		],
		[
			`/${playerSubtitlesScriptUrl}`,
			"application/javascript",
			"syncPresentationTextDisplayer",
		],
		[
			`/metrics-api/${playerSubtitlesScriptUrl}`,
			"application/javascript",
			"syncPresentationTextDisplayer",
		],
	]) {
		const asset = await app.inject({ method: "GET", url });
		assert.equal(asset.statusCode, 200);
		assert.match(asset.headers["content-type"], new RegExp(contentType));
		assert.equal(
			asset.headers["cache-control"],
			"public, max-age=31536000, immutable",
		);
		assert.match(asset.headers.etag, /^"[a-f0-9]{16}"$/);
		assert.match(asset.body, new RegExp(marker));
	}
	assert.equal(
		(await app.inject({
			method: "GET",
			url: "/vendor/shaka/shaka-player.ui.js",
		})).statusCode,
		200,
	);
	const shakaStyle = await app.inject({
		method: "GET",
		url: "/vendor/shaka/controls.css",
	});
	assert.equal(shakaStyle.statusCode, 200);
	assert.doesNotMatch(shakaStyle.body, /fonts\.gstatic\.com|fonts\.googleapis\.com/);
	for (const url of [
		`/vendor/jassub/jassub.js?v=${jassubVersion}`,
		`/metrics-api/vendor/jassub/jassub-worker.wasm?v=${jassubVersion}`,
		`/fonts/vag-rounded-next-bold.woff2?v=${subtitleFontVersion}`,
	]) {
		const asset = await app.inject({ method: "GET", url });
		assert.equal(asset.statusCode, 200);
		assert.equal(
			asset.headers["cache-control"],
			"public, max-age=31536000, immutable",
		);
	}
	const unversionedScript = await app.inject({
		method: "GET",
		url: "/player.js",
	});
	assert.equal(
		unversionedScript.headers["cache-control"],
		"public, max-age=0, must-revalidate",
	);
	const mismatchedVendor = await app.inject({
		method: "GET",
		url: "/vendor/jassub/jassub.js?v=stale",
	});
	assert.equal(
		mismatchedVendor.headers["cache-control"],
		"public, max-age=0, must-revalidate",
	);
	const notModified = await app.inject({
		method: "GET",
		url: "/player.js",
		headers: { "if-none-match": unversionedScript.headers.etag },
	});
	assert.equal(notModified.statusCode, 304);
	assert.equal(notModified.body, "");
	const compressedScript = await app.inject({
		method: "GET",
		url: `/${playerScriptUrl}`,
		headers: { "accept-encoding": "gzip" },
	});
	assert.equal(compressedScript.headers["content-encoding"], "gzip");
	assert.equal(compressedScript.headers.vary, "Accept-Encoding");
	assert.notEqual(
		compressedScript.headers.etag,
		unversionedScript.headers.etag,
	);
	const crossEncodingValidation = await app.inject({
		method: "GET",
		url: `/${playerScriptUrl}`,
		headers: {
			"accept-encoding": "identity",
			"if-none-match": compressedScript.headers.etag,
		},
	});
	assert.equal(crossEncodingValidation.statusCode, 200);
	const compressedNotModified = await app.inject({
		method: "GET",
		url: `/${playerScriptUrl}`,
		headers: {
			"accept-encoding": "gzip",
			"if-none-match": compressedScript.headers.etag,
		},
	});
	assert.equal(compressedNotModified.statusCode, 304);
	const unacceptableEncoding = await app.inject({
		method: "GET",
		url: `/${playerScriptUrl}`,
		headers: {
			"accept-encoding": "br;q=0, gzip;q=0, identity;q=0",
		},
	});
	assert.equal(unacceptableEncoding.statusCode, 406);
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
