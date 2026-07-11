import {
	activeSiteTabs,
	activeSiteSessions,
	activeSiteUsers,
	activeSiteTabsGlobal,
	activeSiteSessionsGlobal,
	activeSiteUsersGlobal,
	siteVisits,
	sitePageVisits,
} from "./metrics.js";

const SITE_PRESENCE_TTL_MS = 45 * 1000;
const SITE_PRESENCE_CLEANUP_INTERVAL_MS = 15 * 1000;
const SITE_VISIT_TTL_MS = 30 * 60 * 1000;
const OTHER_PAGE = "other";

const activeConnections = new Map();
const connectionIdByTabId = new Map();
const recentVisitSessions = new Map();
const recentPageVisits = new Map();
const seenPages = new Set();
let nextConnectionId = 1;
let limits = {
	maxSitePages: 200,
	maxRecentSessions: 20_000,
	maxRecentTabs: 40_000,
};

function configureSitePresence(nextLimits = {}) {
	limits = { ...limits, ...nextLimits };
}

function createConnectionId() {
	const sequence = nextConnectionId++;
	return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function normalizeMetricString(value, fallback = null, maxLength = 120) {
	if (value === null || value === undefined) return fallback;
	if (typeof value !== "string" && typeof value !== "number") return fallback;

	const normalized = String(value)
		.trim()
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ");

	return normalized ? normalized.slice(0, maxLength) : fallback;
}

function normalizePage(value) {
	let page = normalizeMetricString(value, "unknown", 160);

	try {
		page = new URL(page).pathname;
	} catch {
		// Route names such as "anime.show" are valid low-cardinality labels.
	}

	page = page.split("?", 1)[0].split("#", 1)[0];
	if (page.startsWith("/")) {
		page = page.replace(/\/+/g, "/");
		if (page.length > 1) page = page.replace(/\/$/, "");
	}
	page = normalizeMetricString(page, "unknown", 120);

	if (seenPages.has(page)) return page;
	if (seenPages.size < Math.max(0, limits.maxSitePages - 1)) {
		seenPages.add(page);
		return page;
	}
	seenPages.add(OTHER_PAGE);
	return OTHER_PAGE;
}

function normalizeId(value) {
	return normalizeMetricString(value, null, 120);
}

function normalizeUserId(value) {
	if (value === true) return "registered";
	if (value === false) return "anonymous";

	const normalized = normalizeMetricString(value, null, 40)?.toLowerCase();
	if (
		!normalized
		|| normalized === "anonymous"
		|| normalized === "guest"
		|| normalized === "false"
		|| normalized === "0"
	) {
		return "anonymous";
	}
	return "registered";
}

function getPayloadValue(payload, previous, key) {
	return Object.hasOwn(payload, key) ? payload[key] : previous?.[key];
}

function isExpired(lastSeenAt, now, ttlMs) {
	return !lastSeenAt || now - lastSeenAt > ttlMs;
}

function setBoundedMapValue(map, key, value, maximumSize) {
	if (!map.has(key) && map.size >= maximumSize) {
		map.delete(map.keys().next().value);
	}
	map.delete(key);
	map.set(key, value);
}

function recordSessionVisit(sessionId, now) {
	const previousVisitAt = recentVisitSessions.get(sessionId);
	if (isExpired(previousVisitAt, now, SITE_VISIT_TTL_MS)) siteVisits.inc();
	setBoundedMapValue(
		recentVisitSessions,
		sessionId,
		now,
		limits.maxRecentSessions,
	);
}

function recordPageVisit(tabId, page, now) {
	const previousPageVisit = recentPageVisits.get(tabId);
	if (
		!previousPageVisit
		|| previousPageVisit.page !== page
		|| isExpired(previousPageVisit.lastSeenAt, now, SITE_VISIT_TTL_MS)
	) {
		sitePageVisits.inc({ page });
	}
	setBoundedMapValue(
		recentPageVisits,
		tabId,
		{ page, lastSeenAt: now },
		limits.maxRecentTabs,
	);
}

function removeConnection(connectionId) {
	const connection = activeConnections.get(connectionId);
	if (!connection) return false;
	activeConnections.delete(connectionId);
	if (connectionIdByTabId.get(connection.tabId) === connectionId) {
		connectionIdByTabId.delete(connection.tabId);
	}
	return true;
}

function removeDuplicateTabConnection(connectionId, tabId) {
	const otherConnectionId = connectionIdByTabId.get(tabId);
	if (!otherConnectionId || otherConnectionId === connectionId) return null;
	const otherConnection = activeConnections.get(otherConnectionId) || null;
	removeConnection(otherConnectionId);
	return otherConnection;
}

function updateSitePresenceMetrics() {
	const pageStats = new Map();
	const sessions = new Set();
	const users = new Set();

	for (const page of seenPages) {
		activeSiteTabs.set({ page }, 0);
		activeSiteSessions.set({ page }, 0);
		activeSiteUsers.set({ page }, 0);
	}

	for (const connection of activeConnections.values()) {
		let stats = pageStats.get(connection.page);
		if (!stats) {
			stats = { tabs: 0, sessions: new Set(), users: new Set() };
			pageStats.set(connection.page, stats);
		}

		stats.tabs += 1;
		stats.sessions.add(connection.sessionId);
		sessions.add(connection.sessionId);
		if (connection.userId === "registered") {
			stats.users.add(connection.sessionId);
			users.add(connection.sessionId);
		}
	}

	for (const [page, stats] of pageStats) {
		activeSiteTabs.set({ page }, stats.tabs);
		activeSiteSessions.set({ page }, stats.sessions.size);
		activeSiteUsers.set({ page }, stats.users.size);
	}

	activeSiteTabsGlobal.set(activeConnections.size);
	activeSiteSessionsGlobal.set(sessions.size);
	activeSiteUsersGlobal.set(users.size);
}

function cleanupStaleSitePresenceConnections(now = Date.now()) {
	let changed = false;
	for (const [connectionId, connection] of activeConnections) {
		if (now - connection.updatedAt > SITE_PRESENCE_TTL_MS) {
			changed = removeConnection(connectionId) || changed;
		}
	}
	for (const [sessionId, lastSeenAt] of recentVisitSessions) {
		if (isExpired(lastSeenAt, now, SITE_VISIT_TTL_MS)) {
			recentVisitSessions.delete(sessionId);
		}
	}
	for (const [tabId, visit] of recentPageVisits) {
		if (isExpired(visit.lastSeenAt, now, SITE_VISIT_TTL_MS)) {
			recentPageVisits.delete(tabId);
		}
	}
	if (changed) updateSitePresenceMetrics();
}

const cleanupTimer = setInterval(
	cleanupStaleSitePresenceConnections,
	SITE_PRESENCE_CLEANUP_INTERVAL_MS,
);
cleanupTimer.unref?.();

function registerSitePresenceConnection() {
	return createConnectionId();
}

function touchSitePresenceConnection(connectionId, payload = {}) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		payload = {};
	}

	const previous = activeConnections.get(connectionId);
	const page = normalizePage(getPayloadValue(payload, previous, "page"));
	const sessionId = normalizeId(getPayloadValue(payload, previous, "sessionId"));
	const tabId = normalizeId(getPayloadValue(payload, previous, "tabId"));
	const userId = normalizeUserId(getPayloadValue(payload, previous, "userId"));
	if (!sessionId || !tabId) {
		return { ok: false, error: "sessionId and tabId are required" };
	}

	const now = Date.now();
	recordSessionVisit(sessionId, now);
	recordPageVisit(tabId, page, now);
	const duplicate = removeDuplicateTabConnection(connectionId, tabId);
	const changed = !previous
		|| Boolean(duplicate)
		|| previous.page !== page
		|| previous.sessionId !== sessionId
		|| previous.tabId !== tabId
		|| previous.userId !== userId;

	if (previous?.tabId && previous.tabId !== tabId) {
		connectionIdByTabId.delete(previous.tabId);
	}
	activeConnections.set(connectionId, {
		page,
		sessionId,
		tabId,
		userId,
		startedAt: previous?.startedAt ?? duplicate?.startedAt ?? now,
		updatedAt: now,
	});
	connectionIdByTabId.set(tabId, connectionId);
	if (changed) updateSitePresenceMetrics();
	return { ok: true };
}

function unregisterSitePresenceConnection(connectionId) {
	if (removeConnection(connectionId)) updateSitePresenceMetrics();
}

function getSitePresenceDiagnostics() {
	return {
		activeConnections: activeConnections.size,
		recentSessions: recentVisitSessions.size,
		recentTabs: recentPageVisits.size,
		seenPages: seenPages.size,
	};
}

function resetSitePresenceForTests() {
	activeConnections.clear();
	connectionIdByTabId.clear();
	recentVisitSessions.clear();
	recentPageVisits.clear();
	seenPages.clear();
	nextConnectionId = 1;
	updateSitePresenceMetrics();
}

export {
	cleanupStaleSitePresenceConnections,
	configureSitePresence,
	getSitePresenceDiagnostics,
	registerSitePresenceConnection,
	resetSitePresenceForTests,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
};
