import {
	register,
	activeViewers,
	viewingDuration,
	subtitlesEnabled,
} from "./metrics.js";
import { getCountry } from "./maxmind.js";
import {
	registerSitePresenceConnection,
	touchSitePresenceConnection,
	unregisterSitePresenceConnection,
} from "./sitePresence.js";

function parseWebsocketJsonMessage(msg) {
	const text = msg.toString();
	if (text.length > 4096) {
		return {
			ok: false,
			error: "Message is too large",
		};
	}

	try {
		return {
			ok: true,
			data: JSON.parse(text),
		};
	} catch {
		return {
			ok: false,
			error: "Invalid JSON",
		};
	}
}

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
		const body = req.body;
		const seconds = body.seconds;
		if (
			!seconds ||
			typeof seconds !== "number" ||
			seconds < 30 ||
			seconds > 60 * 60
		) {
			return { ok: false };
		}
		const ip = req.ip;

		const country = getCountry(ip);
		console.log(ip, country);
		viewingDuration.observe(
			{
				country: country ? country : "Другие",
				season: body.season ?? "Неизвестный",
				episode: body.episode ?? "Неизвестный",
				voice: body.voice ?? "Неизвестный",
			},
			seconds,
		);
		return { ok: true };
	});
	app.post("/subtitles", async (req, reply) => {
		const body = req.body ?? {};
		const seconds = body.seconds;
		if (
			!seconds ||
			typeof seconds !== "number" ||
			seconds < 30 ||
			seconds > 60 * 60
		) {
			return { ok: false };
		}
		const country = getCountry(req.ip);
		subtitlesEnabled.inc({
			country: country ? country : "Другие",
			season: body.season ?? "Неизвестный",
			episode: body.episode ?? "Неизвестный",
		});
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
	app.get("/site/ws", { websocket: true }, (socket, req) => {
		const connectionId = registerSitePresenceConnection();

		socket.on("message", (msg) => {
			const parsed = parseWebsocketJsonMessage(msg);
			if (!parsed.ok) {
				socket.send(JSON.stringify(parsed));
				return;
			}

			const result = touchSitePresenceConnection(
				connectionId,
				parsed.data,
			);
			socket.send(JSON.stringify(result));
		});

		socket.on("close", () => {
			unregisterSitePresenceConnection(connectionId);
		});

		socket.on("error", (err) => {
			console.error("Site presence websocket error:", err);
			unregisterSitePresenceConnection(connectionId);
		});
	});
}
