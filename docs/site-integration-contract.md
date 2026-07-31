# dcote-site integration contract v1

The browser client treats telemetry as optional. `dcote_metrics` keeps both
direct and reverse-proxy route prefixes available during independent deploys.

## Site presence

- WebSocket: `/metrics/site/ws`
- Reverse-proxy WebSocket: `/metrics-api/metrics/site/ws`
- Presence fields: `page`, pseudonymous `userId`, browser `sessionId`, `tabId`
- Event fields: `visitId`, `visitStarted`, `pageViewId`, `pageViewStarted`
- A successful response echoes `visitAcknowledged` and
  `pageViewAcknowledged` IDs. The tracker retries only unacknowledged events,
  so a WebSocket or backend restart does not create another visit. These IDs
  are also persisted in the analytics database, so an acknowledgement lost
  immediately before a restart still cannot duplicate the event.

## Player

- Player document: `/videoplayer`
- Query fields: `src`, `poster`, `skip_start`, `ass`, `ass_lang`.
- Optional ASS matching fields: `ass_track_id`, `ass_label`, and
  `ass_forced=0|1`. Matching falls back to the base language when no stable
  track ID or label is supplied.
- VAG Rounded Next Bold is the canonical subtitle font. WebVTT uses it through
  the player stylesheet; ASS uses the same bundled file as its default and
  only available font, without querying fonts installed on the device.
  Browser/OS-native caption surfaces such as standard Picture-in-Picture may
  ignore custom cue fonts; this cannot be overridden by the embedded page.
- `ass_bottom_margin_percent` is an explicit compatibility override and
  defaults to `0`, so authored ASS positioning and event overrides are
  preserved.
- JASSUB, WASM, and ASS load only after the matching HLS text track is
  selected. Rendering stops while captions are off and the renderer is
  released after 30 seconds of inactivity.
- HLS WebVTT remains visible while ASS is loading or unavailable and is used
  through a native text displayer for video-only fullscreen,
  Picture-in-Picture, and every remote-playback state. This lifecycle is
  installed for WebVTT-only episodes as well as episodes with ASS.
- Automatic quality selection is capped at 1080p on desktop and 720p on the
  mobile layout. A fresh player starts at that target and can adapt downward
  after measuring a slower connection. This is an ABR-only restriction: every
  available rendition remains selectable manually in the quality menu.
- Static dependencies are served locally under `/vendor` and `/icons`.
  Content-versioned URLs are cached immutably; unversioned or stale URLs
  require validation with an ETag. Identity, gzip, and Brotli representations
  are prepared at startup and have distinct validators.
- A view is counted after 30 active playback seconds. Buffering, seeking,
  hidden-tab time and pauses are excluded.
- `view-started`, `viewing-time`, and `subtitles` include a stable `eventId`
  for persistent deduplication.
- The player keeps only unacknowledged event-ID metrics in a bounded local
  retry queue. A retry reuses the same ID, so a response lost after a
  successful write cannot increment the metric twice.
- `viewing_duration_seconds` receives one completed playback observation on
  `ended` or a non-BFCache `pagehide`.

### WebVTT HLS fallback packaging

Package a VTT fallback against the segment durations of one video rendition:

```sh
npm run package:vtt-hls -- \
  --video-playlist qualities/1080p/index.m3u8 \
  --source-vtt subtitles/ru.vtt \
  --output-playlist subtitles/ru_split.m3u8 \
  --segment-prefix ru_split_ \
  --pts-offset 1.5
```

`--pts-offset` is the measured MPEG-TS start offset for the episode. Cues
crossing a segment boundary are repeated with their complete timestamps, as
required by RFC 8216 §3.5; they are not cut into local fragments. Both
`MM:SS.mmm` and `HH:MM:SS.mmm` timestamps are accepted. Header metadata plus
pre-cue `STYLE`, `REGION`, and `NOTE` blocks are copied into each segment; an
existing `X-TIMESTAMP-MAP` is replaced with the supplied offset. Malformed,
reversed, or wholly out-of-playlist cues fail packaging instead of being
silently discarded. Segments are prepared in a temporary directory, the
playlist is published last, and obsolete segments with the same prefix are
removed after a successful publication.

## Exact historical analytics

- The backend stores received events and online-state transitions in the
  SQLite file configured by `ANALYTICS_DATABASE_PATH`.
- Full UTC days are read from compact daily totals. Partial first and last
  days are calculated from original events, so arbitrary time-range
  boundaries are not rounded.
- The default retention is 400 days.
- Exact event history starts at deployment of the SQLite-backed version.
  Legacy Prometheus counter samples are not automatically relabelled as exact
  events because they cannot reproduce the original event timestamps.
- Grafana accesses the internal Prometheus-compatible endpoint at
  `/analytics`; it is restricted to loopback and private container-network
  addresses.

Changes must stay backward compatible until `dcote-site` has been deployed.
