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

function normalizeOrigin(value) {
	if (!value || typeof value !== "string") return null;
	try {
		return new URL(value).origin;
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
	isRequestOriginAllowed,
	normalizeOrigin,
};
