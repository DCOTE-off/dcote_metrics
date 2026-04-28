import { join } from "path";

import maxmind from "maxmind";

const mmdbPath = join(process.cwd(), "database", "country.mmdb");

const lookup = await maxmind.open(mmdbPath);

export function getCountry(ip) {
	const result = lookup.get(ip);
	return result?.country?.iso_code;
}
