import Fastify from "fastify";
import { join } from "path";
import { readFileSync } from "fs";
import metricsRoute from "./metrics/router.js";

const fastify = Fastify({
	logger: true,
});

fastify.get("/health", async (req, reply) => {
	return { ok: true };
});

const videoPlayerPath = await join(process.cwd(), "public", "player.html");

fastify.get("/videoplayer", async (req, reply) => {
	const html = readFileSync(videoPlayerPath);
	reply.type("text/html").send(html);
});

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
