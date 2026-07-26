import assert from "node:assert/strict";
import test from "node:test";

import {
	cleanupStaleSitePresenceConnections,
	configureSitePresence,
	getSitePresenceDiagnostics,
	getSitePresenceSnapshot,
	heartbeatSitePresenceConnection,
	registerSitePresenceConnection,
	resetSitePresenceForTests,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
} from "../src/metrics/sitePresence.js";
import { sitePageVisits, siteVisits } from "../src/metrics/metrics.js";

async function getMetricValue(metric, expectedLabels = {}) {
	const snapshot = await metric.get();
	const value = snapshot.values.find((item) =>
		Object.entries(expectedLabels).every(
			([name, expected]) => item.labels[name] === expected,
		),
	);
	return value?.value || 0;
}

test.beforeEach(() => {
	resetSitePresenceForTests();
	configureSitePresence({
		maxSitePages: 2,
		maxRecentSessions: 2,
		maxRecentTabs: 2,
		recordVisitEvent: null,
		recordPageViewEvent: null,
		recordGlobalPresence: null,
	});
});

test("presence state deduplicates tabs and keeps caches bounded", () => {
	const first = registerSitePresenceConnection();
	assert.deepEqual(touchSitePresenceConnection(first, {
		page: "/one",
		sessionId: "session-1",
		tabId: "tab-1",
		userId: false,
	}), {
		ok: true,
		visitAcknowledged: null,
		pageViewAcknowledged: null,
	});

	const replacement = registerSitePresenceConnection();
	touchSitePresenceConnection(replacement, {
		page: "/two",
		sessionId: "session-1",
		tabId: "tab-1",
		userId: true,
	});
	for (let index = 2; index <= 4; index += 1) {
		const connection = registerSitePresenceConnection();
		touchSitePresenceConnection(connection, {
			page: `/page-${index}`,
			sessionId: `session-${index}`,
			tabId: `tab-${index}`,
		});
		unregisterSitePresenceConnection(connection);
	}

	assert.deepEqual(getSitePresenceDiagnostics(), {
		activeConnections: 1,
		recentSessions: 2,
		recentTabs: 2,
		seenPages: 2,
	});
	unregisterSitePresenceConnection(replacement);
});

test("tabs share browser sessions while registered users deduplicate by user id", () => {
	for (const [tabId, sessionId, userId] of [
		["tab-1", "browser-1", "user-a"],
		["tab-2", "browser-1", "user-a"],
		["tab-3", "browser-2", "user-a"],
		["tab-4", "browser-3", "user-b"],
	]) {
		const connection = registerSitePresenceConnection();
		touchSitePresenceConnection(connection, {
			page: "/anime",
			sessionId,
			tabId,
			userId,
			visitStarted: false,
			pageViewStarted: false,
		});
	}

	assert.deepEqual(getSitePresenceSnapshot(), {
		tabs: 4,
		sessions: 3,
		users: 2,
	});
});

test("acknowledged visit events are not replayed after presence state resets", async () => {
	const visitsBefore = await getMetricValue(siteVisits);
	const pageVisitsBefore = await getMetricValue(sitePageVisits, {
		page: "/episode",
	});
	const first = registerSitePresenceConnection();
	assert.deepEqual(touchSitePresenceConnection(first, {
		page: "/episode",
		sessionId: "browser-1",
		tabId: "tab-1",
		userId: null,
		visitId: "visit-1",
		visitStarted: true,
		pageViewId: "page-view-1",
		pageViewStarted: true,
	}), {
		ok: true,
		visitAcknowledged: "visit-1",
		pageViewAcknowledged: "page-view-1",
	});

	// Simulate a backend restart: the client keeps IDs but no longer marks the
	// already acknowledged events as new.
	resetSitePresenceForTests();
	const reconnected = registerSitePresenceConnection();
	touchSitePresenceConnection(reconnected, {
		page: "/episode",
		sessionId: "browser-1",
		tabId: "tab-1",
		userId: null,
		visitId: "visit-1",
		visitStarted: false,
		pageViewId: "page-view-1",
		pageViewStarted: false,
	});

	assert.equal((await getMetricValue(siteVisits)) - visitsBefore, 1);
	assert.equal(
		(await getMetricValue(sitePageVisits, { page: "/episode" }))
			- pageVisitsBefore,
		1,
	);
});

test("server websocket heartbeat keeps background tabs active", () => {
	const connection = registerSitePresenceConnection();
	touchSitePresenceConnection(connection, {
		page: "/anime",
		sessionId: "browser-1",
		tabId: "tab-1",
		visitStarted: false,
		pageViewStarted: false,
	});
	const now = Date.now();
	assert.equal(heartbeatSitePresenceConnection(connection, now + 100_000), true);
	cleanupStaleSitePresenceConnections(now + 150_000);
	assert.equal(getSitePresenceSnapshot().tabs, 1);
	cleanupStaleSitePresenceConnections(now + 230_001);
	assert.equal(getSitePresenceSnapshot().tabs, 0);
});
