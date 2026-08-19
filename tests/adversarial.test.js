// Регрессии адверсального ревью. Каждый тест утверждает документированное
// поведение, которое ранее нарушалось: падение теста означает возврат бага.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import {
	getPublicHttpBaseUrl,
	getRuntimeConfig,
	parseTrustProxy,
} from "../src/runtimeConfig.js";
import { isInternalAddress } from "../src/analytics/prometheusApi.js";
import {
	MAX_METRIC_SECONDS,
	MAX_WEBSOCKET_MESSAGE_BYTES,
} from "../src/metrics/router.js";
import {
	distributeVttCues,
	packageVttHls,
} from "../scripts/package-vtt-hls.mjs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AUTH_TOKEN = "adversarial-test-secret";
const playerPath = new URL("../public/player.js", import.meta.url);

function createConfig(env = {}) {
	return getRuntimeConfig({
		METRICS_ALLOWED_ORIGINS: "https://dcote.net,https://video.dcote.net",
		METRICS_AUTH_TOKEN_FILE: "Z:/missing/metrics-token",
		ANALYTICS_DATABASE_PATH: ":memory:",
		...env,
	});
}

function createApp(overrides = {}) {
	return buildApp({
		config: createConfig(),
		projectRoot: PROJECT_ROOT,
		logger: false,
		initializeGeoDatabase: false,
		metricsAuthToken: AUTH_TOKEN,
		getCountry: () => "NL",
		...overrides,
	});
}

// Клиент ws склеивает и маскирует кадр целиком, поэтому его собственная
// аллокация исказила бы измерение памяти сервера в этом же процессе.
// Сырой сокет объявляет длину в заголовке и льёт тело потоком.
function openRawWebsocket(port, path, origin) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(
				`GET ${path} HTTP/1.1\r\n`
				+ `Host: 127.0.0.1:${port}\r\n`
				+ "Upgrade: websocket\r\n"
				+ "Connection: Upgrade\r\n"
				+ `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n`
				+ "Sec-WebSocket-Version: 13\r\n"
				+ `Origin: ${origin}\r\n\r\n`,
			);
		});
		socket.once("error", reject);
		socket.once("data", (chunk) => {
			const status = chunk.toString("latin1").split("\r\n")[0];
			if (status.startsWith("HTTP/1.1 101")) resolve(socket);
			else reject(new Error(status));
		});
	});
}

function maskedTextFrameHeader(payloadLength, mask) {
	const header = Buffer.alloc(14);
	header[0] = 0x81;
	header[1] = 0xff;
	header.writeBigUInt64BE(BigInt(payloadLength), 2);
	mask.copy(header, 10);
	return header;
}

test("a websocket frame above the message cap is refused by the protocol", async (t) => {
	const app = await createApp();
	await app.listen({ host: "127.0.0.1", port: 0 });
	t.after(() => app.close());
	const { port } = app.server.address();

	const socket = await new Promise((resolve, reject) => {
		const candidate = new WebSocket(
			`ws://127.0.0.1:${port}/metrics/site/ws`,
			{ headers: { Origin: "https://dcote.net" } },
		);
		candidate.once("open", () => resolve(candidate));
		candidate.once("error", reject);
	});
	t.after(() => socket.terminate());

	const outcome = await new Promise((resolve) => {
		socket.once("close", (code) => resolve(code));
		socket.once("message", (message) => resolve(String(message)));
		socket.send("x".repeat(MAX_WEBSOCKET_MESSAGE_BYTES + 1));
	});
	assert.equal(
		outcome,
		1009,
		"ws must close with 1009 rather than hand the frame to the router",
	);
});

test("an oversized websocket frame is never buffered in memory", async (t) => {
	const app = await createApp();
	await app.listen({ host: "127.0.0.1", port: 0 });
	t.after(() => app.close());
	const { port } = app.server.address();

	const socket = await openRawWebsocket(
		port,
		"/metrics/site/ws",
		"https://dcote.net",
	);
	t.after(() => socket.destroy());

	const declaredBytes = 64 * 1024 * 1024;
	const chunk = Buffer.alloc(64 * 1024, 0x78);
	const rssBefore = process.memoryUsage().rss;
	let peakRss = rssBefore;
	const sampler = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 5);
	t.after(() => clearInterval(sampler));

	let closed = false;
	socket.once("close", () => {
		closed = true;
	});
	// Отказавшийся читать сервер больше не разгружает буфер отправки,
	// поэтому "drain" гонится с закрытием и таймаутом.
	const writeChunk = () => new Promise((resolve) => {
		if (socket.write(chunk)) {
			resolve(true);
			return;
		}
		const finish = (accepted) => {
			socket.off("drain", onDrain);
			socket.off("close", onClose);
			clearTimeout(timer);
			resolve(accepted);
		};
		const onDrain = () => finish(true);
		const onClose = () => finish(false);
		const timer = setTimeout(() => finish(false), 2000);
		socket.on("drain", onDrain);
		socket.on("close", onClose);
	});

	let deliveredBytes = 0;
	socket.write(maskedTextFrameHeader(declaredBytes, Buffer.alloc(4)));
	while (!closed && deliveredBytes < declaredBytes) {
		if (!(await writeChunk())) break;
		deliveredBytes += chunk.length;
	}
	if (!closed) {
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 1000);
			socket.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	clearInterval(sampler);

	assert.ok(
		closed,
		`the server accepted all ${declaredBytes} declared bytes`,
	);
	assert.ok(
		deliveredBytes < declaredBytes / 2,
		`the server read ${deliveredBytes} of ${declaredBytes} declared bytes `
		+ "before refusing the frame",
	);
	const grewMiB = (peakRss - rssBefore) / 1048576;
	assert.ok(
		grewMiB < 16,
		`RSS grew ${grewMiB.toFixed(1)} MiB while refusing the frame`,
	);
});

test("analytics API stays closed to unauthenticated private-network clients", async (t) => {
	const app = await createApp();
	t.after(() => app.close());

	const reachable = [];
	for (const remoteAddress of [
		"192.168.1.50",
		"10.20.30.40",
		"172.20.5.9",
		"fd12:3456::1",
	]) {
		const reply = await app.inject({
			method: "GET",
			url: "/analytics/diagnostics",
			remoteAddress,
		});
		if (reply.statusCode === 200) {
			reachable.push(`${remoteAddress} -> ${reply.body}`);
		}
	}
	assert.deepEqual(reachable, [], reachable.join("\n"));

	const spoofed = await app.inject({
		method: "GET",
		url: "/analytics/diagnostics",
		remoteAddress: "203.0.113.7",
		headers: { "x-forwarded-for": "127.0.0.1" },
	});
	assert.equal(
		spoofed.statusCode,
		403,
		"the ACL must use the socket peer, not X-Forwarded-For",
	);

	const authorized = await app.inject({
		method: "GET",
		url: "/analytics/diagnostics",
		headers: { authorization: `Bearer ${AUTH_TOKEN}` },
	});
	assert.equal(authorized.statusCode, 200);
});

test("analytics API reports itself unconfigured when no token is loaded", async (t) => {
	const app = await createApp({ metricsAuthToken: null });
	t.after(() => app.close());

	const reply = await app.inject({
		method: "GET",
		url: "/analytics/diagnostics",
	});
	assert.equal(reply.statusCode, 503);
});

test("isInternalAddress rejects strings that are not addresses", () => {
	const accepted = ["fdsa", "fc-whatever", "fd", "fdoo.example.com", "", "fc"]
		.filter((value) => isInternalAddress(value));
	assert.deepEqual(accepted, [], accepted.join(", "));

	assert.equal(isInternalAddress("fd12:3456::1"), true);
	assert.equal(isInternalAddress("::1"), true);
	assert.equal(isInternalAddress("::ffff:10.1.2.3"), true);
	assert.equal(isInternalAddress("2001:db8::1"), false);
	assert.equal(isInternalAddress("203.0.113.7"), false);
});

test("malformed analytics selectors answer 400 instead of crashing the handler", async (t) => {
	const app = await createApp();
	t.after(() => app.close());
	const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

	const failures = [];
	for (const query of [
		'x{a="\\x"}',
		'x{a="\\u00zz"}',
		'dcote_video_views{range_s="86400",bad="\\q"}',
	]) {
		const reply = await app.inject({
			method: "GET",
			url: `/analytics/api/v1/query?query=${encodeURIComponent(query)}`,
			headers,
		});
		if (reply.statusCode !== 400) {
			failures.push(`${query} -> ${reply.statusCode} ${reply.body}`);
		}
	}
	const rangeReply = await app.inject({
		method: "GET",
		url: "/analytics/api/v1/query_range?query="
			+ encodeURIComponent('dcote_presence{metric="\\q"}')
			+ "&start=0&end=100&step=15s",
		headers,
	});
	if (rangeReply.statusCode !== 400) {
		failures.push(`query_range -> ${rangeReply.statusCode}`);
	}
	assert.deepEqual(failures, [], failures.join("\n"));
});

test("an unrecognised TRUST_PROXY value falls back instead of crashing", () => {
	for (const value of ["no", "False", "off", "yes", "garbage", "1.2.3.4/99"]) {
		assert.doesNotThrow(() => parseTrustProxy(value));
	}
	assert.equal(parseTrustProxy("no"), false);
	assert.equal(parseTrustProxy("YES"), true);
	assert.deepEqual(parseTrustProxy("10.0.0.0/8,::1"), ["10.0.0.0/8", "::1"]);
	assert.ok(Array.isArray(parseTrustProxy("garbage")));

	const warnings = [];
	parseTrustProxy("garbage", (message) => warnings.push(message));
	assert.equal(warnings.length, 1);
});

test("every accepted TRUST_PROXY value is one Fastify can actually compile", async () => {
	// Самодельный синтаксический валидатор расходился с proxy-addr на /0
	// и на пресетах в верхнем регистре, и расхождение снова роняло старт.
	const crashes = [];
	for (const value of [
		"0.0.0.0/0",
		"::/0",
		"10.0.0.0/0",
		"LOOPBACK",
		"Loopback",
		"UniqueLocal",
		"1.2.3.4/33",
		"10.0.0.0/8,garbage",
		",,,",
		"loopback",
		"10.0.0.0/255.0.0.0",
		"10.0.0.0/8,::1",
	]) {
		const trustProxy = parseTrustProxy(value);
		try {
			const app = await buildApp({
				config: { ...createConfig(), trustProxy },
				projectRoot: PROJECT_ROOT,
				logger: false,
				initializeGeoDatabase: false,
				metricsAuthToken: AUTH_TOKEN,
				getCountry: () => "NL",
			});
			await app.close();
		} catch (error) {
			crashes.push(`TRUST_PROXY=${value} -> ${error.message}`);
		}
	}
	assert.deepEqual(crashes, [], crashes.join("\n"));

	// Формы, которые proxy-addr принимает, не должны молча теряться.
	assert.deepEqual(parseTrustProxy("10.0.0.0/255.0.0.0"), [
		"10.0.0.0/255.0.0.0",
	]);
	assert.deepEqual(parseTrustProxy("loopback"), ["loopback"]);

	// Список из одних разделителей — это не "не доверять никому".
	const warnings = [];
	assert.ok(Array.isArray(parseTrustProxy(",,,", (m) => warnings.push(m))));
	assert.notEqual(parseTrustProxy(",,,").length, 0);
	assert.equal(warnings.length, 1);
});

test("opaque origins never reach the allow-list or the CSP header", async (t) => {
	const config = createConfig({
		METRICS_ALLOWED_ORIGINS: "https://dcote.net,file:///etc/passwd,data:text/html",
	});
	assert.deepEqual([...config.allowedOrigins], ["https://dcote.net"]);
	assert.ok(config.configWarnings.length > 0);

	const app = await createApp({ config });
	t.after(() => app.close());

	for (const origin of ["file:///x", "data:text/html,evil", "null"]) {
		const reply = await app.inject({
			method: "POST",
			url: "/metrics/view-labels",
			headers: { origin },
			payload: { season: "1", episode: "1", voice: "A" },
		});
		assert.equal(reply.statusCode, 403, `origin ${origin} was accepted`);
	}

	const player = await app.inject({ method: "GET", url: "/videoplayer" });
	assert.doesNotMatch(
		player.headers["content-security-policy"],
		/\bnull\b/,
		"an opaque origin leaked into frame-ancestors",
	);
});

test("the service starts with a misspelled TRUST_PROXY value", () => {
	// Остальные написания покрыты модульным тестом parseTrustProxy выше;
	// здесь важен только сам факт, что процесс переживает старт.
	const crashes = [];
	for (const value of ["no"]) {
		try {
			execFileSync(process.execPath, ["src/index.js"], {
				cwd: PROJECT_ROOT,
				timeout: 4_000,
				stdio: "pipe",
				env: {
					...process.env,
					TRUST_PROXY: value,
					PORT: "45177",
					METRICS_AUTH_TOKEN_FILE: "Z:/none",
					ANALYTICS_DATABASE_PATH: join(
						tmpdir(),
						`dcote-trust-proxy-${value}.sqlite`,
					),
				},
			});
		} catch (error) {
			// Таймаут означает, что процесс поднялся и слушает порт.
			if (error.status === 1) {
				crashes.push(`TRUST_PROXY=${value}: ${String(error.stderr)}`);
			}
		}
	}
	assert.deepEqual(crashes, [], crashes.join("\n"));
});

test("allow-listed origins are normalized the same way as the request origin", async () => {
	const rejected = [];
	for (const value of [
		"https://dcote.net/",
		"https://DCOTE.NET",
		"https://dcote.net:443",
		"https://dcote.net/path",
	]) {
		const app = await buildApp({
			config: createConfig({ METRICS_ALLOWED_ORIGINS: value }),
			projectRoot: PROJECT_ROOT,
			logger: false,
			initializeGeoDatabase: false,
			metricsAuthToken: AUTH_TOKEN,
			getCountry: () => "NL",
		});
		const reply = await app.inject({
			method: "POST",
			url: "/metrics/view-labels",
			headers: { origin: "https://dcote.net" },
			payload: { season: "1", episode: "1", voice: "A" },
		});
		await app.close();
		if (reply.statusCode !== 200) {
			rejected.push(`${value} -> ${reply.statusCode}`);
		}
	}
	assert.deepEqual(rejected, [], rejected.join("\n"));
});

test("an unusable origin list warns and falls back to the defaults", () => {
	const config = createConfig({ METRICS_ALLOWED_ORIGINS: ",,," });
	assert.ok(config.allowedOrigins.has("https://dcote.net"));
	assert.ok(config.configWarnings.length > 0);
});

test("the VTT packager never drops a cue on a segment boundary", async () => {
	const boundaryCue = {
		id: "",
		start: 10,
		end: 10.001,
		settings: "",
		text: "BOUNDARY",
	};
	const distributed = distributeVttCues(
		[
			{ id: "", start: 1, end: 2, settings: "", text: "first" },
			boundaryCue,
			{ id: "", start: 15, end: 16, settings: "", text: "last" },
		],
		[10, 10],
	);
	const placed = distributed.flatMap((segment) => segment.cues);
	assert.ok(placed.includes(boundaryCue), "boundary cue reached no segment");

	// Fallback по середине реплики не имеет сегмента, куда её положить.
	assert.throws(() => distributeVttCues([boundaryCue], []));
	assert.deepEqual(distributeVttCues([], []), []);

	const directory = await mkdtemp(join(tmpdir(), "dcote-vtt-"));
	await writeFile(
		join(directory, "video.m3u8"),
		"#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.000000,\na.ts\n"
		+ "#EXTINF:10.000000,\nb.ts\n#EXT-X-ENDLIST\n",
	);
	await writeFile(
		join(directory, "source.vtt"),
		[
			"WEBVTT", "",
			"00:00:01.000 --> 00:00:02.000", "first", "",
			"00:00:10.000 --> 00:00:10.001", "BOUNDARY", "",
			"00:00:15.000 --> 00:00:16.000", "last", "",
		].join("\n"),
	);
	const result = await packageVttHls({
		videoPlaylistPath: join(directory, "video.m3u8"),
		sourceVttPath: join(directory, "source.vtt"),
		outputPlaylistPath: join(directory, "out.m3u8"),
		segmentPrefix: "seg_",
		ptsOffsetSeconds: 0,
	});
	const filenames = (await readdir(directory))
		.filter((filename) => filename.startsWith("seg_"));
	const written = (
		await Promise.all(
			filenames.map((filename) =>
				readFile(join(directory, filename), "utf8")
			),
		)
	).join("\n");

	assert.ok(written.includes("BOUNDARY"), JSON.stringify(result));
	assert.ok(result.segmentCueCount >= result.cueCount);
});

test("METRICS_PUBLIC_BASE_URL cannot break out of the player HTML attribute", async (t) => {
	const hostile = 'https://a"onload=alert(1)';
	const app = await createApp({
		config: createConfig({ METRICS_PUBLIC_BASE_URL: hostile }),
	});
	t.after(() => app.close());

	const html = (await app.inject({ method: "GET", url: "/videoplayer" })).body;
	const tag = html
		.split("\n")
		.find((line) => line.includes("data-metrics-base-url"));
	assert.ok(tag, "player document must carry the metrics base URL");
	assert.doesNotMatch(tag, /data-metrics-base-url="[^"]*"[^>]*onload=/);
	assert.match(tag, /data-metrics-base-url="[^"]*&quot;/);
	assert.equal(getPublicHttpBaseUrl(hostile).includes("\n"), false);
});

test("the player never reports a duration the backend rejects", async (t) => {
	const player = await readFile(playerPath, "utf8");
	const declared = player.match(
		/const VIEW_METRIC_MAX_SECONDS = ([\d *]+);/,
	)?.[1];
	assert.ok(declared, "player must declare an upper bound");
	assert.equal(
		declared.split("*").reduce((total, part) => total * Number(part), 1),
		MAX_METRIC_SECONDS,
	);
	assert.match(player, /seconds: toReportableSeconds\(/);
	assert.doesNotMatch(player, /\n\t\tseconds,\n/);

	const app = await createApp();
	t.after(() => app.close());
	const rejected = [];
	for (const seconds of [MAX_METRIC_SECONDS, MAX_METRIC_SECONDS - 1]) {
		const reply = await app.inject({
			method: "POST",
			url: "/metrics/viewing-time",
			headers: { origin: "https://video.dcote.net" },
			payload: {
				eventId: `viewing-time:${crypto.randomUUID()}`,
				seconds,
				season: "04",
				episode: "01",
				voice: "AniLiberty",
			},
		});
		if (reply.statusCode !== 200) {
			rejected.push(`${seconds}s -> ${reply.statusCode} ${reply.body}`);
		}
	}
	assert.deepEqual(rejected, [], rejected.join("\n"));
});

test("a permanently rejected metric leaves the retry queue", async () => {
	const player = await readFile(playerPath, "utf8");
	const declared = player.match(
		/const NON_RETRYABLE_METRIC_STATUSES = new Set\(\[([^\]]*)\]\)/,
	)?.[1];
	assert.ok(declared, "the player must name the non-retryable statuses");
	const statuses = declared.split(",").map((part) => Number(part.trim()));

	// Отказ обработчика повтор не исправит.
	assert.deepEqual(statuses.toSorted(), [400, 413, 422]);
	// Ошибка прокси или origin чинится конфигом — очередь обязана дожить.
	for (const retryable of [401, 403, 404, 429, 500, 502, 503]) {
		assert.equal(statuses.includes(retryable), false, String(retryable));
	}
	assert.match(
		player,
		/NON_RETRYABLE_METRIC_STATUSES\.has\(response\.status\)[\s\S]{0,120}acknowledgeMetricRetry\(path, payload\.eventId\)/,
	);
});

test("numeric environment variables are parsed as whole values", () => {
	assert.equal(getRuntimeConfig({ PORT: "1e4" }).port, 10_000);
	assert.equal(getRuntimeConfig({ PORT: "8080abc" }).port, 3000);
	assert.equal(getRuntimeConfig({ PORT: "3000.9" }).port, 3000);
	assert.equal(getRuntimeConfig({ PORT: "  7654  " }).port, 7654);
	assert.equal(getRuntimeConfig({ PORT: "0" }).port, 3000);
	assert.equal(getRuntimeConfig({ PORT: "99999" }).port, 3000);
});

test("the websocket payload cap matches the documented message limit", () => {
	assert.equal(MAX_WEBSOCKET_MESSAGE_BYTES, 4096);
});
