import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../docker-compose.yml", import.meta.url);

test("public reverse-proxy upstreams preserve reachable bind defaults", async () => {
	const compose = await readFile(composePath, "utf8");

	assert.match(
		compose,
		/\$\{BACKEND_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{BACKEND_PORT:-7654\}:3000/,
	);
	assert.match(
		compose,
		/\$\{GRAFANA_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{GRAFANA_PORT:-7070\}:3000/,
	);
	assert.match(
		compose,
		/\$\{PROMETHEUS_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{PROMETHEUS_PORT:-9090\}:9090/,
	);
});
