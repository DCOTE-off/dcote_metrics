import client from "prom-client";

const register = new client.Registry();

export default async function metricsRoute(app) {
	app.get("/", async (req, reply) => {
		reply.header("Content-Type", register.contentType);
		return register.metrics();
	});
	app.get("/ws", { websocket: true }, (socket, req) => {
		console.log("Подключился");

		socket.on("message", (msg) => {
			const data = JSON.parse(msg);
			console.log("Получил:", data);

			socket.send(JSON.stringify({ ok: true }));
		});

		socket.on("close", () => {
			console.log("Отключился");
		});

		socket.on("error", (err) => {
			console.error("Ошибка:", err);
		});
	});
}
