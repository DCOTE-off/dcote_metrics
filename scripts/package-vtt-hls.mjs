import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EPSILON = 0.001;

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateSegmentPrefix(segmentPrefix) {
	if (
		typeof segmentPrefix !== "string"
		|| !segmentPrefix
		|| /[\\/\0]/.test(segmentPrefix)
	) {
		throw new Error("segmentPrefix must be a non-empty filename prefix");
	}
}

export function parseVttTimestamp(timestamp) {
	const match = timestamp.match(
		/^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/,
	);
	if (!match) throw new Error(`Invalid WebVTT timestamp: ${timestamp}`);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	if (minutes > 59 || seconds > 59) {
		throw new Error(`Invalid WebVTT timestamp: ${timestamp}`);
	}
	return (
		Number(match[1] || 0) * 3600
		+ minutes * 60
		+ seconds
		+ Number(match[4]) / 1000
	);
}

export function formatVttTimestamp(seconds) {
	const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
	const hours = Math.floor(totalMilliseconds / 3_600_000);
	const minutes = Math.floor(totalMilliseconds / 60_000) % 60;
	const wholeSeconds = Math.floor(totalMilliseconds / 1000) % 60;
	const milliseconds = totalMilliseconds % 1000;
	return [
		String(hours).padStart(2, "0"),
		String(minutes).padStart(2, "0"),
		`${String(wholeSeconds).padStart(2, "0")}.${
			String(milliseconds).padStart(3, "0")
		}`,
	].join(":");
}

export function parseVttDocument(source) {
	const normalized = source
		.replace(/^\uFEFF/, "")
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n");
	const blocks = normalized.split(/\n[ \t]*\n/);
	const signatureLines = blocks.shift()?.split("\n") || [];
	if (!/^WEBVTT(?:[ \t].*)?$/.test(signatureLines[0] || "")) {
		throw new Error("Invalid WebVTT signature");
	}
	const headerLines = signatureLines
		.slice(1)
		.filter((line) => !/^X-TIMESTAMP-MAP=/i.test(line.trim()));
	const headerBlocks = [];
	let encounteredCue = false;
	const timestampToken = String.raw`(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}`;
	const timingPattern =
		new RegExp(`^(${timestampToken})[ \\t]+-->[ \\t]+(${timestampToken})(.*)$`);
	const cues = [];

	for (const rawBlock of blocks) {
		if (!rawBlock.trim()) continue;
		const lines = rawBlock.split("\n");
		const timingIndex = lines.findIndex((line) => timingPattern.test(line));
		if (timingIndex < 0) {
			if (lines.some((line) => line.includes("-->"))) {
				throw new Error(`Invalid WebVTT cue timing: ${lines.join(" ")}`);
			}
			if (/^(STYLE|REGION)(?:[ \t]|$)/.test(lines[0])) {
				if (encounteredCue) {
					throw new Error(
						`${lines[0].split(/[ \t]/, 1)[0]} block must precede cues`,
					);
				}
				headerBlocks.push(rawBlock.trimEnd());
			} else if (!encounteredCue && /^NOTE(?:[ \t]|$)/.test(lines[0])) {
				headerBlocks.push(rawBlock.trimEnd());
			}
			continue;
		}
		encounteredCue = true;
		const timing = lines[timingIndex].match(timingPattern);
		const text = lines.slice(timingIndex + 1).join("\n").trimEnd();

		const start = parseVttTimestamp(timing[1]);
		const end = parseVttTimestamp(timing[2]);
		if (end <= start) {
			throw new Error(
				`WebVTT cue end must be after its start: ${timing[0]}`,
			);
		}
		cues.push({
			id: lines.slice(0, timingIndex).join("\n").trim(),
			start,
			end,
			settings: timing[3].trimEnd(),
			text,
		});
	}

	if (!cues.length) throw new Error("No WebVTT cues were found");
	cues.sort((left, right) =>
		left.start - right.start
		|| left.end - right.end
		|| left.text.localeCompare(right.text)
	);
	return { cues, headerBlocks, headerLines };
}

export function parseVttCues(source) {
	return parseVttDocument(source).cues;
}

export function parseHlsDurations(playlist) {
	const durations = playlist
		.split(/\r?\n/)
		.filter((line) => line.startsWith("#EXTINF:"))
		.map((line) => Number(line.slice(8).split(",", 1)[0]));
	if (!durations.length || durations.some((duration) => !(duration > 0))) {
		throw new Error("The video playlist has no valid #EXTINF durations");
	}
	return durations;
}

export function distributeVttCues(cues, durations) {
	let segmentStart = 0;
	const segments = durations.map((duration, index) => {
		const start = segmentStart;
		const end = start + duration;
		segmentStart = end;
		return { index, start, end, duration, cues: [] };
	});
	const playlistDuration = segmentStart;
	if (cues.length && !segments.length) {
		throw new Error("The video playlist has no segment to place cues into");
	}

	for (const cue of cues) {
		// RFC 8216 §3.5: каждый сегмент содержит полную реплику,
		// предназначенную для показа в его периоде. Время не обрезается.
		const overlapping = segments.filter((segment) =>
			cue.start < segment.end - EPSILON
			&& cue.end > segment.start + EPSILON
		);
		if (overlapping.length) {
			for (const segment of overlapping) segment.cues.push(cue);
			continue;
		}
		// Реплика короче EPSILON или лежащая ровно на стыке сегментов
		// не перекрывает ни один период с запасом. Она обязана попасть
		// в сегмент по своей середине, а не исчезнуть без следа.
		const midpoint = Math.min(
			Math.max((cue.start + cue.end) / 2, 0),
			Math.max(playlistDuration - EPSILON, 0),
		);
		const fallback = segments.find(
			(segment) => midpoint >= segment.start && midpoint < segment.end,
		) || segments.at(-1);
		fallback.cues.push(cue);
	}
	return segments;
}

export function formatVttSegment(
	segment,
	ptsOffsetSeconds,
	documentMetadata = {},
) {
	const mpegTimestamp = Math.round(ptsOffsetSeconds * 90000);
	if (
		!Number.isFinite(mpegTimestamp)
		|| mpegTimestamp < 0
		|| mpegTimestamp > 0x1ffffffff
	) {
		throw new Error("WebVTT MPEGTS offset must fit in an unsigned 33-bit value");
	}
	const headerLines = Array.isArray(documentMetadata)
		? []
		: documentMetadata.headerLines || [];
	const headerBlocks = Array.isArray(documentMetadata)
		? documentMetadata
		: documentMetadata.headerBlocks || [];
	const lines = [
		"WEBVTT",
		...headerLines,
		`X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${mpegTimestamp}`,
		"",
	];
	for (const block of headerBlocks) lines.push(block, "");
	for (const cue of segment.cues) {
		if (cue.id) lines.push(cue.id);
		lines.push(
			`${formatVttTimestamp(cue.start)} --> ${
				formatVttTimestamp(cue.end)
			}${cue.settings}`,
		);
		lines.push(cue.text, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export async function packageVttHls({
	videoPlaylistPath,
	sourceVttPath,
	outputPlaylistPath,
	segmentPrefix,
	ptsOffsetSeconds,
}) {
	validateSegmentPrefix(segmentPrefix);
	const [videoPlaylist, sourceVtt] = await Promise.all([
		readFile(videoPlaylistPath, "utf8"),
		readFile(sourceVttPath, "utf8"),
	]);
	const durations = parseHlsDurations(videoPlaylist);
	const vttDocument = parseVttDocument(sourceVtt);
	const { cues } = vttDocument;
	const playlistDuration = durations.reduce(
		(total, duration) => total + duration,
		0,
	);
	const outsideCue = cues.find((cue) =>
		cue.end <= EPSILON || cue.start >= playlistDuration - EPSILON
	);
	if (outsideCue) {
		throw new Error(
			`WebVTT cue lies outside the ${playlistDuration.toFixed(3)}s playlist: `
			+ `${formatVttTimestamp(outsideCue.start)} --> `
			+ formatVttTimestamp(outsideCue.end),
		);
	}
	const segments = distributeVttCues(cues, durations);
	const placedCues = new Set(segments.flatMap((segment) => segment.cues));
	const droppedCues = cues.filter((cue) => !placedCues.has(cue));
	if (droppedCues.length) {
		const [first] = droppedCues;
		throw new Error(
			`${droppedCues.length} WebVTT cue(s) reached no segment, `
			+ `starting at ${formatVttTimestamp(first.start)} --> `
			+ formatVttTimestamp(first.end),
		);
	}
	const outputDirectory = dirname(outputPlaylistPath);
	await mkdir(outputDirectory, { recursive: true });
	const temporaryDirectory = await mkdtemp(
		join(outputDirectory, ".vtt-hls-"),
	);

	const width = Math.max(4, String(segments.length - 1).length);
	const segmentFilenames = segments.map((segment) =>
		`${segmentPrefix}${String(segment.index).padStart(width, "0")}.vtt`
	);
	const playlistLines = [
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
		"#EXT-X-MEDIA-SEQUENCE:0",
	];
	try {
		for (const [index, segment] of segments.entries()) {
			const filename = segmentFilenames[index];
			await writeFile(
				join(temporaryDirectory, filename),
				formatVttSegment(segment, ptsOffsetSeconds, vttDocument),
				"utf8",
			);
			playlistLines.push(
				`#EXTINF:${segment.duration.toFixed(6)},`,
				filename,
			);
		}
		playlistLines.push("#EXT-X-ENDLIST");
		const temporaryPlaylistPath = join(
			temporaryDirectory,
			basename(outputPlaylistPath),
		);
		await writeFile(
			temporaryPlaylistPath,
			`${playlistLines.join("\n")}\n`,
			"utf8",
		);

		for (const filename of segmentFilenames) {
			await rename(
				join(temporaryDirectory, filename),
				join(outputDirectory, filename),
			);
		}
		// Плейлист публикуется последним: он никогда не ссылается на ещё
		// не подготовленные сегменты.
		await rename(temporaryPlaylistPath, outputPlaylistPath);

		const currentFilenames = new Set(segmentFilenames);
		const segmentPattern = new RegExp(
			`^${escapeRegExp(segmentPrefix)}\\d+\\.vtt$`,
		);
		const staleFilenames = (await readdir(outputDirectory))
			.filter((filename) =>
				segmentPattern.test(filename)
				&& !currentFilenames.has(filename)
			);
		await Promise.all(
			staleFilenames.map((filename) =>
				rm(join(outputDirectory, filename), { force: true })
			),
		);
		return {
			cueCount: cues.length,
			removedStaleSegmentCount: staleFilenames.length,
			segmentCount: segments.length,
			segmentCueCount: segments.reduce(
				(total, segment) => total + segment.cues.length,
				0,
			),
		};
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function readArguments(argv) {
	const options = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || value === undefined) {
			throw new Error(`Invalid argument near ${name || "<empty>"}`);
		}
		options.set(name.slice(2), value);
	}
	const required = ["video-playlist", "source-vtt", "output-playlist"];
	for (const name of required) {
		if (!options.has(name)) throw new Error(`Missing --${name}`);
	}
	const outputPlaylistPath = resolve(options.get("output-playlist"));
	const defaultPrefix =
		`${basename(outputPlaylistPath, ".m3u8").replace(/_split$/, "")}_split_`;
	const ptsOffsetSeconds = Number(options.get("pts-offset") ?? 0);
	if (!Number.isFinite(ptsOffsetSeconds)) {
		throw new Error("--pts-offset must be a finite number");
	}
	return {
		videoPlaylistPath: resolve(options.get("video-playlist")),
		sourceVttPath: resolve(options.get("source-vtt")),
		outputPlaylistPath,
		segmentPrefix: options.get("segment-prefix") || defaultPrefix,
		ptsOffsetSeconds,
	};
}

const isMain = process.argv[1]
	&& resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = await packageVttHls(readArguments(process.argv.slice(2)));
		console.log(
			`Created ${result.segmentCount} WebVTT segments from `
			+ `${result.cueCount} cues (${result.segmentCueCount} cue entries).`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
