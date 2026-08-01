# Public routing

Production separates video, player delivery, and telemetry by public URL.

| Public URL | Upstream responsibility |
| --- | --- |
| `https://video.dcote.net/season-*` | Existing video/HLS storage proxy |
| `https://video.dcote.net/videoplayer` and `/videoplayer/*` | Player document and static assets |
| `https://metrics-api.dcote.net/metrics/*` | Metrics HTTP ingestion and WebSockets |
| `https://metrics-api.dcote.net/site-presence-tracker.js` | Site tracker |

Grafana remains on `https://metrics.dcote.net/dashboards`. Prometheus and
`/analytics` stay private on the Docker network.

## Reverse proxy contract

Both public hosts may point at the same backend upstream (host port `7654`);
the boundary is enforced by the locations exposed on each virtual host.
Preserve the existing `video.dcote.net/season-*` location unchanged.

For `video.dcote.net`, proxy only:

```text
GET /videoplayer
GET /videoplayer/
GET /videoplayer/*
```

For `metrics-api.dcote.net`, proxy only:

```text
GET     /site-presence-tracker.js
OPTIONS /metrics/*
POST    /metrics/*
WS      /metrics/ws
WS      /metrics/site/ws
GET     /health
```

The metrics location must use HTTP/1.1, forward `Upgrade` and `Connection`,
and keep an upstream read timeout longer than the backend's 30-second
WebSocket ping interval. With Nginx Proxy Manager, enable WebSocket support
for the `metrics-api.dcote.net` proxy host and add custom locations for
`/videoplayer` and `/videoplayer/` on the video proxy host.

Do not create a catch-all metrics proxy on `video.dcote.net`; the player now
sends HTTP events and opens its active-viewer WebSocket directly against
`metrics-api.dcote.net`. Configure the edge proxy to pass the real client IP
because country labels and rate limits use that address.

Cloudflare caching should be bypassed for `metrics-api.dcote.net`. The player
document already sends `Cache-Control: no-store`; its content-versioned
assets under `/videoplayer/*` may be cached.
