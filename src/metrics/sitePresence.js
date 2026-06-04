import {
	activeSiteTabs,
	activeSiteSessions,
	activeSiteUsers,
	activeSiteTabsGlobal,
	activeSiteSessionsGlobal,
	activeSiteUsersGlobal,
} from "./metrics.js";

const SITE_PRESENCE_TTL_MS = 45 * 1000;
const SITE_PRESENCE_CLEANUP_INTERVAL_MS = 15 * 1000;

const activeConnections = new Map();
const seenPages = new Set();
let nextConnectionId = 1;

function createConnectionId() {
	const sequence = nextConnectionId++;
	return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function normalizeMetricString(value, fallback = null, maxLength = 120) {
	if (value === null || value === undefined) return fallback;
	if (typeof value !== "string" && typeof value !== "number") {
		return fallback;
	}

	const normalized = String(value)
		.trim()
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ");

	if (!normalized) return fallback;
	return normalized.slice(0, maxLength);
}

function normalizePage(value) {
	let page = normalizeMetricString(value, "unknown", 160);

	try {
		const url = new URL(page);
		page = url.pathname;
	} catch {
		// Route names like "anime.show" are valid low-cardinality page labels.
	}

	const queryIndex = page.indexOf("?");
	if (queryIndex >= 0) page = page.slice(0, queryIndex);

	const hashIndex = page.indexOf("#");
	if (hashIndex >= 0) page = page.slice(0, hashIndex);

	if (page.startsWith("/")) {
		page = page.replace(/\/+/g, "/");
		if (page.length > 1) page = page.replace(/\/$/, "");
	}

	return normalizeMetricString(page, "unknown", 120);
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

function removeDuplicateTabConnections(connectionId, tabId) {
	let removedConnection = null;

	for (const [otherConnectionId, connection] of activeConnections) {
		if (otherConnectionId !== connectionId && connection.tabId === tabId) {
			if (
				!removedConnection
				|| connection.startedAt < removedConnection.startedAt
			) {
				removedConnection = connection;
			}
			activeConnections.delete(otherConnectionId);
		}
	}

	return removedConnection;
}

function setZeroForSeenPages() {
	for (const page of seenPages) {
		activeSiteTabs.set({ page }, 0);
		activeSiteSessions.set({ page }, 0);
		activeSiteUsers.set({ page }, 0);
	}
}

function updateSitePresenceMetrics() {
	const pageStats = new Map();
	const sessions = new Set();
	const users = new Set();

	setZeroForSeenPages();

	for (const connection of activeConnections.values()) {
		const page = connection.page;
		let stats = pageStats.get(page);

		if (!stats) {
			stats = {
				tabs: 0,
				sessions: new Set(),
				users: new Set(),
			};
			pageStats.set(page, stats);
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
		seenPages.add(page);
		activeSiteTabs.set({ page }, stats.tabs);
		activeSiteSessions.set({ page }, stats.sessions.size);
		activeSiteUsers.set({ page }, stats.users.size);
	}

	activeSiteTabsGlobal.set(activeConnections.size);
	activeSiteSessionsGlobal.set(sessions.size);
	activeSiteUsersGlobal.set(users.size);
}

function cleanupStaleSitePresenceConnections() {
	const now = Date.now();
	let removed = false;

	for (const [connectionId, connection] of activeConnections) {
		if (now - connection.updatedAt > SITE_PRESENCE_TTL_MS) {
			activeConnections.delete(connectionId);
			removed = true;
		}
	}

	if (removed) updateSitePresenceMetrics();
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
	const sessionId = normalizeId(
		getPayloadValue(payload, previous, "sessionId"),
	);
	const tabId = normalizeId(getPayloadValue(payload, previous, "tabId"));
	const userId = normalizeUserId(getPayloadValue(payload, previous, "userId"));

	if (!sessionId || !tabId) {
		return {
			ok: false,
			error: "sessionId and tabId are required",
		};
	}

	const duplicateConnection = removeDuplicateTabConnections(
		connectionId,
		tabId,
	);

	activeConnections.set(connectionId, {
		page,
		sessionId,
		tabId,
		userId,
		startedAt:
			previous?.startedAt
			?? duplicateConnection?.startedAt
			?? Date.now(),
		updatedAt: Date.now(),
	});

	updateSitePresenceMetrics();

	return {
		ok: true,
	};
}

function unregisterSitePresenceConnection(connectionId) {
	if (!activeConnections.delete(connectionId)) return;
	updateSitePresenceMetrics();
}

export {
	registerSitePresenceConnection,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
};
