import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const playerPath = new URL("../public/player.html", import.meta.url);
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

test("player measures active playback and reports one completed duration", async () => {
	const player = await readFile(playerPath, "utf8");

	assert.match(player, /video\.addEventListener\("playing", initViewingTime\)/);
	assert.match(player, /\["pause", "waiting", "stalled", "seeking"\]/);
	assert.match(player, /performance\.now\(\) - viewingTime\.activeStartedAt/);
	assert.match(player, /viewingTime\.reported/);
	assert.match(player, /eventId: viewingTime\.eventId/);
	assert.match(player, /eventId: viewStartedMetric\.eventId/);
	assert.match(player, /eventId: subtitleMetric\.eventId/);
	assert.match(player, /METRIC_RETRY_QUEUE_KEY/);
	assert.match(player, /enqueueMetricRetry\(path, payload\)/);
	assert.match(player, /acknowledgeMetricRetry\(path, payload\.eventId\)/);
	assert.match(player, /window\.addEventListener\("online", flushMetricRetryQueue\)/);
	assert.match(player, /navigator\.sendBeacon\(url, blob\) \|\| retryQueued/);
	assert.doesNotMatch(player, /if \(queued\) viewingTime\.watchedSeconds = 0/);
	assert.match(player, /if \(!event\.persisted\) flushViewingTimeMetric\(\)/);
});

test("player online presence follows playback and reconnects", async () => {
	const player = await readFile(playerPath, "utf8");

	assert.match(player, /setActiveViewerPresence\(true\)/);
	assert.match(player, /setActiveViewerPresence\(false\)/);
	assert.match(player, /scheduleActiveViewerReconnect\(\)/);
	assert.doesNotMatch(
		player,
		/const activeViewersSocket = new WebSocket\(websocketUrl\)/,
	);
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
				if (!target.expr?.startsWith("dcote_")) continue;
				assert.equal(target.datasource.uid, "dcote-analytics");
			}
		}
	}
});

test("historical dashboards bound range-query volume and keep current values instant", async () => {
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

		const currentValuePanels = dashboard.panels.filter((panel) =>
			(panel.targets || []).some(
				(target) =>
					target.expr?.includes("active_") &&
					panel.type !== "timeseries",
			),
		);
		assert.ok(currentValuePanels.length > 0);
		for (const panel of currentValuePanels) {
			for (const target of panel.targets || []) {
				assert.equal(target.instant, true);
				assert.equal(target.range, false);
			}
		}
	}
});
