## Dcote metrics

### Как устроены Grafana и metrics API?

В этой системе есть две разные части:

```text
https://metrics.dcote.net/dashboards
```

Это Grafana. Она только показывает dashboards и сама не принимает события от
сайта или плеера.

```text
https://video.dcote.net/metrics-api
```

Это публичный адрес metrics API из этого репозитория. В `docker-compose.yml`
этот сервис называется `backend`, а запускается он через `src/index.js`.

Именно этот `backend` принимает события от сайта/плеера, отдаёт метрики для
Prometheus и раздаёт скрипт трекера активности сайта:

```text
контейнер backend:        backend:3000
порт backend на сервере:  http://localhost:7654
публичный адрес backend:  https://video.dcote.net/metrics-api
```

Поэтому на основном сайте скрипты и WebSocket для статистики должны обращаться
к `video.dcote.net/metrics-api`, а не к `metrics.dcote.net/dashboards`.

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

Для метрик активности сайта основной сайт должен подключить трекер с публичного
адреса metrics API:

```text
https://video.dcote.net/metrics-api/site-presence-tracker.js
```

После подключения скрипт сам открывает WebSocket:

```text
wss://video.dcote.net/metrics-api/metrics/site/ws
```

Внутри контейнера эти публичные URL после nginx rewrite попадают в такие route:

```text
GET /site-presence-tracker.js
WS  /metrics/site/ws
```

Для общего layout основного сайта:

```blade
<script>
	window.DCOTE_SITE_METRICS = {
		userId: @json(auth()->id()),
		login: @json(auth()->user()?->login ?? auth()->user()?->email),
		role: @json(auth()->user()?->role),
		page: @json(request()->route()?->getName() ?? request()->route()?->uri() ?? request()->path()),
	};
</script>
<script defer src="https://video.dcote.net/metrics-api/site-presence-tracker.js"></script>
```
