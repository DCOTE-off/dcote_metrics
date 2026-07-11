# dcote-site integration contract v1

The browser client treats telemetry as optional. `dcote_metrics` keeps both
direct and reverse-proxy route prefixes available during independent deploys.

## Site presence

- WebSocket: `/metrics/site/ws`
- Reverse-proxy WebSocket: `/metrics-api/metrics/site/ws`
- Message fields: `page`, `userId`, `sessionId`, `tabId`
- Response: `{ "ok": true }` or `{ "ok": false, "error": "..." }`

## Player

- Player document: `/videoplayer`
- Query fields: `src`, `poster`, `skip_start`, `ass`, `ass_lang`
- Static dependencies are served locally under `/vendor` and `/icons`.

Changes must stay backward compatible until `dcote-site` has been deployed.
