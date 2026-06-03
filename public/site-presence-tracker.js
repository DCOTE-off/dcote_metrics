(function () {
	if (window.__dcoteSitePresenceStarted) return;
	window.__dcoteSitePresenceStarted = true;

	const config = window.DCOTE_SITE_METRICS || {};
	const heartbeatMs = config.heartbeatMs || 15000;
	const reconnectMs = config.reconnectMs || 3000;
	const storageKey = config.storageKey || "dcote_metrics_session_id";

	let websocket = null;
	let reconnectTimer = null;
	let heartbeatTimer = null;
	const tabId = createId("tab");

	function createId(prefix) {
		if (window.crypto && typeof window.crypto.randomUUID === "function") {
			return `${prefix}-${window.crypto.randomUUID()}`;
		}

		return `${prefix}-${Date.now().toString(36)}-${Math.random()
			.toString(36)
			.slice(2)}`;
	}

	function getSessionId() {
		try {
			const existing = window.localStorage.getItem(storageKey);
			if (existing) return existing;

			const sessionId = createId("session");
			window.localStorage.setItem(storageKey, sessionId);
			return sessionId;
		} catch {
			return createId("session");
		}
	}

	function getCurrentScriptUrl() {
		const script = document.currentScript;
		if (script && script.src) return script.src;

		const scripts = Array.from(document.scripts);
		const current = scripts.find((item) =>
			item.src.includes("site-presence-tracker.js"),
		);
		return current ? current.src : null;
	}

	function getDefaultWebsocketUrl() {
		const scriptUrl = getCurrentScriptUrl();
		if (!scriptUrl) return null;

		const url = new URL(scriptUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.pathname = url.pathname.replace(
			/\/site-presence-tracker\.js$/,
			"/metrics/site/ws",
		);
		url.search = "";
		url.hash = "";
		return url.toString();
	}

	function getPage() {
		if (typeof config.getPage === "function") return config.getPage();
		if (config.page) return config.page;
		return window.location.pathname;
	}

	function getUserId() {
		if (typeof config.getUserId === "function") return config.getUserId();
		return config.userId ?? null;
	}

	function getPayload() {
		return {
			page: getPage(),
			userId: getUserId(),
			sessionId: getSessionId(),
			tabId,
		};
	}

	function sendPresence() {
		if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
		websocket.send(JSON.stringify(getPayload()));
	}

	function clearReconnectTimer() {
		if (!reconnectTimer) return;
		window.clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	function clearHeartbeatTimer() {
		if (!heartbeatTimer) return;
		window.clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	function scheduleReconnect() {
		clearReconnectTimer();
		clearHeartbeatTimer();
		reconnectTimer = window.setTimeout(connect, reconnectMs);
	}

	function connect() {
		const websocketUrl = config.websocketUrl || getDefaultWebsocketUrl();
		if (!websocketUrl) return;

		clearReconnectTimer();
		clearHeartbeatTimer();

		websocket = new WebSocket(websocketUrl);
		websocket.addEventListener("open", () => {
			sendPresence();
			heartbeatTimer = window.setInterval(sendPresence, heartbeatMs);
		});
		websocket.addEventListener("close", scheduleReconnect);
		websocket.addEventListener("error", () => {
			if (websocket) websocket.close();
		});
	}

	function notifyRouteChange() {
		window.setTimeout(sendPresence, 0);
	}

	function patchHistoryMethod(methodName) {
		const original = window.history[methodName];
		if (typeof original !== "function") return;

		window.history[methodName] = function patchedHistoryMethod() {
			const result = original.apply(this, arguments);
			notifyRouteChange();
			return result;
		};
	}

	patchHistoryMethod("pushState");
	patchHistoryMethod("replaceState");
	window.addEventListener("popstate", notifyRouteChange);
	window.addEventListener("visibilitychange", sendPresence);
	window.addEventListener("online", () => {
		if (!websocket || websocket.readyState === WebSocket.CLOSED) connect();
	});

	connect();
})();
