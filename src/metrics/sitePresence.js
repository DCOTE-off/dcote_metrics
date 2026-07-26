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

const SITE_PRESENCE_TTL_MS = 2 * 60 * 1000;
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
let analyticsHandlers = {
	recordVisitEvent: null,
	recordPageViewEvent: null,
	recordGlobalPresence: null,
};

function configureSitePresence(nextLimits = {}) {
	const {
		recordVisitEvent,
		recordPageViewEvent,
		recordGlobalPresence,
		initialPages,
		...nextNumericLimits
	} = nextLimits;
	limits = { ...limits, ...nextNumericLimits };
	analyticsHandlers = {
		recordVisitEvent: Object.hasOwn(nextLimits, "recordVisitEvent")
			? recordVisitEvent
			: analyticsHandlers.recordVisitEvent,
		recordPageViewEvent: Object.hasOwn(nextLimits, "recordPageViewEvent")
			? recordPageViewEvent
			: analyticsHandlers.recordPageViewEvent,
		recordGlobalPresence: Object.hasOwn(nextLimits, "recordGlobalPresence")
			? recordGlobalPresence
			: analyticsHandlers.recordGlobalPresence,
	};
	for (const page of initialPages || []) normalizePage(page);
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

function normalizeUserId(value, sessionId) {
	if (value === true) return `session:${sessionId}`;
	if (value === false) return null;

	const normalized = normalizeMetricString(value, null, 120);
	const comparisonValue = normalized?.toLowerCase();
	if (
		!normalized
		|| comparisonValue === "anonymous"
		|| comparisonValue === "guest"
		|| comparisonValue === "false"
		|| comparisonValue === "0"
	) {
		return null;
	}
	if (comparisonValue === "registered" || comparisonValue === "true") {
		return `session:${sessionId}`;
	}
	return normalized;
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

function recordSessionVisit(sessionId, visitId, visitStarted, now) {
	if (visitStarted === true) {
		const eventId = visitId || `session:${sessionId}`;
		const inserted = analyticsHandlers.recordVisitEvent
			? analyticsHandlers.recordVisitEvent({
				eventId,
				occurredAtMs: now,
			})
			: !recentVisitSessions.has(eventId);
		if (inserted) siteVisits.inc();
		setBoundedMapValue(
			recentVisitSessions,
			eventId,
			now,
			limits.maxRecentSessions,
		);
		return eventId;
	}
	if (visitStarted === false) return null;

	// Compatibility with tracker versions that predate explicit visit events.
	const legacyEventId = `legacy:${sessionId}`;
	const previousVisitAt = recentVisitSessions.get(legacyEventId);
	if (isExpired(previousVisitAt, now, SITE_VISIT_TTL_MS)) {
		const inserted = analyticsHandlers.recordVisitEvent
			? analyticsHandlers.recordVisitEvent({
				eventId: `${legacyEventId}:${now}`,
				occurredAtMs: now,
			})
			: true;
		if (inserted) siteVisits.inc();
	}
	setBoundedMapValue(
		recentVisitSessions,
		legacyEventId,
		now,
		limits.maxRecentSessions,
	);
	return null;
}

function recordPageVisit(
	tabId,
	page,
	pageViewId,
	pageViewStarted,
	now,
) {
	if (pageViewStarted === true) {
		const eventId = pageViewId || `tab:${tabId}:${page}`;
		const inserted = analyticsHandlers.recordPageViewEvent
			? analyticsHandlers.recordPageViewEvent({
				eventId,
				page,
				occurredAtMs: now,
			})
			: !recentPageVisits.has(eventId);
		if (inserted) sitePageVisits.inc({ page });
		setBoundedMapValue(
			recentPageVisits,
			eventId,
			{ page, lastSeenAt: now },
			limits.maxRecentTabs,
		);
		return eventId;
	}
	if (pageViewStarted === false) return null;

	// Compatibility with tracker versions that predate explicit page-view events.
	const legacyEventId = `legacy:${tabId}`;
	const previousPageVisit = recentPageVisits.get(legacyEventId);
	if (
		!previousPageVisit
		|| previousPageVisit.page !== page
		|| isExpired(previousPageVisit.lastSeenAt, now, SITE_VISIT_TTL_MS)
	) {
		const inserted = analyticsHandlers.recordPageViewEvent
			? analyticsHandlers.recordPageViewEvent({
				eventId: `${legacyEventId}:${page}:${now}`,
				page,
				occurredAtMs: now,
			})
			: true;
		if (inserted) sitePageVisits.inc({ page });
	}
	setBoundedMapValue(
		recentPageVisits,
		legacyEventId,
		{ page, lastSeenAt: now },
		limits.maxRecentTabs,
	);
	return null;
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

function updateSitePresenceMetrics(now = Date.now()) {
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
		if (connection.userId) {
			stats.users.add(connection.userId);
			users.add(connection.userId);
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
	analyticsHandlers.recordGlobalPresence?.({
		tabs: activeConnections.size,
		sessions: sessions.size,
		users: users.size,
		occurredAtMs: now,
	});
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
	if (!sessionId || !tabId) {
		return { ok: false, error: "sessionId and tabId are required" };
	}
	const userId = normalizeUserId(
		getPayloadValue(payload, previous, "userId"),
		sessionId,
	);

	const now = Date.now();
	const visitId = normalizeId(payload.visitId);
	const pageViewId = normalizeId(payload.pageViewId);
	const visitAcknowledged = recordSessionVisit(
		sessionId,
		visitId,
		payload.visitStarted,
		now,
	);
	const pageViewAcknowledged = recordPageVisit(
		tabId,
		page,
		pageViewId,
		payload.pageViewStarted,
		now,
	);
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
	return {
		ok: true,
		visitAcknowledged,
		pageViewAcknowledged,
	};
}

function heartbeatSitePresenceConnection(connectionId, now = Date.now()) {
	const connection = activeConnections.get(connectionId);
	if (!connection) return false;
	connection.updatedAt = now;
	return true;
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

function getSitePresenceSnapshot() {
	const sessions = new Set();
	const users = new Set();
	for (const connection of activeConnections.values()) {
		sessions.add(connection.sessionId);
		if (connection.userId) users.add(connection.userId);
	}
	return {
		tabs: activeConnections.size,
		sessions: sessions.size,
		users: users.size,
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
	getSitePresenceSnapshot,
	heartbeatSitePresenceConnection,
	registerSitePresenceConnection,
	resetSitePresenceForTests,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
};
