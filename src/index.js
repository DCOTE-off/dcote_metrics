import { buildApp } from "./app.js";
import { getRuntimeConfig } from "./runtimeConfig.js";

const config = getRuntimeConfig();
let app;
try {
	app = await buildApp({ config });
} catch (error) {
	// buildApp падает до появления логгера, поэтому единственный способ
	// оставить след в docker logs — писать в stderr напрямую.
	console.error("Failed to build the metrics service:", error);
	process.exit(1);
}
let shuttingDown = false;

async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	app.log.info({ signal }, "Shutting down");
	try {
		await app.close();
		process.exitCode = 0;
	} catch (error) {
		app.log.error(error, "Graceful shutdown failed");
		process.exitCode = 1;
	}
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
	await app.listen({ port: config.port, host: config.host });
} catch (error) {
	app.log.error(error, "Failed to start metrics service");
	process.exitCode = 1;
}
