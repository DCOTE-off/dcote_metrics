import { buildApp } from "./app.js";
import { getRuntimeConfig } from "./runtimeConfig.js";

const config = getRuntimeConfig();
const app = await buildApp({ config });
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
