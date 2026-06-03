import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { join } from "path";
import { readFile } from "fs/promises";
import metricsRoute from "./metrics/router.js";

const fastify = Fastify({
	//logger: true,
	trustProxy: true,
});

fastify.get("/health", async (req, reply) => {
	return { ok: true };
});

const videoPlayerPath = join(process.cwd(), "public", "player.html");
const videoPlayerFile = await readFile(videoPlayerPath);
const subtitleFontPath = join(
	process.cwd(),
	"public",
	"fonts",
	"vag-rounded-next-bold.woff2",
);
const subtitleFontFile = await readFile(subtitleFontPath);
const sitePresenceTrackerPath = join(
	process.cwd(),
	"public",
	"site-presence-tracker.js",
);
const sitePresenceTrackerFile = await readFile(sitePresenceTrackerPath);

fastify.get("/videoplayer", async (req, reply) => {
	reply.type("text/html").send(videoPlayerFile);
});

fastify.get("/fonts/vag-rounded-next-bold.woff2", async (req, reply) => {
	reply.type("font/woff2").send(subtitleFontFile);
});

fastify.get("/site-presence-tracker.js", async (req, reply) => {
	reply.type("application/javascript").send(sitePresenceTrackerFile);
});

fastify.get("/metrics-api/site-presence-tracker.js", async (req, reply) => {
	reply.type("application/javascript").send(sitePresenceTrackerFile);
});

fastify.register(fastifyWebsocket);
fastify.register(metricsRoute, { prefix: "/metrics" });
fastify.register(metricsRoute, { prefix: "/metrics-api/metrics" });

const start = async () => {
	try {
		const port = Number(process.env.PORT) || 3000;
		const host = process.env.HOST || "0.0.0.0";
		await fastify.listen({ port, host });
	} catch (err) {
		console.error(err);
		fastify.log.error(err);
		process.exit(1);
	}
};
start();
