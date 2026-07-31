import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	distributeVttCues,
	formatVttSegment,
	packageVttHls,
	parseVttCues,
	parseVttDocument,
	parseVttTimestamp,
} from "../scripts/package-vtt-hls.mjs";

test("WebVTT cues crossing HLS boundaries keep their complete timing", () => {
	const cues = parseVttCues(`WEBVTT

00:00:04.000 --> 00:00:08.000 line:88%
Across the boundary
`);
	const segments = distributeVttCues(cues, [6, 6]);

	assert.equal(segments[0].cues.length, 1);
	assert.equal(segments[1].cues.length, 1);
	for (const segment of segments) {
		assert.equal(segment.cues[0].start, 4);
		assert.equal(segment.cues[0].end, 8);
		const output = formatVttSegment(segment, 1.5);
		assert.match(
			output,
			/X-TIMESTAMP-MAP=LOCAL:00:00:00\.000,MPEGTS:135000/,
		);
		assert.match(
			output,
			/00:00:04\.000 --> 00:00:08\.000 line:88%/,
		);
	}
});

test("WebVTT accepts timestamps without hours and validates clock ranges", () => {
	assert.equal(parseVttTimestamp("01:02.345"), 62.345);
	assert.equal(parseVttTimestamp("10:01:02.345"), 36062.345);
	assert.throws(
		() => parseVttTimestamp("01:60.000"),
		/Invalid WebVTT timestamp/,
	);
	assert.throws(
		() => parseVttTimestamp("1:02:03.000"),
		/Invalid WebVTT timestamp/,
	);
});

test("WebVTT segment preserves metadata, STYLE and REGION blocks", () => {
	const document = parseVttDocument(`WEBVTT
Kind: captions
Language: ru
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

STYLE
::cue { color: white; }

REGION
id:bottom
width:80%

00:01.000 --> 00:02.000 region:bottom
Styled cue
`);
	const [segment] = distributeVttCues(document.cues, [5]);
	const output = formatVttSegment(segment, 2, document);

	assert.match(output, /^WEBVTT\nKind: captions\nLanguage: ru\n/);
	assert.match(
		output,
		/X-TIMESTAMP-MAP=LOCAL:00:00:00\.000,MPEGTS:180000/,
	);
	assert.equal(
		(output.match(/X-TIMESTAMP-MAP=/g) || []).length,
		1,
	);
	assert.match(output, /\nSTYLE\n::cue \{ color: white; \}\n\n/);
	assert.match(output, /\nREGION\nid:bottom\nwidth:80%\n\n/);
});

test("WebVTT rejects malformed and reversed cue timings", () => {
	assert.throws(
		() => parseVttCues(`WEBVTT

00:01.000 --> bad
Broken
`),
		/Invalid WebVTT cue timing/,
	);
	assert.throws(
		() => parseVttCues(`WEBVTT

00:02.000 --> 00:01.000
Backwards
`),
		/end must be after its start/,
	);
	assert.throws(
		() => formatVttSegment({ cues: [] }, -1),
		/unsigned 33-bit/,
	);
});

test("packager rejects cues entirely outside the video playlist", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dcote-vtt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const videoPlaylistPath = join(directory, "video.m3u8");
	const sourceVttPath = join(directory, "source.vtt");
	const outputPlaylistPath = join(directory, "subtitles.m3u8");
	await Promise.all([
		writeFile(videoPlaylistPath, "#EXTM3U\n#EXTINF:5.0,\nvideo.ts\n"),
		writeFile(
			sourceVttPath,
			"WEBVTT\n\n00:06.000 --> 00:07.000\nOutside\n",
		),
	]);

	await assert.rejects(
		packageVttHls({
			videoPlaylistPath,
			sourceVttPath,
			outputPlaylistPath,
			segmentPrefix: "sub_",
			ptsOffsetSeconds: 0,
		}),
		/lies outside/,
	);
	await assert.rejects(readFile(outputPlaylistPath), /ENOENT/);
});

test("packager publishes prepared files and removes stale segments", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dcote-vtt-publish-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const videoPlaylistPath = join(directory, "video.m3u8");
	const sourceVttPath = join(directory, "source.vtt");
	const outputPlaylistPath = join(directory, "subtitles.m3u8");
	await Promise.all([
		writeFile(
			videoPlaylistPath,
			"#EXTM3U\n#EXTINF:1.0,\na.ts\n#EXTINF:1.0,\nb.ts\n",
		),
		writeFile(
			sourceVttPath,
			"WEBVTT\n\n00:00.100 --> 00:00.200\nInside\n",
		),
		writeFile(join(directory, "sub_9999.vtt"), "stale"),
	]);

	const firstResult = await packageVttHls({
		videoPlaylistPath,
		sourceVttPath,
		outputPlaylistPath,
		segmentPrefix: "sub_",
		ptsOffsetSeconds: 0,
	});
	assert.equal(firstResult.segmentCount, 2);
	assert.equal(firstResult.removedStaleSegmentCount, 1);
	assert.match(await readFile(outputPlaylistPath, "utf8"), /sub_0001\.vtt/);

	await writeFile(
		videoPlaylistPath,
		"#EXTM3U\n#EXTINF:1.0,\na.ts\n",
	);
	const secondResult = await packageVttHls({
		videoPlaylistPath,
		sourceVttPath,
		outputPlaylistPath,
		segmentPrefix: "sub_",
		ptsOffsetSeconds: 0,
	});
	assert.equal(secondResult.segmentCount, 1);
	assert.equal(secondResult.removedStaleSegmentCount, 1);
	assert.doesNotMatch(
		await readFile(outputPlaylistPath, "utf8"),
		/sub_0001\.vtt/,
	);
	await assert.rejects(
		readFile(join(directory, "sub_0001.vtt")),
		/ENOENT/,
	);
});

test("packager rejects segment prefixes that can escape the output directory", async () => {
	await assert.rejects(
		packageVttHls({
			videoPlaylistPath: "unused.m3u8",
			sourceVttPath: "unused.vtt",
			outputPlaylistPath: "unused-output.m3u8",
			segmentPrefix: "../sub_",
			ptsOffsetSeconds: 0,
		}),
		/filename prefix/,
	);
});
