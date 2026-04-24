export default async function metricsRoute(app) {
	app.get("/", async (req, reply) => {
		return { ok: true };
	});
}
