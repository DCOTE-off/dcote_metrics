// Subtitle selection, WebVTT presentation, and lazy ASS rendering.
// Shared player configuration and lifecycle globals are initialized by player.js.
const ASS_RENDERER_IDLE_TIMEOUT_MS = 30000;
const ASS_MAX_RENDER_HEIGHT = 1080;
const assSubtitles = {
	active: false,
	bottomMargin: null,
	bottomMarginPercent: 0,
	canvas: null,
	content: null,
	destroyTimerId: null,
	error: null,
	forced: null,
	animationFrameId: null,
	frameCallbackId: null,
	generation: 0,
	label: "",
	language: "ru",
	loadPromise: null,
	player: null,
	ready: false,
	renderer: null,
	resizeObserver: null,
	selected: false,
	status: "disabled",
	trackId: "",
	url: "",
	video: null,
};
const subtitleMetric = {
	activeSeconds: 0,
	activeStartedAt: null,
	eventId: createMetricEventId("subtitles"),
	sent: false,
	thresholdSeconds: VIEW_METRIC_THRESHOLD_SECONDS,
	timerId: null,
};
// ASS является основным рендером, а HLS WebVTT остаётся совместимым fallback.
// JASSUB загружается только после выбора подходящей дорожки и не получает video:
// кадры отправляются вручную, поэтому выключенный canvas не продолжает рендер.
function positionUnpositionedVttCues(cues) {
	for (const cue of cues) {
		const hasRegion = Boolean(cue.region?.id);
		if (cue.line != null || hasRegion) continue;

		cue.line = defaultVttBottomLine;
		cue.lineInterpretation =
			shaka.text.Cue.lineInterpretation.PERCENTAGE;
		cue.lineAlign = shaka.text.Cue.lineAlign.END;
	}
	return cues;
}
const textDisplayerPresentation = {
	mode: null,
};
function createPositionedTextDisplayer(player, mode) {
	let displayer;
	if (
		mode === "native"
		&& "track" in document.createElement("track")
	) {
		displayer = new shaka.text.NativeTextDisplayer(player);
	} else if (mode === "ui") {
		displayer = new shaka.text.UITextDisplayer(player);
	} else {
		displayer = new shaka.text.StubTextDisplayer();
	}
	const append = displayer.append.bind(displayer);
	displayer.append = (cues) => {
		append(positionUnpositionedVttCues(cues));
	};
	return displayer;
}
function getPresentationTextDisplayerMode(player, video) {
	const usesNativePresentation =
		document.pictureInPictureElement === video
		|| document.fullscreenElement === video
		|| video?.webkitDisplayingFullscreen
		|| (
			video?.webkitPresentationMode
			&& video.webkitPresentationMode !== "inline"
		)
		|| (
			typeof player?.isRemotePlayback === "function"
			&& player.isRemotePlayback()
		)
		|| (
			video?.remote?.state
			&& video.remote.state !== "disconnected"
		);
	return usesNativePresentation ? "native" : "ui";
}
function syncPresentationTextDisplayer(player, video, force = false) {
	const mode = getPresentationTextDisplayerMode(player, video);
	if (!force && textDisplayerPresentation.mode === mode) return;
	textDisplayerPresentation.mode = mode;
	player.configure({
		textDisplayFactory: (textPlayer) =>
			createPositionedTextDisplayer(textPlayer, mode),
	});
}
function configurePresentationTextDisplayerLifecycle(player, video) {
	const syncPresentation = () => {
		syncPresentationTextDisplayer(player, video);
		if (!assSubtitles.url) return;
		updateAssCanvasLayout(video);
		syncAssSubtitleVisibility(player);
	};

	[
		"enterpictureinpicture",
		"leavepictureinpicture",
		"webkitbeginfullscreen",
		"webkitendfullscreen",
		"webkitpresentationmodechanged",
	].forEach((eventName) => {
		listen(video, eventName, syncPresentation);
	});
	listen(document, "fullscreenchange", syncPresentation);
	if (video.remote) {
		["connecting", "connect", "disconnect"].forEach((eventName) => {
			listen(video.remote, eventName, syncPresentation);
		});
	}
	syncPresentationTextDisplayer(player, video, true);
}
function getActiveTextTrack(player) {
	if (!player || typeof player.getTextTracks !== "function") {
		return null;
	}
	return player.getTextTracks().find((track) => track.active) || null;
}
function normalizeSubtitleTrackValue(value) {
	return String(value || "").trim().toLowerCase();
}
function isAssTextTrackSelected(player) {
	const activeTrack = getActiveTextTrack(player);
	if (!activeTrack) return false;
	const hasStableSelector = Boolean(
		assSubtitles.trackId || assSubtitles.label,
	);

	if (
		assSubtitles.trackId
		&& String(activeTrack.id) !== assSubtitles.trackId
	) {
		return false;
	}
	if (
		assSubtitles.label
		&& normalizeSubtitleTrackValue(activeTrack.label)
			!== normalizeSubtitleTrackValue(assSubtitles.label)
	) {
		return false;
	}
	if (
		assSubtitles.forced !== null
		&& Boolean(activeTrack.forced) !== assSubtitles.forced
	) {
		return false;
	}
	if (hasStableSelector) return true;

	const activeLanguage = (activeTrack.language || "")
		.split("-")[0]
		.toLowerCase();
	return (
		!assSubtitles.language ||
		!activeLanguage ||
		activeLanguage === "und" ||
		activeLanguage === assSubtitles.language
	);
}
function canRenderAssInCurrentPresentation(player, video) {
	if (!video) return false;
	if (document.pictureInPictureElement === video) return false;
	if (document.fullscreenElement === video) return false;
	if (video.webkitDisplayingFullscreen) return false;
	if (
		video.webkitPresentationMode
		&& video.webkitPresentationMode !== "inline"
	) {
		return false;
	}
	if (
		typeof player?.isRemotePlayback === "function"
		&& player.isRemotePlayback()
	) {
		return false;
	}
	return !video.remote?.state || video.remote.state === "disconnected";
}
function clearAssDestroyTimer() {
	clearTimeout(assSubtitles.destroyTimerId);
	assSubtitles.destroyTimerId = null;
}
function cancelAssVideoFrame() {
	const video = assSubtitles.video;
	const frameCallbackId = assSubtitles.frameCallbackId;
	const animationFrameId = assSubtitles.animationFrameId;
	assSubtitles.frameCallbackId = null;
	assSubtitles.animationFrameId = null;
	if (
		frameCallbackId !== null
		&& typeof video?.cancelVideoFrameCallback === "function"
	) {
		video.cancelVideoFrameCallback(frameCallbackId);
	}
	if (animationFrameId !== null) {
		cancelAnimationFrame(animationFrameId);
	}
}
function updateAssCanvasLayout(video) {
	const canvas = assSubtitles.canvas;
	if (!canvas || !video) return;

	const elementWidth = video.clientWidth;
	const elementHeight = video.clientHeight;
	const videoWidth = video.videoWidth;
	const videoHeight = video.videoHeight;
	if (!elementWidth || !elementHeight || !videoWidth || !videoHeight) return;

	const elementRatio = elementWidth / elementHeight;
	const videoRatio = videoWidth / videoHeight;
	let width = elementWidth;
	let height = elementHeight;
	if (elementRatio > videoRatio) {
		width = elementHeight * videoRatio;
	} else {
		height = elementWidth / videoRatio;
	}

	canvas.style.left = `${video.offsetLeft + (elementWidth - width) / 2}px`;
	canvas.style.top = `${video.offsetTop + (elementHeight - height) / 2}px`;
	canvas.style.width = `${width}px`;
	canvas.style.height = `${height}px`;
}
function renderCurrentAssFrame(repaint = false) {
	const renderer = assSubtitles.renderer;
	const video = assSubtitles.video;
	if (
		!assSubtitles.active
		|| !renderer
		|| !video
		|| !video.videoWidth
		|| !video.videoHeight
	) {
		return;
	}
	void renderer.manualRender({
		expectedDisplayTime: performance.now(),
		height: video.videoHeight,
		mediaTime: video.currentTime,
		width: video.videoWidth,
	}, repaint).catch((error) => {
		console.warn("Unable to render the current ASS frame.", error);
	});
}
function requestNextAssVideoFrame() {
	const renderer = assSubtitles.renderer;
	const video = assSubtitles.video;
	if (
		!assSubtitles.active
		|| !renderer
		|| !video
		|| assSubtitles.frameCallbackId !== null
		|| assSubtitles.animationFrameId !== null
	) {
		return;
	}

	if (typeof video.requestVideoFrameCallback === "function") {
		assSubtitles.frameCallbackId = video.requestVideoFrameCallback(
			(_now, metadata) => {
				assSubtitles.frameCallbackId = null;
				if (
					!assSubtitles.active
					|| assSubtitles.renderer !== renderer
				) {
					return;
				}
				void renderer.manualRender(metadata).catch((error) => {
					console.warn("Unable to render an ASS video frame.", error);
				});
				requestNextAssVideoFrame();
			},
		);
		return;
	}

	if (video.paused || video.ended) return;
	assSubtitles.animationFrameId = requestAnimationFrame(() => {
		assSubtitles.animationFrameId = null;
		if (
			!assSubtitles.active
			|| assSubtitles.renderer !== renderer
		) {
			return;
		}
		renderCurrentAssFrame();
		requestNextAssVideoFrame();
	});
}
function startAssRendering() {
	clearAssDestroyTimer();
	if (assSubtitles.active) return;
	assSubtitles.active = true;
	updateAssCanvasLayout(assSubtitles.video);
	renderCurrentAssFrame(true);
	requestNextAssVideoFrame();
}
function stopAssRendering() {
	assSubtitles.active = false;
	cancelAssVideoFrame();
}
async function destroyAssRenderer(nextStatus = "idle") {
	assSubtitles.generation += 1;
	clearAssDestroyTimer();
	stopAssRendering();
	assSubtitles.resizeObserver?.disconnect();
	assSubtitles.resizeObserver = null;

	const renderer = assSubtitles.renderer;
	const canvas = assSubtitles.canvas;
	assSubtitles.renderer = null;
	assSubtitles.canvas = null;
	assSubtitles.ready = false;
	assSubtitles.loadPromise = null;
	assSubtitles.status = nextStatus;
	updateSubtitleDebugLabel(assSubtitles.player);

	try {
		await renderer?.destroy();
	} catch {
		// Canvas всё равно удаляется ниже, а новый renderer сможет запуститься.
	}
	canvas?.remove();
}
function scheduleAssRendererDestroy() {
	if (
		!assSubtitles.ready
		|| assSubtitles.active
		|| assSubtitles.destroyTimerId
	) {
		return;
	}
	assSubtitles.destroyTimerId = setTimeout(() => {
		assSubtitles.destroyTimerId = null;
		if (!assSubtitles.active) {
			void destroyAssRenderer();
		}
	}, ASS_RENDERER_IDLE_TIMEOUT_MS);
}
function syncAssSubtitleVisibility(player) {
	const container = document.getElementById("player-container");
	const video = assSubtitles.video;
	const selected = isAssTextTrackSelected(player);
	const canRender = canRenderAssInCurrentPresentation(player, video);
	const canvas = assSubtitles.canvas;
	const shouldShow =
		assSubtitles.ready &&
		canvas &&
		selected &&
		canRender;

	if (canvas) {
		canvas.style.visibility = shouldShow ? "visible" : "hidden";
	}
	if (shouldShow) {
		startAssRendering();
	} else {
		stopAssRendering();
		scheduleAssRendererDestroy();
	}
	container.classList.toggle("ass-subtitles-active", Boolean(shouldShow));
	container.dataset.subtitleRenderer = shouldShow
		? "ass"
		: getActiveTextTrack(player)
			? "vtt"
			: "off";

	if (!selected && assSubtitles.selected && assSubtitles.status === "error") {
		assSubtitles.status = "idle";
		assSubtitles.error = null;
	}
	assSubtitles.selected = selected;
	if (
		selected
		&& canRender
		&& assSubtitles.status === "idle"
		&& !assSubtitles.loadPromise
	) {
		void ensureAssSubtitlesReady();
	}
	updateSubtitleDebugLabel(player);
}
function updateSubtitleDebugLabel(player) {
	if (playerParams.get("subtitle_debug") !== "1") return;

	let label = document.getElementById("subtitle-debug-label");
	if (!label) {
		label = document.createElement("div");
		label.id = "subtitle-debug-label";
		Object.assign(label.style, {
			position: "fixed",
			top: "8px",
			left: "8px",
			zIndex: "1000",
			padding: "6px 8px",
			background: "rgba(0, 0, 0, 0.8)",
			color: "#fff",
			font: "12px monospace",
			pointerEvents: "none",
		});
		document.body.appendChild(label);
	}

	label.textContent = [
		`renderer=${document.getElementById("player-container").dataset.subtitleRenderer || "vtt"}`,
		`ass=${assSubtitles.status}`,
		`captions=${getActiveTextTrack(player) ? "on" : "off"}`,
		`margin=${assSubtitles.bottomMargin ?? "-"}`,
		assSubtitles.error ? `error=${assSubtitles.error}` : "",
	]
		.filter(Boolean)
		.join(" | ");
}
// По умолчанию авторский ASS передаётся в libass без изменений. Изменение
// нижнего MarginV остаётся только явной совместимой опцией query-параметра.
function applyBottomMarginToAssStyles(subContent, bottomMarginPercent) {
	const percent = Math.min(
		40,
		Math.max(0, Number(bottomMarginPercent) || 0),
	);
	if (!percent) return subContent;

	const lines = subContent.split(/\r?\n/);
	const playResYLine = lines.find((line) =>
		/^PlayResY\s*:/i.test(line),
	);
	const playResY = Number(playResYLine?.split(":")[1]) || 360;
	const minimumMargin = Math.round((playResY * percent) / 100);
	assSubtitles.bottomMargin = minimumMargin;
	let section = "";
	let styleFormat = [];

	return lines
		.map((line) => {
			const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
			if (sectionMatch) {
				section = sectionMatch[1].toLowerCase();
				return line;
			}
			if (section !== "v4+ styles") return line;

			const formatMatch = line.match(/^\s*Format\s*:\s*(.+)$/i);
			if (formatMatch) {
				styleFormat = formatMatch[1]
					.split(",")
					.map((field) => field.trim().toLowerCase());
				return line;
			}

			const styleMatch = line.match(/^(\s*Style\s*:\s*)(.+)$/i);
			if (!styleMatch || !styleFormat.length) return line;

			const fields = styleMatch[2].split(",");
			const alignmentIndex = styleFormat.indexOf("alignment");
			const marginVIndex = styleFormat.indexOf("marginv");
			const alignment = Number(fields[alignmentIndex]);
			if (
				!Number.isInteger(alignment) ||
				alignment < 1 ||
				alignment > 3 ||
				marginVIndex < 0
			) {
				return line;
			}

			const currentMargin = Number(fields[marginVIndex]) || 0;
			fields[marginVIndex] = String(
				Math.max(currentMargin, minimumMargin),
			);
			return styleMatch[1] + fields.join(",");
		})
		.join("\n");
}
async function ensureAssSubtitlesReady() {
	if (
		assSubtitles.ready
		|| assSubtitles.loadPromise
		|| assSubtitles.status === "error"
		|| !assSubtitles.url
	) {
		return assSubtitles.loadPromise;
	}

	const generation = ++assSubtitles.generation;
	let canvas = null;
	let renderer = null;
	const loadPromise = (async () => {
		assSubtitles.status = "loading";
		assSubtitles.error = null;
		updateSubtitleDebugLabel(assSubtitles.player);

		if (!assSubtitles.content) {
			const subtitleResponse = await fetch(assSubtitles.url);
			if (!subtitleResponse.ok) {
				throw new Error(
					`ASS request failed with status ${subtitleResponse.status}`,
				);
			}
			assSubtitles.content = await subtitleResponse.text();
		}
		if (
			playerLifecycle.destroyed
			|| generation !== assSubtitles.generation
		) {
			return;
		}

		const subContent = applyBottomMarginToAssStyles(
			assSubtitles.content,
			assSubtitles.bottomMarginPercent,
		);
		const { default: JASSUB } = await import(
			`${playerAssetBase}/vendor/jassub/jassub.js?v=${jassubAssetVersion}`
		);
		if (
			playerLifecycle.destroyed
			|| generation !== assSubtitles.generation
		) {
			return;
		}

		const subtitleFontUrl =
			`${playerAssetBase}/fonts/vag-rounded-next-bold.woff2`
			+ `?v=${subtitleFontAssetVersion}`;
		canvas = document.createElement("canvas");
		canvas.className = "JASSUB";
		canvas.style.position = "absolute";
		canvas.style.pointerEvents = "none";
		canvas.style.visibility = "hidden";
		canvas.setAttribute("aria-hidden", "true");
		assSubtitles.video.insertAdjacentElement("afterend", canvas);
		assSubtitles.canvas = canvas;
		updateAssCanvasLayout(assSubtitles.video);

		renderer = new JASSUB({
			canvas,
			subContent,
			workerUrl:
				`${playerAssetBase}/vendor/jassub/jassub-worker.js?v=${jassubAssetVersion}`,
			wasmUrl:
				`${playerAssetBase}/vendor/jassub/jassub-worker.wasm?v=${jassubAssetVersion}`,
			modernWasmUrl:
				`${playerAssetBase}/vendor/jassub/jassub-worker-modern.wasm?v=${jassubAssetVersion}`,
			// Initial fonts are awaited by JASSUB before renderer.ready resolves.
			// Keeping the canonical font only in availableFonts makes its first
			// fallback lookup asynchronous, so early cues stay blank until seeked
			// forces libass to repaint after the font has finished loading.
			fonts: [subtitleFontUrl],
			availableFonts: {
				"vag rounded next": subtitleFontUrl,
			},
			defaultFont: "vag rounded next",
			queryFonts: false,
			prescaleHeightLimit: ASS_MAX_RENDER_HEIGHT,
			maxRenderHeight: ASS_MAX_RENDER_HEIGHT,
		});
		assSubtitles.renderer = renderer;
		await renderer.ready;
		if (
			playerLifecycle.destroyed
			|| generation !== assSubtitles.generation
		) {
			await renderer.destroy().catch(() => {});
			return;
		}

		assSubtitles.resizeObserver = new ResizeObserver(() => {
			updateAssCanvasLayout(assSubtitles.video);
			if (assSubtitles.active) {
				void renderer.resize(true)
					.then(() => renderCurrentAssFrame(true))
					.catch((error) => {
						console.warn("Unable to resize ASS subtitles.", error);
					});
			}
		});
		assSubtitles.resizeObserver.observe(assSubtitles.video);
		assSubtitles.ready = true;
		assSubtitles.status = "ready";
		syncAssSubtitleVisibility(assSubtitles.player);
	})()
		.catch(async (error) => {
			if (generation !== assSubtitles.generation) return;
			console.warn(
				"ASS subtitles unavailable; using WebVTT fallback.",
				error,
			);
			await renderer?.destroy().catch(() => {});
			canvas?.remove();
			assSubtitles.renderer = null;
			assSubtitles.canvas = null;
			assSubtitles.ready = false;
			assSubtitles.resizeObserver?.disconnect();
			assSubtitles.resizeObserver = null;
			assSubtitles.status = "error";
			assSubtitles.error = String(error?.message || error).slice(0, 120);
			syncAssSubtitleVisibility(assSubtitles.player);
		})
		.finally(() => {
			if (assSubtitles.loadPromise === loadPromise) {
				assSubtitles.loadPromise = null;
			}
		});
	assSubtitles.loadPromise = loadPromise;
	return loadPromise;
}
function configureAssSubtitles(player, video, options) {
	assSubtitles.player = player;
	assSubtitles.video = video;
	assSubtitles.url = options.url;
	assSubtitles.language = options.language;
	assSubtitles.trackId = options.trackId;
	assSubtitles.label = options.label;
	assSubtitles.forced = options.forced;
	assSubtitles.bottomMarginPercent = options.bottomMarginPercent;
	assSubtitles.status = options.url ? "idle" : "disabled";

	["texttrackvisibility", "textchanged", "trackschanged"].forEach(
		(eventName) => {
			listen(player, eventName, () => {
				syncAssSubtitleVisibility(player);
			});
		},
	);
	listen(video, "loadedmetadata", () => {
		updateAssCanvasLayout(video);
		renderCurrentAssFrame(true);
	});
	listen(video, "playing", requestNextAssVideoFrame);
	listen(video, "pause", cancelAssVideoFrame);
	listen(video, "seeked", () => renderCurrentAssFrame(true));
	syncAssSubtitleVisibility(player);
}
// Всё ниже отвечает только за телеметрию плеера. Визуальное состояние UI
