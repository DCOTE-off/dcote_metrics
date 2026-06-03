## Dcote metrics

### Что такое Fastify backend?

Fastify backend — это Node.js metrics API сервис из этого репозитория.
Это не Grafana. В `docker-compose.yml` этот сервис называется `backend`,
а его точка входа — `src/index.js`.

Он принимает события от сайта/плеера, отдаёт метрики для Prometheus и раздаёт
скрипт трекера активности сайта:

```text
контейнер backend: backend:3000
порт для dev:      http://localhost:7654
публичный prefix:  https://video.dcote.net/metrics-api
```

Grafana только читает данные из Prometheus и показывает dashboards. Сейчас
Grafana открывается на `https://metrics.dcote.net/dashboards`, а публичный
metrics API backend доступен отдельно через
`https://video.dcote.net/metrics-api`.

Метрика для аниме.

### Быстрый Старт

```bash
#Linux
cp example.env .env

#Windows CMD
copy example.env .env

#Windows PowerShell
Copy-Item example.env .env
```
#### Быстрый старт для окружение
```env
# Для стейджа в докере и для нодежс.
STAGE=development #production

# А это ну понятно дефолт юзер для графана.
#Grafana 
GF_SECURITY_ADMIN_USER=user
GF_SECURITY_ADMIN_PASSWORD=password

#А это надо указать в прод режиме чтобы не было проблем с url.
GF_SERVER_ROOT_URL=https://metrics.dcote.net/dashboards
GF_SERVER_SERVE_FROM_SUB_PATH=true
```
#### Порты
| Сервис | Порт |
|------------|----------|
| backend | 7654 | 
| prometheus | 9090 |
| grafana | 7070 |
| node_exporter | 9100 |
#### Запуск
```bash

docker compose build

# Если в дев режиме билд
docker compose up --watch

# Если в прод просто

docker compose up -d


```

### И костыльный стейдж в плеер
```js
//В самом файле плеера
const stage = "prod";
const backendUrl =
    stage == "dev"
        ? "http://localhost:7654"
        : "https://video.dcote.net/metrics-api";
const websocketUrl =
    stage == "dev"
        ? "ws://localhost:7654/metrics/ws"
        : "wss://video.dcote.net/metrics-api/metrics/ws";
```

### Метрики активности сайта

Backend принимает события активности сайта и с публичным prefix
`/metrics-api`, и без него:

```text
GET /site-presence-tracker.js
GET /metrics-api/site-presence-tracker.js
WS  /metrics/site/ws
WS  /metrics-api/metrics/site/ws
```

Для общего layout основного сайта:

```blade
<script>
	window.DCOTE_SITE_METRICS = {
		userId: @json(auth()->id()),
		page: @json(request()->route()?->getName() ?? request()->route()?->uri() ?? request()->path()),
	};
</script>
<script defer src="https://video.dcote.net/metrics-api/site-presence-tracker.js"></script>
```
