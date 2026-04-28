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

export { register, activeViewers, viewingDuration };
