import { join } from "path";

import maxmind from "maxmind";

const defaultDatabasePath = join(process.cwd(), "database", "country.mmdb");
let lookup = null;

async function initializeCountryLookup(
	databasePath = defaultDatabasePath,
	onError = () => {},
) {
	try {
		lookup = await maxmind.open(databasePath);
		return true;
	} catch (error) {
		lookup = null;
		onError(error);
		return false;
	}
}

function getCountry(ip) {
	if (!lookup || !ip) return null;

	try {
		return lookup.get(ip)?.country?.iso_code || null;
	} catch {
		return null;
	}
}

function resetCountryLookup() {
	lookup = null;
}

export { getCountry, initializeCountryLookup, resetCountryLookup };
