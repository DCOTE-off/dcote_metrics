import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { join } from "path";
import { readFile } from "fs";
import metricsRoute from "./metrics/router.js";

const fastify = Fastify({
	logger: true,
});

fastify.get("/health", async (req, reply) => {
	return { ok: true };
});

const videoPlayerPath = join(process.cwd(), "public", "player.html");
const videoPlayerFile = await readFile(videoPlayerPath);

fastify.get("/videoplayer", async (req, reply) => {
	reply.type("text/html").send(videoPlayerFile);
});

fastify.register(fastifyWebsocket);
fastify.register(metricsRoute, { prefix: "/metrics" });

const start = async () => {
	try {
		await fastify.listen({ port: 3000, host: "0.0.0.0" });
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}
};
start();
