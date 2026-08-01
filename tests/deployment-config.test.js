import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../docker-compose.yml", import.meta.url);
const datasourcePath = new URL(
	"../grafana/provisioning/datasources/datasource.yml",
	import.meta.url,
);
const prometheusPath = new URL("../prometheus.yml", import.meta.url);

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

test("player receives the dedicated public metrics origin", async () => {
	const compose = await readFile(composePath, "utf8");

	assert.match(
		compose,
		/METRICS_PUBLIC_BASE_URL: \$\{METRICS_PUBLIC_BASE_URL:-https:\/\/metrics-api\.dcote\.net\}/,
	);
});

test("Grafana pins the primary and analytics Prometheus-compatible datasources", async () => {
	const datasources = await readFile(datasourcePath, "utf8");

	assert.match(datasources, /- name: Prometheus\s+uid: PBFA97CFB590B2093/);
	assert.match(datasources, /- name: Dcote analytics\s+uid: dcote-analytics/);
});

test("node exporter observes the host and enables dashboard collectors", async () => {
	const compose = await readFile(composePath, "utf8");

	assert.match(compose, /- \/:\/host:ro,rslave/);
	assert.match(
		compose,
		/- \/run\/dbus\/system_bus_socket:\/run\/dbus\/system_bus_socket:ro/,
	);
	assert.match(compose, /--collector\.processes/);
	assert.match(compose, /--collector\.systemd/);
});

test("Prometheus exposes one shared node target to the node dashboard", async () => {
	const prometheus = await readFile(prometheusPath, "utf8");

	assert.equal((prometheus.match(/job_name:\s*"node"/g) || []).length, 1);
	assert.equal(
		(prometheus.match(/targets:\s*\["node_exporter:9100"\]/g) || []).length,
		1,
	);
});
