import client from "prom-client";

const register = new client.Registry();

const activeViewers = new client.Gauge({
	name: "active_viewers",
	help: "Сколько сейчас смотрят",
	registers: [register],
});

const viewingDuration = new client.Histogram({
	name: "viewing_duration_seconds",
	help: "Длительность просмотра",
	labelNames: ["country", "season", "episode", "voice"],
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
	labelNames: ["page"],
	registers: [register],
});

const activeSiteSessions = new client.Gauge({
	name: "active_site_sessions",
	help: "Currently active browser sessions by page",
	labelNames: ["page"],
	registers: [register],
});

const activeSiteUsers = new client.Gauge({
	name: "active_site_users",
	help: "Currently active authenticated users by page",
	labelNames: ["page"],
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
	help: "Currently active authenticated users across all pages",
	registers: [register],
});

function initTestSeedDatas() {
	const datas = [
		{ country: "KZ", season: 1, episode: 3, voice: "DUB" },
		{ country: "KZ", season: 2, episode: 3, voice: "DUB" },
		{ country: "RU", season: 1, episode: 5, voice: "SUB" },
		{ country: "BG", season: 2, episode: 6, voice: "DUB" },
		{ country: "SK", season: 3, episode: 1, voice: "DUB" },
		{ country: "KZ", season: 3, episode: 5, voice: "DUB" },
		{ country: "KZ", season: 1, episode: 3, voice: "DUB" },
		{ country: "KZ", season: 1, episode: 3, voice: "DUB" },
		{ country: "KZ", season: 1, episode: 3, voice: "DUB" },
		{ country: "KZ", season: 1, episode: 3, voice: "DUB" },
	];
	datas.forEach((el) => {
		console.log(el);
		viewingDuration.observe(
			{
				country: el.country ? el.country : "Другие",
				season: el.season ?? "Неизвестный",
				episode: el.episode ?? "Неизвестный",
				voice: el.voice ?? "Неизвестный",
			},
			Math.floor(Math.random() * 60),
		);
	});
}
//initTestSeedDatas();
activeViewers.set(0);
activeSiteTabsGlobal.set(0);
activeSiteSessionsGlobal.set(0);
activeSiteUsersGlobal.set(0);

export {
	register,
	activeViewers,
	viewingDuration,
	subtitlesEnabled,
	activeSiteTabs,
	activeSiteSessions,
	activeSiteUsers,
	activeSiteTabsGlobal,
	activeSiteSessionsGlobal,
	activeSiteUsersGlobal,
};
