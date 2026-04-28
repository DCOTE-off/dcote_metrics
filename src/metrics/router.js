import { register, activeViewers, viewingDuration } from "./metrics.js";
import { getCountry } from "./maxmind.js";

export default async function metricsRoute(app) {
	app.get("/", async (req, reply) => {
		//TODO
		const auth = req.headers["authorization"];
		const isAuth = auth
			? auth.split(" ")[1] == "SUPERSECRETPASSWORD"
			: false;
		if (!isAuth) {
			reply.code(403).send({ error: "Forbidden" });
		}
		reply.header("Content-Type", register.contentType);
		return register.metrics();
	});
	app.post("/viewing-time", async (req, reply) => {
		const seconds = req.body.seconds;
		console.log(req.body);
		if (
			!seconds ||
			typeof seconds !== "number" ||
			seconds < 0 ||
			seconds > 60 * 60
		) {
			return { ok: false };
		}
		const ip = req.ip;

		const country = getCountry(ip);
		viewingDuration.observe(seconds);
		return { ok: true };
	});
	app.get("/ws", { websocket: true }, (socket, req) => {
		console.log("Подключился");
		activeViewers.inc();
		socket.on("message", (msg) => {
			const data = JSON.parse(msg);
			console.log("Получил:", data);

			socket.send(JSON.stringify({ ok: true }));
		});

		socket.on("close", () => {
			console.log("Отключился");
			activeViewers.dec();
		});

		socket.on("error", (err) => {
			console.error("Ошибка:", err);
		});
	});
}
