(function () {
	if (window.__dcoteSitePresenceStarted) return;
	window.__dcoteSitePresenceStarted = true;

	const config = window.DCOTE_SITE_METRICS || {};
	const heartbeatMs = config.heartbeatMs || 15000;
	const reconnectMs = config.reconnectMs || 3000;
	const reconnectJitterMs =
		config.reconnectJitterMs ?? Math.min(1500, Math.max(500, reconnectMs / 2));
	const storageKey = config.storageKey || "dcote_metrics_session_id";

	let websocket = null;
	let reconnectTimer = null;
	let heartbeatTimer = null;
	let sessionId = null;
	let pageIsActive = true;
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
		if (sessionId) return sessionId;

		try {
			const existing = window.sessionStorage.getItem(storageKey);
			if (existing) {
				sessionId = existing;
				return sessionId;
			}

			sessionId = createId("session");
			window.sessionStorage.setItem(storageKey, sessionId);
			return sessionId;
		} catch {
			sessionId = createId("session");
			return sessionId;
		}
	}

	function getCurrentScriptUrl() {
		const script = document.currentScript;
		if (script && script.src) return script.src;

		const scripts = Array.from(document.scripts);
		const current = scripts.find((item) =>
			item.dataset.dcoteSitePresence !== undefined
			|| item.src.includes("/metrics-api/"),
		);
		return current ? current.src : null;
	}

	function getDefaultWebsocketUrl() {
		const metricsBaseUrl =
			config.metricsBaseUrl || config.apiBaseUrl || getInferredMetricsBaseUrl();
		if (!metricsBaseUrl) return null;

		const url = new URL(metricsBaseUrl, window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const basePath = url.pathname.replace(/\/+$/, "");
		url.pathname = `${basePath}/metrics/site/ws`;
		url.search = "";
		url.hash = "";
		return url.toString();
	}

	function getInferredMetricsBaseUrl() {
		const scriptUrl = getCurrentScriptUrl();
		if (!scriptUrl) return window.location.origin;

		const url = new URL(scriptUrl);
		const metricsApiPath = "/metrics-api";
		const metricsApiIndex = url.pathname.indexOf(`${metricsApiPath}/`);

		if (metricsApiIndex >= 0) {
			url.pathname = url.pathname.slice(
				0,
				metricsApiIndex + metricsApiPath.length,
			);
		} else {
			url.pathname = "";
		}

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
		let value = config.isRegistered ?? config.userId ?? false;

		if (typeof config.getIsRegistered === "function") {
			value = config.getIsRegistered();
		} else if (typeof config.getUserId === "function") {
			value = config.getUserId();
		}

		return value ? "registered" : "anonymous";
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

	function getReconnectDelay() {
		return reconnectMs + Math.floor(Math.random() * reconnectJitterMs);
	}

	function scheduleReconnect() {
		if (!pageIsActive) return;
		clearReconnectTimer();
		clearHeartbeatTimer();
		reconnectTimer = window.setTimeout(connect, getReconnectDelay());
	}

	function connect() {
		if (!pageIsActive) return;

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

	function handleVisibilityChange() {
		if (document.visibilityState === "visible") notifyRouteChange();
	}

	function handlePageHide() {
		pageIsActive = false;
		clearReconnectTimer();
		clearHeartbeatTimer();

		if (
			websocket
			&& (
				websocket.readyState === WebSocket.OPEN
				|| websocket.readyState === WebSocket.CONNECTING
			)
		) {
			websocket.close();
		}

		websocket = null;
	}

	function handlePageShow() {
		pageIsActive = true;
		if (!websocket || websocket.readyState === WebSocket.CLOSED) connect();
		notifyRouteChange();
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
	window.addEventListener("visibilitychange", handleVisibilityChange);
	window.addEventListener("pagehide", handlePageHide);
	window.addEventListener("pageshow", handlePageShow);
	window.addEventListener("online", () => {
		if (!websocket || websocket.readyState === WebSocket.CLOSED) connect();
	});

	connect();
})();
