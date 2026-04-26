import client from "prom-client";

const register = new client.Registry();

const activeViewers = new client.Gauge({
	name: "active_viewers",
	help: "Сколько сейчас смотрят",
	registers: [register],
});

const totalConnections = new client.Counter({
	name: "total_connections",
	help: "Всего подключений",
	registers: [register],
});

export { register, activeViewers, totalConnections };
