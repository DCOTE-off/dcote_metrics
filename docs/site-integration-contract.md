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
- Query fields: `src`, `poster`, `skip_start`, `ass`, `ass_lang`
- Static dependencies are served locally under `/vendor` and `/icons`.
- A view is counted after 30 active playback seconds. Buffering, seeking,
  hidden-tab time and pauses are excluded.
- `view-started`, `viewing-time`, and `subtitles` include a stable `eventId`
  for persistent deduplication.
- The player keeps only unacknowledged event-ID metrics in a bounded local
  retry queue. A retry reuses the same ID, so a response lost after a
  successful write cannot increment the metric twice.
- `viewing_duration_seconds` receives one completed playback observation on
  `ended` or a non-BFCache `pagehide`.

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
