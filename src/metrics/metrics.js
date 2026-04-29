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

activeViewers.set(0);

//count by (country) (rate(viewing_duration_seconds_count[1h]))
export { register, activeViewers, viewingDuration };
