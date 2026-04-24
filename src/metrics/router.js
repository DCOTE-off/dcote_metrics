import client from "prom-client";

const register = new client.Registry();

export default async function metricsRoute(app) {
	app.get("/", async (req, reply) => {
		reply.header("Content-Type", register.contentType);
		return register.metrics();
	});
}
