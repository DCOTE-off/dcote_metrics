import assert from "node:assert/strict";
import test from "node:test";

import {
	configureSitePresence,
	getSitePresenceDiagnostics,
	registerSitePresenceConnection,
	resetSitePresenceForTests,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
} from "../src/metrics/sitePresence.js";

test.beforeEach(() => {
	resetSitePresenceForTests();
	configureSitePresence({
		maxSitePages: 2,
		maxRecentSessions: 2,
		maxRecentTabs: 2,
	});
});

test("presence state deduplicates tabs and keeps caches bounded", () => {
	const first = registerSitePresenceConnection();
	assert.deepEqual(touchSitePresenceConnection(first, {
		page: "/one",
		sessionId: "session-1",
		tabId: "tab-1",
		userId: false,
	}), { ok: true });

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
