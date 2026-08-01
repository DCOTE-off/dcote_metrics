import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const playerPath = new URL("../public/player.js", import.meta.url);
const playerSubtitlesPath = new URL(
	"../public/player-subtitles.js",
	import.meta.url,
);
const playerMarkupPath = new URL("../public/player.html", import.meta.url);
const playerStylePath = new URL("../public/player.css", import.meta.url);
const trackerPath = new URL(
	"../public/site-presence-tracker.js",
	import.meta.url,
);
const videoDashboardPath = new URL(
	"../grafana/provisioning/dashboards/dcote_video_player.json",
	import.meta.url,
);
const websiteDashboardPath = new URL(
	"../grafana/provisioning/dashboards/dcote_website_activity.json",
	import.meta.url,
);
const nodeDashboardPath = new URL(
	"../grafana/provisioning/dashboards/1860_rev45.json",
	import.meta.url,
);

async function readPlayerSources() {
	return (
		await Promise.all(
			[playerPath, playerSubtitlesPath].map((path) =>
				readFile(path, "utf8")
			),
		)
	).join("\n");
}

test("player measures active playback and reports one completed duration", async () => {
	const player = await readPlayerSources();

	assert.match(player, /listen\(video, "playing", initViewingTime\)/);
	assert.match(player, /\["pause", "waiting", "stalled", "seeking"\]/);
	assert.match(player, /performance\.now\(\) - viewingTime\.activeStartedAt/);
	assert.match(player, /viewingTime\.reported/);
	assert.match(player, /eventId: viewingTime\.eventId/);
	assert.match(player, /eventId: viewStartedMetric\.eventId/);
	assert.match(player, /eventId: subtitleMetric\.eventId/);
	assert.match(player, /METRIC_RETRY_QUEUE_PREFIX/);
	assert.match(player, /getMetricRetryKey\(path, payload\.eventId\)/);
	assert.match(player, /enqueueMetricRetry\(path, payload\)/);
	assert.match(player, /acknowledgeMetricRetry\(path, payload\.eventId\)/);
	assert.match(player, /listen\(window, "online", \(\) =>/);
	assert.match(player, /flushMetricRetryQueue\(\)/);
	assert.match(player, /navigator\.sendBeacon\(url, blob\) \|\| retryQueued/);
	assert.match(player, /type: "text\/plain;charset=UTF-8"/);
	assert.doesNotMatch(player, /if \(queued\) viewingTime\.watchedSeconds = 0/);
	assert.match(
		player,
		/if \(event\.persisted\) return;\s*flushViewingTimeMetric\(\);\s*destroyPlayerSession\(\)/,
	);
});

test("player online presence follows playback and reconnects", async () => {
	const player = await readPlayerSources();

	assert.match(player, /setActiveViewerPresence\(true\)/);
	assert.match(player, /setActiveViewerPresence\(false\)/);
	assert.match(player, /scheduleActiveViewerReconnect\(\)/);
	assert.doesNotMatch(
		player,
		/const activeViewersSocket = new WebSocket\(websocketUrl\)/,
	);
});

test("player keeps subtitles and telemetry alive across BFCache restores", async () => {
	const player = await readPlayerSources();

	assert.match(player, /listen\(window, "pageshow", \(event\) =>/);
	assert.match(player, /if \(!event\.persisted\) return/);
	assert.match(player, /if \(event\.persisted\) return/);
	assert.match(player, /syncAssSubtitleVisibility\(metricPlayer\)/);
	assert.doesNotMatch(player, /renderer\?\._canvas|renderer\._canvas/);
	assert.match(player, /canvas = document\.createElement\("canvas"\)/);
	assert.match(player, /new JASSUB\(\{\s*canvas,/);
	assert.doesNotMatch(player, /new JASSUB\(\{\s*video,/);
});

test("ASS is lazy, always uses VAG and stops rendering while hidden", async () => {
	const player = await readPlayerSources();

	assert.match(player, /async function ensureAssSubtitlesReady\(\)/);
	assert.match(
		player,
		/selected\s*&&\s*canRender\s*&&\s*assSubtitles\.status === "idle"/,
	);
	assert.match(player, /renderer\.manualRender\(metadata\)/);
	assert.match(player, /cancelVideoFrameCallback\(frameCallbackId\)/);
	assert.match(
		player,
		/typeof video\.requestVideoFrameCallback === "function"/,
	);
	assert.match(player, /animationFrameId = requestAnimationFrame/);
	assert.match(player, /cancelAnimationFrame\(animationFrameId\)/);
	assert.match(player, /ASS_RENDERER_IDLE_TIMEOUT_MS/);
	assert.match(player, /queryFonts: false/);
	assert.match(player, /fonts: \[subtitleFontUrl\]/);
	assert.match(player, /defaultFont: "vag rounded next"/);
	assert.doesNotMatch(player, /ass_font|fontUrls/);
	assert.doesNotMatch(player, /\.renderer\.setEvent\(/);
	assert.doesNotMatch(player, /\.renderer\.setStyle\(/);
});

test("player derives production assets from its served route", async () => {
	const [player, markup, styles] = await Promise.all([
		readPlayerSources(),
		readFile(playerMarkupPath, "utf8"),
		readFile(playerStylePath, "utf8"),
	]);

	assert.match(player, /const playerAssetBaseUrl = new URL\(/);
	assert.match(player, /playerScriptElement\?\.src \|\| document\.baseURI/);
	assert.match(player, /const metricsBaseUrl =/);
	assert.match(player, /https:\/\/metrics-api\.dcote\.net/);
	assert.match(player, /playerScriptElement\?\.dataset\.jassubVersion/);
	assert.match(player, /playerScriptElement\?\.dataset\.subtitleFontVersion/);
	assert.match(styles, /src: url\("fonts\/vag-rounded-next-bold\.woff2"\)/);
	assert.match(markup, /<base href="\/videoplayer\/" \/>/);
	assert.match(markup, /<script defer src="vendor\/shaka\/shaka-player\.ui\.js">/);
	assert.match(markup, /<link rel="stylesheet" href="player\.css" \/>/);
	assert.match(markup, /<script defer src="player\.js"><\/script>/);
	assert.match(
		markup,
		/<script defer src="player-subtitles\.js"><\/script>/,
	);
	assert.doesNotMatch(markup, /<style>|<script>/);
});

test("player switches text displayers for native presentation modes", async () => {
	const [player, playerMain, playerSubtitles] = await Promise.all([
		readPlayerSources(),
		readFile(playerPath, "utf8"),
		readFile(playerSubtitlesPath, "utf8"),
	]);

	assert.match(player, /function getPresentationTextDisplayerMode\(/);
	assert.match(player, /document\.pictureInPictureElement === video/);
	assert.match(player, /document\.fullscreenElement === video/);
	assert.match(player, /new shaka\.text\.NativeTextDisplayer\(player\)/);
	assert.match(player, /new shaka\.text\.UITextDisplayer\(player\)/);
	assert.match(
		playerMain,
		/configurePresentationTextDisplayerLifecycle\(player, video\)/,
	);
	assert.match(
		playerSubtitles,
		/function configurePresentationTextDisplayerLifecycle\(player, video\)/,
	);
	assert.match(playerSubtitles, /\["connecting", "connect", "disconnect"\]/);
	assert.match(
		playerSubtitles,
		/listen\(document, "fullscreenchange", syncPresentation\)/,
	);
});

test("stable subtitle selectors take precedence over language fallback", async () => {
	const player = await readPlayerSources();

	assert.match(
		player,
		/const hasStableSelector = Boolean\([\s\S]*assSubtitles\.trackId \|\| assSubtitles\.label/,
	);
	assert.match(player, /if \(hasStableSelector\) return true/);
});

test("player disposes one session and preserves accessible keyboard controls", async () => {
	const [player, markup] = await Promise.all([
		readPlayerSources(),
		readFile(playerMarkupPath, "utf8"),
	]);

	assert.match(player, /function destroyPlayerSession\(\)/);
	assert.match(player, /playerLifecycle\.cleanupTasks\.splice\(0\)\.reverse\(\)/);
	assert.match(player, /await ui\?\.destroy\?\.\(\)/);
	assert.match(player, /await player\?\.destroy\?\.\(\)/);
	assert.match(player, /const MOBILE_ABR_MAX_HEIGHT = 720/);
	assert.match(player, /const DESKTOP_ABR_MAX_HEIGHT = 1080/);
	assert.match(player, /const INITIAL_ABR_BANDWIDTH_ESTIMATE = 100_000_000/);
	assert.match(player, /abr: \{[\s\S]*restrictions: \{\s*maxHeight:/);
	assert.match(player, /useNetworkInformation: false/);
	assert.match(player, /button, a,/);
	assert.match(player, /\[role='menuitem'\]/);
	assert.match(player, /\[role='slider'\]/);
	assert.match(markup, /id="skip-btn" class="shaka-no-propagation"/);
	assert.doesNotMatch(player, /setEnabledShakaControls/);
	assert.doesNotMatch(player, /const silenceShaka/);
});

test("site tracker shares sessions and acknowledges explicit visit events", async () => {
	const tracker = await readFile(trackerPath, "utf8");

	assert.match(tracker, /window\.localStorage\.getItem\(storageKey\)/);
	assert.match(tracker, /visitStarted: visitStartedPending/);
	assert.match(tracker, /pageViewStarted: pageViewStartedPending/);
	assert.match(tracker, /response\.visitAcknowledged === visitId/);
	assert.match(tracker, /response\.pageViewAcknowledged === pageViewId/);
});

test("dashboards refresh and use exact persisted analytics", async () => {
	const videoDashboard = JSON.parse(
		await readFile(videoDashboardPath, "utf8"),
	);
	const websiteDashboard = JSON.parse(
		await readFile(websiteDashboardPath, "utf8"),
	);
	const websiteExpressions = websiteDashboard.panels.flatMap((panel) =>
		(panel.targets || []).map((target) => target.expr || ""),
	);
	const videoExpressions = videoDashboard.panels.flatMap((panel) =>
		(panel.targets || []).map((target) => target.expr || ""),
	);

	assert.equal(videoDashboard.refresh, "5s");
	assert.equal(websiteDashboard.refresh, "5s");
	assert.ok(
		websiteExpressions.some((expression) =>
			expression.includes("dcote_site_visits{"),
		),
	);
	assert.ok(
		websiteExpressions.some((expression) =>
			expression.includes("dcote_site_page_visits{"),
		),
	);
	assert.ok(
		videoExpressions.some((expression) =>
			expression.includes("dcote_video_views{"),
		),
	);
	assert.ok(
		videoExpressions.some((expression) =>
			expression.includes("dcote_viewing_duration_average_seconds{"),
		),
	);
	for (const dashboard of [videoDashboard, websiteDashboard]) {
		for (const panel of dashboard.panels) {
			for (const target of panel.targets || []) {
				assert.ok(target.datasource.uid);
				assert.equal(panel.datasource.uid, target.datasource.uid);
				if (target.expr?.startsWith("dcote_")) {
					assert.equal(target.datasource.uid, "dcote-analytics");
				}
			}
		}
	}
});

test("historical dashboards bound range-query volume and keep current stats instant", async () => {
	const dashboards = await Promise.all(
		[videoDashboardPath, websiteDashboardPath].map(async (path) =>
			JSON.parse(await readFile(path, "utf8")),
		),
	);

	for (const dashboard of dashboards) {
		const timeSeriesPanels = dashboard.panels.filter(
			(panel) => panel.type === "timeseries",
		);

		assert.ok(timeSeriesPanels.length > 0);
		for (const panel of timeSeriesPanels) {
			assert.ok(panel.maxDataPoints > 0);
			assert.ok(panel.maxDataPoints <= 5000);
			assert.deepEqual(panel.options.legend.calcs, ["min", "max"]);
			for (const target of panel.targets || []) {
				assert.equal(target.range, true);
				assert.equal(target.interval, "5s");
				assert.equal(target.datasource.uid, "dcote-analytics");
			}
		}

	}

	const websiteDashboard = dashboards[1];
	const currentStatPanels = websiteDashboard.panels.filter((panel) =>
		panel.type === "stat" && (panel.targets || []).some(
			(target) => target.expr?.includes("active_"),
		),
	);
	assert.ok(currentStatPanels.length > 0);
	for (const panel of currentStatPanels) {
		for (const target of panel.targets || []) {
			assert.equal(target.instant, true);
			assert.equal(target.range, false);
			assert.equal(target.datasource.uid, "PBFA97CFB590B2093");
		}
	}
});

test("viewer gauge compares the latest value with the exact selected-range maximum", async () => {
	const dashboard = JSON.parse(await readFile(videoDashboardPath, "utf8"));
	const gauge = dashboard.panels.find((panel) => panel.id === 1);

	assert.equal(gauge.type, "gauge");
	assert.equal(gauge.datasource.uid, "dcote-analytics");
	assert.match(gauge.description, /максимума за выбранный период/);
	assert.ok(gauge.maxDataPoints > 0);
	assert.ok(gauge.maxDataPoints <= 5000);
	assert.equal(gauge.fieldConfig.defaults.min, 0);
	assert.equal(Object.hasOwn(gauge.fieldConfig.defaults, "max"), false);
	assert.deepEqual(gauge.options.reduceOptions.calcs, ["lastNotNull"]);
	assert.equal(gauge.targets.length, 1);
	assert.equal(
		gauge.targets[0].expr,
		'dcote_presence{metric="active_viewers"}',
	);
	assert.equal(gauge.targets[0].datasource.uid, "dcote-analytics");
	assert.equal(gauge.targets[0].interval, "5s");
	assert.equal(gauge.targets[0].range, true);
	assert.notEqual(gauge.targets[0].instant, true);
});

test("Node Exporter Full uses one Prometheus datasource and one shared node", async () => {
	const dashboard = JSON.parse(await readFile(nodeDashboardPath, "utf8"));
	const variables = dashboard.templating.list;

	assert.deepEqual(variables.map((variable) => variable.name), ["node"]);
	assert.equal(variables[0].datasource.uid, "PBFA97CFB590B2093");
	assert.equal(
		variables[0].query.query,
		'label_values(node_uname_info{job="node"}, instance)',
	);

	const queryPanels = [];
	const collect = (panels) => {
		for (const panel of panels || []) {
			if ((panel.targets || []).length > 0) queryPanels.push(panel);
			collect(panel.panels);
		}
	};
	collect(dashboard.panels);

	assert.ok(queryPanels.length > 100);
	for (const panel of queryPanels) {
		assert.equal(panel.datasource.uid, "PBFA97CFB590B2093");
		for (const target of panel.targets) {
			assert.match(target.expr, /instance="\$node"/);
			assert.match(target.expr, /job="node"/);
			assert.doesNotMatch(target.expr, /\$(?:ds_prometheus|job|nodename)/);
		}
	}
});
