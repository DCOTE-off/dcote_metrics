import { timingSafeEqual } from "crypto";

function createBoundedKeySet(limit) {
	const keys = new Set();

	return {
		accept(key) {
			if (keys.has(key)) return true;
			if (keys.size >= limit) return false;
			keys.add(key);
			return true;
		},
		has: (key) => keys.has(key),
		get size() {
			return keys.size;
		},
		clear: () => keys.clear(),
	};
}

function createFixedWindowRateLimiter({ limit, windowMs, maxKeys }) {
	const entries = new Map();
	let checksUntilCleanup = 500;

	function cleanup(now) {
		for (const [key, entry] of entries) {
			if (entry.resetAt <= now) entries.delete(key);
		}
	}

	return {
		allow(key, now = Date.now()) {
			checksUntilCleanup -= 1;
			if (checksUntilCleanup <= 0) {
				cleanup(now);
				checksUntilCleanup = 500;
			}

			const existing = entries.get(key);
			if (!existing || existing.resetAt <= now) {
				if (!existing && entries.size >= maxKeys) {
					cleanup(now);
					if (entries.size >= maxKeys) return false;
				}
				entries.set(key, { count: 1, resetAt: now + windowMs });
				return true;
			}

			if (existing.count >= limit) return false;
			existing.count += 1;
			return true;
		},
		clear: () => entries.clear(),
		get size() {
			return entries.size;
		},
	};
}

function tokensMatch(candidate, expected) {
	if (!candidate || !expected) return false;
	const candidateBuffer = Buffer.from(candidate);
	const expectedBuffer = Buffer.from(expected);
	return candidateBuffer.length === expectedBuffer.length
		&& timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isBearerTokenAuthenticated(req, token) {
	const authorization = req.headers.authorization;
	if (typeof authorization !== "string") return false;
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return tokensMatch(match?.[1], token);
}

function normalizeOrigin(value) {
	if (!value || typeof value !== "string") return null;
	try {
		const { origin } = new URL(value);
		// Opaque-контексты (file:, data:, blob:) дают строковый "null",
		// который иначе осел бы в allowlist как обычный источник.
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

function isRequestOriginAllowed(req, allowedOrigins) {
	const rawOrigin = req.headers.origin;
	if (!rawOrigin) return false;
	const origin = normalizeOrigin(rawOrigin);
	return Boolean(origin && allowedOrigins.has(origin));
}

function getSeriesKey(labels, labelNames) {
	return labelNames.map((name) => labels[name]).join("\u0000");
}

export {
	createBoundedKeySet,
	createFixedWindowRateLimiter,
	getSeriesKey,
	isBearerTokenAuthenticated,
	isRequestOriginAllowed,
	normalizeOrigin,
	tokensMatch,
};
