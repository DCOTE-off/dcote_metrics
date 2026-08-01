import assert from "node:assert/strict";
import test from "node:test";

import {
	createBoundedKeySet,
	createFixedWindowRateLimiter,
	isRequestOriginAllowed,
} from "../src/metrics/security.js";
import {
	normalizeEpisodePart,
	normalizeVoice,
	tokensMatch,
} from "../src/metrics/router.js";
import {
	DEFAULT_PUBLIC_METRICS_BASE_URL,
	getPublicHttpBaseUrl,
} from "../src/runtimeConfig.js";

test("bounded series set rejects new keys after its limit", () => {
	const keys = createBoundedKeySet(2);
	assert.equal(keys.accept("one"), true);
	assert.equal(keys.accept("two"), true);
	assert.equal(keys.accept("one"), true);
	assert.equal(keys.accept("three"), false);
	assert.equal(keys.size, 2);
});

test("rate limiter resets after the configured window", () => {
	const limiter = createFixedWindowRateLimiter({
		limit: 2,
		windowMs: 1000,
		maxKeys: 10,
	});
	assert.equal(limiter.allow("ip", 100), true);
	assert.equal(limiter.allow("ip", 200), true);
	assert.equal(limiter.allow("ip", 300), false);
	assert.equal(limiter.allow("ip", 1200), true);
});

test("origin and metric label validation reject unbounded input", () => {
	const request = { headers: { origin: "https://dcote.net/path" } };
	assert.equal(
		isRequestOriginAllowed(request, new Set(["https://dcote.net"])),
		true,
	);
	assert.equal(
		isRequestOriginAllowed({ headers: {} }, new Set(["https://dcote.net"])),
		false,
	);
	assert.equal(normalizeEpisodePart("004"), "004");
	assert.equal(normalizeEpisodePart("season-four"), null);
	assert.equal(normalizeVoice("  Voice   A  "), "Voice A");
	assert.equal(normalizeVoice("x".repeat(81)), null);
});

test("token comparison handles missing and different-length values", () => {
	assert.equal(tokensMatch("secret", "secret"), true);
	assert.equal(tokensMatch("wrong", "secret"), false);
	assert.equal(tokensMatch(null, "secret"), false);
});

test("public metrics base URL is normalized and rejects unsafe protocols", () => {
	assert.equal(
		getPublicHttpBaseUrl("https://metrics.example/api/?ignored=true#hash"),
		"https://metrics.example/api",
	);
	assert.equal(
		getPublicHttpBaseUrl("javascript:alert(1)"),
		DEFAULT_PUBLIC_METRICS_BASE_URL,
	);
});
