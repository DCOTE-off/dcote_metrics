import client from "prom-client";

const register = new client.Registry();

const activeViewers = new client.Gauge({
	name: "active_viewers",
	help: "Сколько сейчас смотрят",
	registers: [register],
});

const totalConnections = new client.Counter({
	name: "video_player_connections_total",
	help: "Всего подключений",
	registers: [register],
});

export { register, activeViewers, totalConnections };
