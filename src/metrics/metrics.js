import client from "prom-client";

const register = new client.Registry();
const VIDEO_LABELS = ["country", "season", "episode", "voice"];
const SITE_PAGE_LABELS = ["page"];

const activeViewers = new client.Gauge({
	name: "active_viewers",
	help: "Сколько сейчас смотрят",
	registers: [register],
});

const viewingDuration = new client.Histogram({
	name: "viewing_duration_seconds",
	help: "Completed playback session duration in active playback seconds",
	labelNames: VIDEO_LABELS,
	buckets: [30, 60, 120, 300, 600, 1200, 1800, 3600],
	registers: [register],
});

const videoViews = new client.Counter({
	name: "video_views_total",
	help: "Video views after 30 seconds of playback",
	labelNames: VIDEO_LABELS,
	registers: [register],
});

const subtitlesEnabled = new client.Counter({
	name: "subtitles_enabled_total",
	help: "Subtitle usage after 30 seconds enabled during playback",
	labelNames: ["country", "season", "episode"],
	registers: [register],
});

const activeSiteTabs = new client.Gauge({
	name: "active_site_tabs",
	help: "Currently open site tabs by page",
	labelNames: SITE_PAGE_LABELS,
	registers: [register],
});

const activeSiteSessions = new client.Gauge({
	name: "active_site_sessions",
	help: "Currently active browser sessions by page",
	labelNames: SITE_PAGE_LABELS,
	registers: [register],
});

const activeSiteUsers = new client.Gauge({
	name: "active_site_users",
	help: "Currently active registered users by page",
	labelNames: SITE_PAGE_LABELS,
	registers: [register],
});

const activeSiteTabsGlobal = new client.Gauge({
	name: "active_site_tabs_global",
	help: "Currently open site tabs across all pages",
	registers: [register],
});

const activeSiteSessionsGlobal = new client.Gauge({
	name: "active_site_sessions_global",
	help: "Currently active browser sessions across all pages",
	registers: [register],
});

const activeSiteUsersGlobal = new client.Gauge({
	name: "active_site_users_global",
	help: "Currently active registered users across all pages",
	registers: [register],
});

const siteVisits = new client.Counter({
	name: "site_visits_total",
	help: "Website visits counted by browser session",
	registers: [register],
});

const sitePageVisits = new client.Counter({
	name: "site_page_visits_total",
	help: "Website page visits counted by browser tab",
	labelNames: SITE_PAGE_LABELS,
	registers: [register],
});

activeViewers.set(0);
activeSiteTabsGlobal.set(0);
activeSiteSessionsGlobal.set(0);
activeSiteUsersGlobal.set(0);
// Counter нельзя выставить напрямую, поэтому inc(0) заранее показывает ряд в /metrics.
siteVisits.inc(0);

export {
	register,
	activeViewers,
	viewingDuration,
	videoViews,
	subtitlesEnabled,
	activeSiteTabs,
	activeSiteSessions,
	activeSiteUsers,
	activeSiteTabsGlobal,
	activeSiteSessionsGlobal,
	activeSiteUsersGlobal,
	siteVisits,
	sitePageVisits,
};
