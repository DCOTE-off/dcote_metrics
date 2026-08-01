// Контент плеера остаётся на video.dcote.net, а телеметрия использует
// отдельный metrics-api origin, переданный сервером в data-атрибуте.
const playerParams = new URLSearchParams(location.search);
const playerScriptElement = document.currentScript;
const VIEW_METRIC_THRESHOLD_SECONDS = 30;
const MOBILE_ABR_MAX_HEIGHT = 720;
const DESKTOP_ABR_MAX_HEIGHT = 1080;
// Высокая стартовая оценка заставляет ABR выбрать верхний вариант в пределах
// ограничения 1080p/720p; после первых сегментов Shaka использует измерения.
const INITIAL_ABR_BANDWIDTH_ESTIMATE = 100_000_000;
const MOBILE_LAYOUT_QUERY =
	"(max-width: 900px), (pointer: coarse) and (max-height: 500px)";
function getNumberParam(name, fallback, min = -Infinity, max = Infinity) {
	const rawValue = playerParams.get(name);
	if (rawValue === null || rawValue.trim() === "") return fallback;
	const value = Number(rawValue);
	return Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}
const defaultVttBottomLine = getNumberParam(
	"vtt_bottom_line",
	88,
	0,
	100,
);
const localHostnamePattern =
	/^(localhost|127\.0\.0\.1|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const isLocalHost = localHostnamePattern.test(location.hostname);
const stage =
	playerParams.get("stage") ||
	(isLocalHost ? "dev" : "prod");
const playerAssetBaseUrl = new URL(
	".",
	playerScriptElement?.src || document.baseURI,
);
const playerAssetBase = playerAssetBaseUrl.href.replace(/\/$/, "");
const configuredMetricsBaseUrl =
	playerScriptElement?.dataset.metricsBaseUrl
	|| "https://metrics-api.dcote.net";
const metricsBaseUrl =
	stage === "dev"
		? location.origin
		: configuredMetricsBaseUrl.replace(/\/+$/, "");
const jassubAssetVersion =
	playerScriptElement?.dataset.jassubVersion || "unversioned";
const subtitleFontAssetVersion =
	playerScriptElement?.dataset.subtitleFontVersion || "unversioned";
const websocketEndpoint = new URL(`${metricsBaseUrl}/metrics/ws`);
websocketEndpoint.protocol =
	websocketEndpoint.protocol === "https:" ? "wss:" : "ws:";
const websocketUrl = websocketEndpoint.href;
const activeViewerPresence = {
	reconnectAttempt: 0,
	reconnectTimerId: null,
	shouldConnect: false,
	socket: null,
};
const playerLifecycle = {
	cleanupTasks: [],
	destroyed: false,
	player: null,
	ui: null,
	zoomState: null,
};

function listen(target, type, handler, options) {
	if (playerLifecycle.destroyed) return handler;
	target.addEventListener(type, handler, options);
	playerLifecycle.cleanupTasks.push(() => {
		target.removeEventListener(type, handler, options);
	});
	return handler;
}

function clearActiveViewerReconnectTimer() {
	if (!activeViewerPresence.reconnectTimerId) return;
	clearTimeout(activeViewerPresence.reconnectTimerId);
	activeViewerPresence.reconnectTimerId = null;
}

function scheduleActiveViewerReconnect() {
	if (
		!activeViewerPresence.shouldConnect
		|| activeViewerPresence.reconnectTimerId
		|| navigator.onLine === false
	) {
		return;
	}
	const maximumDelay = Math.min(
		30000,
		1000 * 2 ** Math.min(activeViewerPresence.reconnectAttempt, 5),
	);
	const delay = maximumDelay * (0.75 + Math.random() * 0.5);
	activeViewerPresence.reconnectAttempt += 1;
	activeViewerPresence.reconnectTimerId = setTimeout(() => {
		activeViewerPresence.reconnectTimerId = null;
		connectActiveViewerPresence();
	}, delay);
}

function connectActiveViewerPresence() {
	if (!activeViewerPresence.shouldConnect) return;
	if (
		activeViewerPresence.socket
		&& (
			activeViewerPresence.socket.readyState === WebSocket.OPEN
			|| activeViewerPresence.socket.readyState ===
				WebSocket.CONNECTING
		)
	) {
		return;
	}

	let socket;
	try {
		socket = new WebSocket(websocketUrl);
	} catch {
		scheduleActiveViewerReconnect();
		return;
	}
	activeViewerPresence.socket = socket;
	socket.addEventListener("open", () => {
		if (activeViewerPresence.socket !== socket) return;
		activeViewerPresence.reconnectAttempt = 0;
	});
	socket.addEventListener("close", () => {
		if (activeViewerPresence.socket !== socket) return;
		activeViewerPresence.socket = null;
		scheduleActiveViewerReconnect();
	});
	socket.addEventListener("error", () => socket.close());
}

function setActiveViewerPresence(active) {
	activeViewerPresence.shouldConnect = active;
	if (active) {
		connectActiveViewerPresence();
		return;
	}

	clearActiveViewerReconnectTimer();
	activeViewerPresence.reconnectAttempt = 0;
	const socket = activeViewerPresence.socket;
	activeViewerPresence.socket = null;
	if (
		socket
		&& (
			socket.readyState === WebSocket.OPEN
			|| socket.readyState === WebSocket.CONNECTING
		)
	) {
		socket.close();
	}
}

const LEGACY_METRIC_RETRY_QUEUE_KEY = "dcote.metrics.pending.v1";
const METRIC_RETRY_QUEUE_PREFIX = "dcote.metrics.pending.v2.";
const METRIC_RETRY_QUEUE_LIMIT = 100;
const METRIC_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let metricRetryFlushPromise = null;

function getMetricRetryKey(path, eventId) {
	return (
		METRIC_RETRY_QUEUE_PREFIX
		+ encodeURIComponent(path)
		+ "."
		+ encodeURIComponent(eventId)
	);
}
function isValidMetricRetry(item, oldestAllowed) {
	return Boolean(
		item
			&& typeof item.path === "string"
			&& typeof item.payload?.eventId === "string"
			&& Number(item.queuedAt) >= oldestAllowed,
	);
}
function migrateLegacyMetricRetryQueue(oldestAllowed) {
	const legacyValue = localStorage.getItem(
		LEGACY_METRIC_RETRY_QUEUE_KEY,
	);
	if (!legacyValue) return;

	let legacyQueue;
	try {
		legacyQueue = JSON.parse(legacyValue);
	} catch {
		localStorage.removeItem(LEGACY_METRIC_RETRY_QUEUE_KEY);
		return;
	}
	if (Array.isArray(legacyQueue)) {
		for (const item of legacyQueue) {
			if (!isValidMetricRetry(item, oldestAllowed)) continue;
			const key = getMetricRetryKey(
				item.path,
				item.payload.eventId,
			);
			if (localStorage.getItem(key) === null) {
				localStorage.setItem(key, JSON.stringify(item));
			}
		}
	}
	localStorage.removeItem(LEGACY_METRIC_RETRY_QUEUE_KEY);
}
function readMetricRetryQueue() {
	try {
		const oldestAllowed =
			Date.now() - METRIC_RETRY_MAX_AGE_MS;
		migrateLegacyMetricRetryQueue(oldestAllowed);
		const keys = Array.from(
			{ length: localStorage.length },
			(_, index) => localStorage.key(index),
		).filter((key) => key?.startsWith(METRIC_RETRY_QUEUE_PREFIX));
		const queue = [];
		for (const key of keys) {
			let item;
			try {
				item = JSON.parse(localStorage.getItem(key) || "null");
			} catch {
				item = null;
			}
			if (!isValidMetricRetry(item, oldestAllowed)) {
				localStorage.removeItem(key);
				continue;
			}
			queue.push(item);
		}
		return queue.sort(
			(left, right) =>
				Number(left.queuedAt) - Number(right.queuedAt),
		);
	} catch {
		return [];
	}
}
function enqueueMetricRetry(path, payload) {
	if (typeof payload?.eventId !== "string") return false;
	try {
		const key = getMetricRetryKey(path, payload.eventId);
		if (localStorage.getItem(key) === null) {
			localStorage.setItem(
				key,
				JSON.stringify({ path, payload, queuedAt: Date.now() }),
			);
		}
		const queue = readMetricRetryQueue();
		const overflow =
			queue.length - METRIC_RETRY_QUEUE_LIMIT;
		if (overflow > 0) {
			for (const item of queue.slice(0, overflow)) {
				localStorage.removeItem(
					getMetricRetryKey(item.path, item.payload.eventId),
				);
			}
		}
		return true;
	} catch {
		return false;
	}
}
function acknowledgeMetricRetry(path, eventId) {
	if (typeof eventId !== "string") return;
	try {
		localStorage.removeItem(getMetricRetryKey(path, eventId));
	} catch {
		// Метрика уже доставлена; недоступный storage не меняет результат.
	}
}
async function postJsonMetric(path, payload) {
	const response = await fetch(`${metricsBaseUrl}/metrics/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		keepalive: true,
	});
	if (!response.ok) {
		throw new Error(`Metric request failed: ${response.status}`);
	}
	acknowledgeMetricRetry(path, payload.eventId);
}
function flushMetricRetryQueue() {
	if (
		metricRetryFlushPromise
		|| document.visibilityState === "hidden"
		|| navigator.onLine === false
	) {
		return metricRetryFlushPromise;
	}

	metricRetryFlushPromise = (async () => {
		for (const item of readMetricRetryQueue()) {
			try {
				await postJsonMetric(item.path, item.payload);
			} catch {
				// Событие остаётся в очереди до следующего подключения.
			}
		}
	})().finally(() => {
		metricRetryFlushPromise = null;
	});
	return metricRetryFlushPromise;
}
function sendJsonMetric(path, payload) {
	try {
		const data = JSON.stringify(payload);
		const url = `${metricsBaseUrl}/metrics/${path}`;
		const retryQueued = enqueueMetricRetry(path, payload);
		if (
			document.visibilityState === "hidden"
			&& typeof navigator.sendBeacon === "function"
		) {
			const blob = new Blob([data], {
				type: "text/plain;charset=UTF-8",
			});
			return navigator.sendBeacon(url, blob) || retryQueued;
		}

		postJsonMetric(path, payload).catch(() => {});
		return true;
	} catch {
		return false;
	}
}
listen(window, "online", () => {
	flushMetricRetryQueue();
	if (activeViewerPresence.shouldConnect) {
		connectActiveViewerPresence();
	}
});
flushMetricRetryQueue();
function createMetricEventId(metric) {
	const randomPart =
		typeof globalThis.crypto?.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random()
				.toString(36)
				.slice(2)}`;
	return `${metric}:${randomPart}`;
}

// Метрики просмотра специально считаются на клиенте: сервер получает только
// агрегируемые события после порога, без постоянного стрима прогресса.
const viewingTime = {
	activeStartedAt: null,
	eventId: createMetricEventId("viewing-time"),
	reported: false,
	watchedMilliseconds: 0,
};
const viewStartedMetric = {
	eventId: createMetricEventId("view-started"),
	sent: false,
	thresholdSeconds: VIEW_METRIC_THRESHOLD_SECONDS,
	timerId: null,
};
const viewLabelsMetric = {
	sentKey: null,
};
function canTrackPlayback() {
	return Boolean(
		metricVideo
		&& !metricVideo.paused
		&& !metricVideo.ended
		&& !metricVideo.seeking
		&& metricVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
		&& document.visibilityState === "visible",
	);
}
function initViewingTime() {
	if (!canTrackPlayback()) return;
	if (viewingTime.activeStartedAt === null) {
		viewingTime.activeStartedAt = performance.now();
	}
	setActiveViewerPresence(true);
	scheduleViewStartedMetricCheck();
}
function saveViewingTime() {
	if (viewingTime.activeStartedAt !== null) {
		viewingTime.watchedMilliseconds += Math.max(
			0,
			performance.now() - viewingTime.activeStartedAt,
		);
		viewingTime.activeStartedAt = null;
	}
	setActiveViewerPresence(false);
	updateViewStartedMetricState();
}
function getViewingTimeSeconds() {
	const activeMilliseconds = viewingTime.activeStartedAt !== null
		? Math.max(0, performance.now() - viewingTime.activeStartedAt)
		: 0;
	return Math.floor(
		(viewingTime.watchedMilliseconds + activeMilliseconds) / 1000,
	);
}
const metricDatas = {
	season: null,
	episode: null,
	voice: null,
};
let metricPlayer = null;
let metricVideo = null;

// от этих функций зависеть не должно.
function normalizeMetricLabel(value) {
	if (typeof value !== "string") return null;
	const label = value.trim().replace(/\s+/g, " ");
	return label ? label.slice(0, 80) : null;
}
function getSelectedVoice(player) {
	if (!player) return null;
	const audioTracks =
		typeof player.getAudioTracks === "function"
			? player.getAudioTracks()
			: [];
	const audioTrack = audioTracks.find((track) => track.active);
	const audioLabel = normalizeMetricLabel(audioTrack?.label);
	if (audioLabel) return audioLabel;

	const variantTracks =
		typeof player.getVariantTracks === "function"
			? player.getVariantTracks()
			: [];
	const variantTrack = variantTracks.find(
		(track) => track.active,
	);
	return normalizeMetricLabel(variantTrack?.label);
}
function updateSelectedVoice(player, allowUnknown = false) {
	const voice =
		getSelectedVoice(player) || (allowUnknown ? "Unknown" : null);
	if (!voice || metricDatas.voice === voice) return;
	metricDatas.voice = voice;
	sendViewLabelsMetric();
}
function initAudioMetricTracking(player) {
	const update = () => updateSelectedVoice(player, true);
	["trackschanged", "variantchanged", "audiotrackchanged"].forEach(
		(eventName) => {
			listen(player, eventName, update);
		},
	);
	update();
}
function sendViewLabelsMetric() {
	if (
		!metricDatas.season
		|| !metricDatas.episode
		|| !metricDatas.voice
	) {
		return;
	}
	const key = JSON.stringify(metricDatas);
	if (viewLabelsMetric.sentKey === key) return;

	if (sendJsonMetric("view-labels", metricDatas)) {
		viewLabelsMetric.sentKey = key;
	}
}
function clearViewStartedMetricTimer() {
	if (viewStartedMetric.timerId) {
		clearTimeout(viewStartedMetric.timerId);
		viewStartedMetric.timerId = null;
	}
}
function sendViewStartedMetric() {
	if (viewStartedMetric.sent) return;

	const seconds = getViewingTimeSeconds();
	if (seconds < viewStartedMetric.thresholdSeconds) return;

	clearViewStartedMetricTimer();
	updateSelectedVoice(metricPlayer, true);

	const queued = sendJsonMetric("view-started", {
		eventId: viewStartedMetric.eventId,
		seconds,
		...metricDatas,
	});
	if (queued) {
		viewStartedMetric.sent = true;
	} else if (viewingTime.activeStartedAt !== null) {
		viewStartedMetric.timerId = setTimeout(
			updateViewStartedMetricState,
			5000,
		);
	}
}
function scheduleViewStartedMetricCheck() {
	clearViewStartedMetricTimer();
	if (
		viewStartedMetric.sent
		|| viewingTime.activeStartedAt === null
	) {
		return;
	}

	const remainingMs = Math.max(
		0,
		(viewStartedMetric.thresholdSeconds -
			getViewingTimeSeconds()) *
			1000,
	);
	viewStartedMetric.timerId = setTimeout(() => {
		updateViewStartedMetricState();
	}, remainingMs + 100);
}
function updateViewStartedMetricState() {
	if (viewStartedMetric.sent) return;
	if (getViewingTimeSeconds() >= viewStartedMetric.thresholdSeconds) {
		sendViewStartedMetric();
		return;
	}
	scheduleViewStartedMetricCheck();
}
function areSubtitlesVisible(player, video) {
	if (getActiveTextTrack(player)) {
		return true;
	}

	if (
		player &&
		typeof player.isTextTrackVisible === "function" &&
		player.isTextTrackVisible()
	) {
		return true;
	}

	const textTracks = video?.textTracks
		? Array.from(video.textTracks)
		: [];
	return textTracks.some((track) => track.mode === "showing");
}
function getSubtitleMetricSeconds() {
	const activeSeconds = subtitleMetric.activeStartedAt !== null
		? (performance.now() - subtitleMetric.activeStartedAt) / 1000
		: 0;
	return subtitleMetric.activeSeconds + activeSeconds;
}
function clearSubtitleMetricTimer() {
	if (subtitleMetric.timerId) {
		clearTimeout(subtitleMetric.timerId);
		subtitleMetric.timerId = null;
	}
}
function sendSubtitleMetric() {
	if (subtitleMetric.sent) return;
	clearSubtitleMetricTimer();

	const queued = sendJsonMetric("subtitles", {
		eventId: subtitleMetric.eventId,
		seconds: Math.floor(getSubtitleMetricSeconds()),
		season: metricDatas.season,
		episode: metricDatas.episode,
	});
	if (queued) {
		subtitleMetric.sent = true;
	} else {
		subtitleMetric.timerId = setTimeout(
			updateSubtitleMetricState,
			5000,
		);
	}
}
function scheduleSubtitleMetricCheck() {
	clearSubtitleMetricTimer();
	if (
		subtitleMetric.sent
		|| subtitleMetric.activeStartedAt === null
	) {
		return;
	}

	const remainingMs = Math.max(
		0,
		(subtitleMetric.thresholdSeconds -
			getSubtitleMetricSeconds()) *
			1000,
	);
	subtitleMetric.timerId = setTimeout(() => {
		updateSubtitleMetricState();
	}, remainingMs + 100);
}
function updateSubtitleMetricState() {
	if (subtitleMetric.sent) return;

	const shouldTrack =
		viewingTime.activeStartedAt !== null
		&& metricVideo
		&& areSubtitlesVisible(metricPlayer, metricVideo);

	if (shouldTrack && subtitleMetric.activeStartedAt === null) {
		subtitleMetric.activeStartedAt = performance.now();
	}

	if (!shouldTrack && subtitleMetric.activeStartedAt !== null) {
		subtitleMetric.activeSeconds = getSubtitleMetricSeconds();
		subtitleMetric.activeStartedAt = null;
	}

	if (
		getSubtitleMetricSeconds() >=
		subtitleMetric.thresholdSeconds
	) {
		sendSubtitleMetric();
		return;
	}

	scheduleSubtitleMetricCheck();
}
function initSubtitleMetricTracking(player, video) {
	const update = () => updateSubtitleMetricState();
	["texttrackvisibility", "trackschanged"].forEach((eventName) => {
		listen(player, eventName, update);
	});
	[
		"playing",
		"pause",
		"waiting",
		"stalled",
		"seeking",
		"seeked",
		"ended",
	].forEach((eventName) => {
		listen(video, eventName, update);
	});
	if (video.textTracks?.addEventListener) {
		listen(video.textTracks, "change", update);
	}
	listen(document, "visibilitychange", update);
	update();
}
function initMetricDatas(src) {
	//src =
	//	"https://video.dcote.net/season-04/episode-01/master.m3u8";
	const match = src.match(
		/(?:^|\/)season-(\d+)\/episode-(\d+)(?:\/|$)/,
	);
	if (!match) return;
	const season = match[1];
	const episode = match[2];
	metricDatas.season = season;
	metricDatas.episode = episode;
	metricDatas.voice = null;
	viewStartedMetric.sent = false;
	viewStartedMetric.eventId = createMetricEventId("view-started");
	clearViewStartedMetricTimer();
	viewLabelsMetric.sentKey = null;
	viewingTime.watchedMilliseconds = 0;
	viewingTime.activeStartedAt = null;
	viewingTime.eventId = createMetricEventId("viewing-time");
	viewingTime.reported = false;
	subtitleMetric.activeSeconds = 0;
	subtitleMetric.activeStartedAt = null;
	subtitleMetric.eventId = createMetricEventId("subtitles");
	subtitleMetric.sent = false;
	clearSubtitleMetricTimer();
}
function flushViewingTimeMetric() {
	saveViewingTime();
	updateSubtitleMetricState();
	updateSelectedVoice(metricPlayer, true);
	sendViewStartedMetric();

	const seconds = getViewingTimeSeconds();
	if (
		viewingTime.reported
		|| seconds < VIEW_METRIC_THRESHOLD_SECONDS
	) {
		return;
	}

	const queued = sendJsonMetric("viewing-time", {
		eventId: viewingTime.eventId,
		seconds,
		...metricDatas,
	});
	if (queued) viewingTime.reported = true;
}
listen(document, "visibilitychange", function () {
	if (document.visibilityState === "hidden") {
		saveViewingTime();
		updateSubtitleMetricState();
		return;
	}

	flushMetricRetryQueue();
	initViewingTime();
	updateSubtitleMetricState();
});
listen(window, "pagehide", (event) => {
	saveViewingTime();
	updateSubtitleMetricState();
	if (event.persisted) return;
	flushViewingTimeMetric();
	destroyPlayerSession();
});
listen(window, "pageshow", (event) => {
	if (!event.persisted) return;
	flushMetricRetryQueue();
	initViewingTime();
	updateSubtitleMetricState();
	if (metricPlayer) syncAssSubtitleVisibility(metricPlayer);
});

function destroyPlayerSession() {
	if (playerLifecycle.destroyed) return;
	playerLifecycle.destroyed = true;

	for (const cleanup of playerLifecycle.cleanupTasks.splice(0).reverse()) {
		cleanup();
	}
	setActiveViewerPresence(false);
	clearViewStartedMetricTimer();
	clearSubtitleMetricTimer();

	const zoomState = playerLifecycle.zoomState;
	if (zoomState) {
		clearTimeout(zoomState.feedbackTimer);
		clearTimeout(zoomState.longPressTimer);
		clearTimeout(zoomState.controlsAnimationTimer);
	}

	const assRendererCleanup = destroyAssRenderer("destroyed");
	const ui = playerLifecycle.ui;
	const player = playerLifecycle.player;
	playerLifecycle.ui = null;
	playerLifecycle.player = null;
	playerLifecycle.zoomState = null;
	metricPlayer = null;
	metricVideo = null;

	void (async () => {
		await assRendererCleanup;
		try {
			await ui?.destroy?.();
		} catch {
			// Shaka Player всё равно должен быть освобождён.
		}
		try {
			await player?.destroy?.();
		} catch {
			// Страница уже выгружается; повторная обработка не требуется.
		}
	})();
}

function onError(error) {
	console.error(
		"Shaka Error:",
		error?.code ?? "unknown",
		error?.message || error,
	);
}
async function init() {
	shaka.polyfill.installAll();
	if (!shaka.Player.isBrowserSupported()) {
		alert("Браузер не поддерживается");
		return;
	}

	const video = document.getElementById("video");
	const container = document.getElementById("player-container");
	const posterCover = document.getElementById("poster-cover");
	const zoomFeedback = document.getElementById(
		"video-zoom-feedback",
	);
	const mobileContextMenu = document.getElementById(
		"mobile-context-menu",
	);
	const mobileContextLoop = document.getElementById(
		"mobile-context-loop",
	);
	const mobileContextPip = document.getElementById(
		"mobile-context-pip",
	);
	const mobileContextSaveFrame = document.getElementById(
		"mobile-context-save-frame",
	);
	const skipBtn = document.getElementById("skip-btn");
	const player = new shaka.Player(null, container);
	playerLifecycle.player = player;
	metricPlayer = player;
	metricVideo = video;
	if (typeof player.setVideoContainer === "function") {
		player.setVideoContainer(container);
	}
	await player.attach(video);
	if (playerLifecycle.destroyed) return;

	const usesMobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
	configurePresentationTextDisplayerLifecycle(player, video);
	player.configure({
		// Ограничение применяется только к ABR; ручной список Shaka сохраняет
		// все доступные качества, включая варианты выше этого потолка.
		abr: {
			defaultBandwidthEstimate: INITIAL_ABR_BANDWIDTH_ESTIMATE,
			restrictions: {
				maxHeight: usesMobileLayout
					? MOBILE_ABR_MAX_HEIGHT
					: DESKTOP_ABR_MAX_HEIGHT,
			},
			useNetworkInformation: false,
		},
	});

	listen(video, "playing", initViewingTime);
	["pause", "waiting", "stalled", "seeking"].forEach(
		(eventName) => listen(video, eventName, saveViewingTime),
	);
	listen(video, "seeked", initViewingTime);
	listen(video, "ended", () => {
		saveViewingTime();
		flushViewingTimeMetric();
	});
	listen(player, "error", (e) => onError(e.detail));

	const ui = new shaka.ui.Overlay(player, container, video);
	playerLifecycle.ui = ui;
	const controls = ui.getControls();

	const params = playerParams;
	const src = params.get("src");
	const assUrl = params.get("ass");
	const assLanguage = (params.get("ass_lang") || "ru")
		.split("-")[0]
		.toLowerCase();
	const assForcedParam = params.get("ass_forced");
	const assForced = assForcedParam === null
		? null
		: assForcedParam === "1" || assForcedParam === "true";
	const assBottomMarginPercent = getNumberParam(
		"ass_bottom_margin_percent",
		0,
		0,
		40,
	);
	const poster = params.get("poster");
	const skipStart = getNumberParam("skip_start", -1, -1);
	const skipEnd = getNumberParam("skip_end", -1, -1);

	const showPoster = () => {
		if (!poster) return;
		video.poster = poster;
		posterCover.style.backgroundImage = `url(${JSON.stringify(
			poster,
		)})`;
		posterCover.classList.add("visible");
	};
	const hidePoster = () => {
		posterCover.classList.remove("visible");
	};

	showPoster();
	listen(video, "play", hidePoster);
	listen(video, "playing", hidePoster);

	const trackLabelFormat =
		shaka.ui.Overlay.TrackLabelFormat.LABEL;

	ui.configure({
		enableKeyboardPlaybackControls: false,
		addSeekBar: true,
		controlPanelElements: [
			"play_pause",
			"mute",
			"volume",
			"time_and_duration",
			"spacer",
			"overflow_menu",
			"picture_in_picture",
			"fullscreen",
		],
		overflowMenuButtons: [
			"quality",
			"language",
			"playback_rate",
			"captions",
			"loop",
		],
		// LABEL maps to HLS #EXT-X-MEDIA NAME and keeps
		// same-language audio tracks split in the menu.
		trackLabelFormat,
		seekBarColors: { played: "rgb(224, 11, 82)" },
	});

	// Zoom не должен вмешиваться в обычный desktop-режим: колесо работает
	// только в fullscreen, а touch-устройства получают pinch/pan жесты всегда.
	const zoomState = {
		scale: 1,
		coverScale: 1,
		mode: "fit",
		feedbackTimer: null,
		pinchStartDistance: null,
		pinchStartScale: 1,
		pinchStartCenter: null,
		pinchStartPanX: 0,
		pinchStartPanY: 0,
		panX: 0,
		panY: 0,
		panStartPoint: null,
		panStartX: 0,
		panStartY: 0,
		tapStartPoint: null,
		tapStartTime: 0,
		tapMoved: false,
		tapStartedOnControls: false,
		touchGestureCaptured: false,
		longPressTimer: null,
		longPressTriggered: false,
		controlsAnimationTimer: null,
	};
	playerLifecycle.zoomState = zoomState;
	const getFullscreenElement = () =>
		document.fullscreenElement ||
		document.webkitFullscreenElement ||
		null;
	const isTouchZoomDevice =
		window.matchMedia("(pointer: coarse)").matches ||
		navigator.maxTouchPoints > 0;
	const isPlayerFullscreen = () => {
		const fullscreenElement = getFullscreenElement();
		return (
			fullscreenElement === container ||
			container.contains(fullscreenElement)
		);
	};
	const isZoomAllowed = () =>
		isPlayerFullscreen() || isTouchZoomDevice;
	container.classList.toggle(
		"video-zoom-touch-active",
		isTouchZoomDevice,
	);
	const calculateCoverScale = () => {
		if (
			!video.videoWidth ||
			!video.videoHeight ||
			!container.clientWidth ||
			!container.clientHeight
		) {
			return 1;
		}
		const videoRatio = video.videoWidth / video.videoHeight;
		const containerRatio =
			container.clientWidth / container.clientHeight;
		return Math.max(
			containerRatio / videoRatio,
			videoRatio / containerRatio,
		);
	};
	const getTouchCenter = (touches) => ({
		x: (touches[0].clientX + touches[1].clientX) / 2,
		y: (touches[0].clientY + touches[1].clientY) / 2,
	});
	const getContainerCenterOffset = (point) => {
		const bounds = container.getBoundingClientRect();
		return {
			x: point.x - bounds.left - bounds.width / 2,
			y: point.y - bounds.top - bounds.height / 2,
		};
	};
	const getPanLimits = (scale = zoomState.scale) => {
		if (
			!video.videoWidth ||
			!video.videoHeight ||
			!container.clientWidth ||
			!container.clientHeight
		) {
			return { x: 0, y: 0 };
		}
		const videoRatio = video.videoWidth / video.videoHeight;
		const containerRatio =
			container.clientWidth / container.clientHeight;
		const renderedWidth =
			containerRatio > videoRatio
				? container.clientHeight * videoRatio
				: container.clientWidth;
		const renderedHeight =
			containerRatio > videoRatio
				? container.clientHeight
				: container.clientWidth / videoRatio;
		return {
			x: Math.max(
				0,
				(renderedWidth * scale - container.clientWidth) / 2,
			),
			y: Math.max(
				0,
				(renderedHeight * scale - container.clientHeight) / 2,
			),
		};
	};
	const syncVideoZoomClass = () => {
		const isZoomed =
			zoomState.scale > 1.01 ||
			Math.abs(zoomState.panX) > 0.01 ||
			Math.abs(zoomState.panY) > 0.01;
		container.classList.toggle("video-zoom-active", isZoomed);
	};
	const setVideoPan = (nextX, nextY, scale = zoomState.scale) => {
		const limits = getPanLimits(scale);
		zoomState.panX = Math.min(
			limits.x,
			Math.max(-limits.x, nextX),
		);
		zoomState.panY = Math.min(
			limits.y,
			Math.max(-limits.y, nextY),
		);
		container.style.setProperty(
			"--video-pan-x",
			`${zoomState.panX.toFixed(2)}px`,
		);
		container.style.setProperty(
			"--video-pan-y",
			`${zoomState.panY.toFixed(2)}px`,
		);
		syncVideoZoomClass();
	};
	const getZoomLabel = () => {
		if (zoomState.scale <= 1.01) {
			return "\u041f\u043e \u0440\u0430\u0437\u043c\u0435\u0440\u0443";
		}
		if (
			Math.abs(zoomState.scale - zoomState.coverScale) < 0.015
		) {
			return `\u0417\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 \u00b7 ${zoomState.scale.toFixed(2)}\u00d7`;
		}
		return `\u041c\u0430\u0441\u0448\u0442\u0430\u0431 \u00b7 ${zoomState.scale.toFixed(2)}\u00d7`;
	};
	const showPlayerFeedback = (message) => {
		zoomFeedback.textContent = message;
		zoomFeedback.classList.add("visible");
		clearTimeout(zoomState.feedbackTimer);
		zoomState.feedbackTimer = setTimeout(() => {
			zoomFeedback.classList.remove("visible");
		}, 900);
	};
	const showZoomFeedback = () =>
		showPlayerFeedback(getZoomLabel());
	const normalizeVideoScale = (nextScale) => {
		zoomState.coverScale = calculateCoverScale();
		const maxScale = Math.max(3, zoomState.coverScale * 2);
		let scale = Math.min(maxScale, Math.max(1, nextScale));
		if (Math.abs(scale - 1) < 0.04) scale = 1;
		if (Math.abs(scale - zoomState.coverScale) < 0.06) {
			scale = zoomState.coverScale;
		}
		return scale;
	};
	const setVideoZoom = (
		nextScale,
		showFeedback = true,
		force = false,
		nextPan = null,
	) => {
		if (!force && !isZoomAllowed()) return;
		const scale = normalizeVideoScale(nextScale);
		zoomState.scale = scale;
		zoomState.mode =
			scale <= 1.01
				? "fit"
				: Math.abs(scale - zoomState.coverScale) < 0.015
					? "cover"
					: "manual";
		container.style.setProperty(
			"--video-zoom",
			scale.toFixed(4),
		);
		if (scale <= 1.01) {
			setVideoPan(0, 0, scale);
		} else if (nextPan) {
			setVideoPan(nextPan.x, nextPan.y, scale);
		} else {
			setVideoPan(zoomState.panX, zoomState.panY, scale);
		}
		if (showFeedback) showZoomFeedback();
	};
	const adjustVideoZoom = (direction) => {
		if (!isZoomAllowed()) return;
		zoomState.coverScale = calculateCoverScale();
		if (direction > 0 && zoomState.scale <= 1.01) {
			setVideoZoom(
				zoomState.coverScale > 1.01
					? zoomState.coverScale
					: 1.1,
			);
			return;
		}
		if (
			direction < 0 &&
			zoomState.scale > zoomState.coverScale &&
			zoomState.scale - 0.1 <= zoomState.coverScale + 0.06
		) {
			setVideoZoom(zoomState.coverScale);
			return;
		}
		if (
			direction < 0 &&
			Math.abs(zoomState.scale - zoomState.coverScale) < 0.015
		) {
			setVideoZoom(1);
			return;
		}
		setVideoZoom(zoomState.scale + direction * 0.1);
	};
	const syncFullscreenZoom = () => {
		const fullscreen = isPlayerFullscreen();
		closeMobileContextMenu();
		zoomState.coverScale = calculateCoverScale();
		if (!fullscreen && !isTouchZoomDevice) {
			setVideoZoom(1, false, true);
			zoomFeedback.classList.remove("visible");
		}
	};
	const syncZoomAfterResize = () => {
		if (!isZoomAllowed()) return;
		const wasCover = zoomState.mode === "cover";
		zoomState.coverScale = calculateCoverScale();
		if (wasCover) {
			setVideoZoom(zoomState.coverScale, false);
		} else {
			setVideoPan(zoomState.panX, zoomState.panY);
		}
	};
	listen(document, "fullscreenchange", syncFullscreenZoom);
	listen(
		document,
		"webkitfullscreenchange",
		syncFullscreenZoom,
	);
	listen(window, "resize", syncZoomAfterResize);
	listen(video, "loadedmetadata", syncZoomAfterResize);
	listen(
		container,
		"wheel",
		(event) => {
			if (!isPlayerFullscreen()) return;
			event.preventDefault();
			adjustVideoZoom(event.deltaY < 0 ? 1 : -1);
		},
		{ passive: false },
	);
	const getTouchDistance = (touches) =>
		Math.hypot(
			touches[0].clientX - touches[1].clientX,
			touches[0].clientY - touches[1].clientY,
		);
	const isTouchOnControls = (target) =>
		target instanceof Element &&
		Boolean(
			target.closest(
				"button, input, select, #mobile-context-menu, .shaka-controls-button-panel, .shaka-seek-bar-container, .shaka-overflow-menu, .shaka-settings-menu",
			),
		);
	const toggleTouchControls = () => {
		const uiIsForcedHidden = container.classList.contains(
			"touch-controls-hidden",
		);
		const uiIsVisible =
			!uiIsForcedHidden &&
			(typeof controls.isOpaque === "function"
				? controls.isOpaque()
				: container
						.querySelector(".shaka-controls-container")
						?.getAttribute("shown") === "true");
		if (uiIsVisible) {
			clearTimeout(zoomState.controlsAnimationTimer);
			container.classList.add("touch-controls-hidden");
			zoomState.controlsAnimationTimer = setTimeout(() => {
				controls.hideUI?.();
			}, 200);
		} else {
			clearTimeout(zoomState.controlsAnimationTimer);
			controls.showUI?.();
			requestAnimationFrame(() => {
				container.classList.remove(
					"touch-controls-hidden",
				);
			});
		}
	};
	const clearLongPress = () => {
		clearTimeout(zoomState.longPressTimer);
		zoomState.longPressTimer = null;
	};
	const closeMobileContextMenu = () => {
		mobileContextMenu.classList.remove("visible");
	};
	const updateMobileContextMenu = () => {
		mobileContextLoop.classList.toggle("active", video.loop);
		mobileContextLoop.textContent = video.loop
			? "\u2713 \u041f\u043e\u0432\u0442\u043e\u0440"
			: "\u041f\u043e\u0432\u0442\u043e\u0440";
		mobileContextPip.disabled = !(
			document.pictureInPictureEnabled &&
			typeof video.requestPictureInPicture === "function"
		);
	};
	const openMobileContextMenu = (point) => {
		updateMobileContextMenu();
		mobileContextMenu.classList.add("visible");
		const bounds = container.getBoundingClientRect();
		requestAnimationFrame(() => {
			const margin = 12;
			const maximumLeft = Math.max(
				margin,
				bounds.width -
					mobileContextMenu.offsetWidth -
					margin,
			);
			const maximumTop = Math.max(
				margin,
				bounds.height -
					mobileContextMenu.offsetHeight -
					margin,
			);
			const left = Math.min(
				maximumLeft,
				Math.max(
					margin,
					point.x - bounds.left,
				),
			);
			const top = Math.min(
				maximumTop,
				Math.max(
					margin,
					point.y - bounds.top,
				),
			);
			mobileContextMenu.style.left = `${left}px`;
			mobileContextMenu.style.top = `${top}px`;
		});
	};
	const saveCurrentVideoFrame = () => {
		if (!video.videoWidth || !video.videoHeight) {
			showPlayerFeedback(
				"\u041a\u0430\u0434\u0440 \u0435\u0449\u0435 \u043d\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d",
			);
			return;
		}
		try {
			const canvas = document.createElement("canvas");
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			canvas
				.getContext("2d")
				.drawImage(video, 0, 0, canvas.width, canvas.height);
			canvas.toBlob((blob) => {
				if (!blob) {
					showPlayerFeedback(
						"\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u043a\u0430\u0434\u0440",
					);
					return;
				}
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = `dcote-frame-${Math.floor(
					video.currentTime * 1000,
				)}.png`;
				document.body.appendChild(link);
				link.click();
				link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				showPlayerFeedback(
					"\u041a\u0430\u0434\u0440 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d",
				);
			}, "image/png");
		} catch (error) {
			console.error("Unable to save video frame:", error);
			showPlayerFeedback(
				"\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u043a\u0430\u0434\u0440",
			);
		}
	};
	listen(mobileContextLoop, "click", (event) => {
		event.stopPropagation();
		video.loop = !video.loop;
		closeMobileContextMenu();
		showPlayerFeedback(
			video.loop
				? "\u041f\u043e\u0432\u0442\u043e\u0440 \u0432\u043a\u043b\u044e\u0447\u0435\u043d"
				: "\u041f\u043e\u0432\u0442\u043e\u0440 \u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d",
		);
	});
	listen(mobileContextPip, "click", async (event) => {
		event.stopPropagation();
		closeMobileContextMenu();
		try {
			if (document.pictureInPictureElement) {
				await document.exitPictureInPicture();
			} else {
				await video.requestPictureInPicture();
			}
		} catch (error) {
			console.error("Unable to toggle picture-in-picture:", error);
			showPlayerFeedback(
				"\u041a\u0430\u0440\u0442\u0438\u043d\u043a\u0430 \u0432 \u043a\u0430\u0440\u0442\u0438\u043d\u043a\u0435 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430",
			);
		}
	});
	listen(mobileContextSaveFrame, "click", (event) => {
		event.stopPropagation();
		closeMobileContextMenu();
		saveCurrentVideoFrame();
	});
	listen(container, "contextmenu", (event) => {
		if (isTouchZoomDevice) event.preventDefault();
	});
	listen(
		container,
		"touchstart",
		(event) => {
			if (!isZoomAllowed()) {
				return;
			}
			clearLongPress();
			zoomState.longPressTriggered = false;
			const closedContextMenu =
				mobileContextMenu.classList.contains("visible") &&
				!(
					event.target instanceof Element &&
					event.target.closest("#mobile-context-menu")
				);
			if (closedContextMenu) {
				closeMobileContextMenu();
			}
			const touchStartedOnControls = isTouchOnControls(
				event.target,
			);
			const shouldCaptureTouch =
				event.touches.length > 1 ||
				!touchStartedOnControls;
			if (shouldCaptureTouch) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				zoomState.touchGestureCaptured = true;
			}
			if (event.touches.length === 1) {
				zoomState.tapStartPoint = {
					x: event.touches[0].clientX,
					y: event.touches[0].clientY,
				};
				zoomState.tapStartTime = performance.now();
				zoomState.tapMoved = false;
				zoomState.tapStartedOnControls =
					touchStartedOnControls || closedContextMenu;
				if (
					!touchStartedOnControls &&
					!closedContextMenu
				) {
					const longPressPoint = {
						x: event.touches[0].clientX,
						y: event.touches[0].clientY,
					};
					zoomState.longPressTimer = setTimeout(() => {
						if (
							zoomState.tapStartPoint &&
							!zoomState.tapMoved &&
							!zoomState.pinchStartDistance
						) {
							zoomState.longPressTriggered = true;
							zoomState.tapMoved = true;
							navigator.vibrate?.(20);
							openMobileContextMenu(longPressPoint);
						}
					}, 600);
				}
			} else {
				zoomState.tapStartPoint = null;
				clearLongPress();
			}
			if (
				event.touches.length === 1 &&
				zoomState.scale > 1.01 &&
				!isTouchOnControls(event.target)
			) {
				event.preventDefault();
				container.classList.add("video-zoom-gesturing");
				zoomState.panStartPoint = {
					x: event.touches[0].clientX,
					y: event.touches[0].clientY,
				};
				zoomState.panStartX = zoomState.panX;
				zoomState.panStartY = zoomState.panY;
				return;
			}
			if (event.touches.length !== 2) return;
			event.preventDefault();
			container.classList.add("video-zoom-gesturing");
			zoomState.panStartPoint = null;
			zoomState.pinchStartDistance = getTouchDistance(
				event.touches,
			);
			zoomState.pinchStartScale = zoomState.scale;
			zoomState.pinchStartCenter = getContainerCenterOffset(
				getTouchCenter(event.touches),
			);
			zoomState.pinchStartPanX = zoomState.panX;
			zoomState.pinchStartPanY = zoomState.panY;
		},
		{ passive: false, capture: true },
	);
	listen(
		container,
		"touchmove",
		(event) => {
			if (
				zoomState.tapStartPoint &&
				event.touches.length > 0
			) {
				const tapDistance = Math.hypot(
					event.touches[0].clientX -
						zoomState.tapStartPoint.x,
					event.touches[0].clientY -
						zoomState.tapStartPoint.y,
				);
				if (tapDistance > 8) {
					zoomState.tapMoved = true;
					clearLongPress();
				}
			}
			if (
				zoomState.panStartPoint &&
				event.touches.length === 1
			) {
				event.preventDefault();
				const distance = Math.hypot(
					event.touches[0].clientX -
						zoomState.panStartPoint.x,
					event.touches[0].clientY -
						zoomState.panStartPoint.y,
				);
				if (distance > 8) zoomState.tapMoved = true;
				setVideoPan(
					zoomState.panStartX +
						event.touches[0].clientX -
						zoomState.panStartPoint.x,
					zoomState.panStartY +
						event.touches[0].clientY -
						zoomState.panStartPoint.y,
				);
				return;
			}
			if (
				!zoomState.pinchStartDistance ||
				event.touches.length !== 2
			) {
				return;
			}
			event.preventDefault();
			zoomState.tapMoved = true;
			clearLongPress();
			const distance = getTouchDistance(event.touches);
			const nextScale = normalizeVideoScale(
				zoomState.pinchStartScale *
					(distance / zoomState.pinchStartDistance),
			);
			const scaleRatio =
				nextScale / zoomState.pinchStartScale;
			const currentCenter = getContainerCenterOffset(
				getTouchCenter(event.touches),
			);
			setVideoZoom(
				nextScale,
				false,
				false,
				{
					x:
						currentCenter.x -
						(zoomState.pinchStartCenter.x -
							zoomState.pinchStartPanX) *
							scaleRatio,
					y:
						currentCenter.y -
						(zoomState.pinchStartCenter.y -
							zoomState.pinchStartPanY) *
							scaleRatio,
				},
			);
		},
		{ passive: false, capture: true },
	);
	const finishTouchZoom = (event) => {
		clearLongPress();
		if (
			event.touches.length === 1 &&
			zoomState.pinchStartDistance
		) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			zoomState.pinchStartDistance = null;
			zoomState.pinchStartCenter = null;
			zoomState.panStartPoint = {
				x: event.touches[0].clientX,
				y: event.touches[0].clientY,
			};
			zoomState.panStartX = zoomState.panX;
			zoomState.panStartY = zoomState.panY;
			setVideoZoom(zoomState.scale);
			return;
		}
		if (event.touches.length > 0) return;
		const wasPinching = Boolean(zoomState.pinchStartDistance);
		const wasTap =
			event.type === "touchend" &&
			zoomState.tapStartPoint &&
			!zoomState.tapMoved &&
			!zoomState.longPressTriggered &&
			!zoomState.tapStartedOnControls &&
			performance.now() - zoomState.tapStartTime < 350;
		zoomState.pinchStartDistance = null;
		zoomState.pinchStartCenter = null;
		zoomState.panStartPoint = null;
		zoomState.tapStartPoint = null;
		zoomState.longPressTriggered = false;
		container.classList.remove("video-zoom-gesturing");
		if (wasPinching) setVideoZoom(zoomState.scale);
		if (zoomState.touchGestureCaptured) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			zoomState.touchGestureCaptured = false;
		}
		if (wasTap) {
			toggleTouchControls();
		}
	};
	listen(container, "touchend", finishTouchZoom, true);
	listen(container, "touchcancel", finishTouchZoom, true);

	const localization = controls.getLocalization();
	const RU = "ru";
	// Локализацию Shaka держим рядом с настройкой UI, чтобы новые кнопки
	// не оставались на английском по умолчанию.
	localization.insert(
		RU,
		new Map([
			["PLAY", "Воспроизвести"],
			["PAUSE", "Пауза"],
			["REPLAY", "Повторить"],
			["MUTE", "Выключить звук"],
			["UNMUTE", "Включить звук"],
			["FULL_SCREEN", "Полный экран"],
			["EXIT_FULL_SCREEN", "Выйти"],
			["ENTER_PICTURE_IN_PICTURE", "Картинка в картинке"],
			["MORE_SETTINGS", "Настройки"],
			["CAPTIONS", "Субтитры"],
			["LOOP", "Повтор"],
			["PLAYBACK_RATE", "Скорость"],
			["QUALITY", "Качество"],
			["AUTO_QUALITY", "Авто"],
			["RESOLUTION", "Разрешение"],
			["OFF", "Выкл"],
			["LANGUAGE", "Озвучка"],
		]),
	);
	localization.changeLocale([RU]);

	// Горячие клавиши не должны перехватываться, когда пользователь вводит текст
	// в системных меню Shaka или сторонних элементах страницы.
	listen(window, "keydown", (e) => {
		const activeElement = document.activeElement;
		if (
			e.defaultPrevented
			|| e.altKey
			|| e.ctrlKey
			|| e.metaKey
			|| (
				activeElement instanceof HTMLElement
				&& activeElement.matches(
					"input, select, textarea, button, a, "
					+ "[contenteditable], [role='button'], [role='menuitem'], "
					+ "[role='slider']",
				)
			)
		)
			return;
		switch (e.code) {
			case "Space":
			case "KeyK":
				e.preventDefault();
				video.paused ? video.play() : video.pause();
				break;
			case "ArrowRight":
				video.currentTime += 5;
				break;
			case "ArrowLeft":
				video.currentTime -= 5;
				break;
			case "ArrowUp":
				e.preventDefault();
				video.volume = Math.min(1, video.volume + 0.1);
				break;
			case "ArrowDown":
				e.preventDefault();
				video.volume = Math.max(0, video.volume - 0.1);
				break;
			case "KeyM":
				video.muted = !video.muted;
				break;
			case "Equal":
			case "NumpadAdd":
				if (isPlayerFullscreen()) {
					e.preventDefault();
					adjustVideoZoom(1);
				}
				break;
			case "Minus":
			case "NumpadSubtract":
				if (isPlayerFullscreen()) {
					e.preventDefault();
					adjustVideoZoom(-1);
				}
				break;
			case "Digit0":
			case "Numpad0":
				if (isPlayerFullscreen()) {
					e.preventDefault();
					setVideoZoom(1);
				}
				break;
			case "KeyF":
				controls.toggleFullScreen();
				break;
		}
	});

	const shakaButtons = container.querySelectorAll(
		"button, .shaka-range-element",
	);
	shakaButtons.forEach((btn) => {
		listen(btn, "click", () => {
			btn.blur();
		});
	});

	const skipAction = document.getElementById("skip-btn-action");
	const skipDismiss = document.getElementById("skip-btn-dismiss");
	const skipTarget =
		skipEnd > skipStart && skipEnd >= 0
			? skipEnd
			: skipStart + 85;

	let skipDismissed = false;

	listen(video, "timeupdate", () => {
		const isInsideRange =
			video.currentTime > skipStart &&
			video.currentTime < skipTarget &&
			skipStart >= 0;
		const overflowMenu = document.querySelector(
			".shaka-overflow-menu",
		);
		const isMenuOpen =
			overflowMenu &&
			!overflowMenu.classList.contains("shaka-hidden");
		if (isInsideRange && !skipDismissed && !isMenuOpen) {
			skipBtn.classList.add("visible");
		} else {
			skipBtn.classList.remove("visible");
		}
	});

	listen(
		skipAction,
		"click",
		() => {
			video.currentTime = skipTarget;
			skipBtn.classList.remove("visible");
			if (controls && typeof controls.hideUI === "function") {
				controls.hideUI();
			}
		},
	);

	listen(
		skipDismiss,
		"click",
		() => {
			skipDismissed = true;
			skipBtn.classList.remove("visible");
			if (controls && typeof controls.hideUI === "function") {
				controls.hideUI();
			}
		},
	);

	const overflowBtn = document.querySelector(
		".shaka-overflow-menu-button",
	);
	if (overflowBtn) {
		listen(overflowBtn, "click", () => {
			skipBtn.classList.remove("visible");
		});
	}

	if (src) {
		if (assUrl) {
			configureAssSubtitles(player, video, {
				bottomMarginPercent: assBottomMarginPercent,
				forced: assForced,
				label: params.get("ass_label") || "",
				language: assLanguage,
				trackId: params.get("ass_track_id") || "",
				url: assUrl,
			});
		}
		try {
			await player.load(src);
			if (playerLifecycle.destroyed) return;
			if (assUrl) syncAssSubtitleVisibility(player);
			initMetricDatas(src);
			initAudioMetricTracking(player);
			initSubtitleMetricTracking(player, video);
		} catch (e) {
			onError(e);
		}
	}
}
listen(document, "DOMContentLoaded", () => {
	init().catch((error) => {
		if (playerLifecycle.destroyed) return;
		onError(error);
		destroyPlayerSession();
	});
});
