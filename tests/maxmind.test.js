import assert from "node:assert/strict";
import test from "node:test";

import {
	getCountry,
	initializeCountryLookup,
	resetCountryLookup,
} from "../src/metrics/maxmind.js";

test("missing country database degrades to the fallback label", async (t) => {
	t.after(resetCountryLookup);
	let reportedError = null;
	const initialized = await initializeCountryLookup(
		"Z:/missing/country.mmdb",
		(error) => { reportedError = error; },
	);
	assert.equal(initialized, false);
	assert.ok(reportedError);
	assert.equal(getCountry("127.0.0.1"), null);
});
