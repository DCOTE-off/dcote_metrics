## Dcote metrics

### Безопасный запуск

Перед запуском скопируйте `example.env` в `.env` и замените
`METRICS_AUTH_TOKEN` на длинную случайную строку. Один и тот же секрет Docker
передаёт backend и Prometheus через Docker Secret; в образ и Git он не попадает.

По умолчанию backend и Grafana доступны reverse proxy на всех интерфейсах,
как и в предыдущей deployment-конфигурации. Prometheus при этом слушает только
`127.0.0.1`. Если reverse proxy запущен прямо на Docker-хосте, backend и Grafana можно
также ограничить до `127.0.0.1` через `BACKEND_BIND_ADDRESS` и
`GRAFANA_BIND_ADDRESS`.

Проверка перед развёртыванием:

```bash
npm test
docker compose config
```

### Как устроены Grafana и metrics API?

В production есть три разные публичные границы:

```text
https://metrics.dcote.net/dashboards
```

Это Grafana. Она только показывает dashboards и сама не принимает события от
сайта или плеера.

```text
https://video.dcote.net/videoplayer
https://video.dcote.net/season-*
```

Это плеер и существующий video/HLS proxy. Плеер и его scoped-ресурсы лежат
под `/videoplayer`, а маршруты `/season-*` остаются без изменений.

```text
https://metrics-api.dcote.net
```

Это публичный metrics API из этого репозитория. В `docker-compose.yml` сервис
называется `backend`, а запускается через `src/index.js`.

Именно этот `backend` принимает события от сайта/плеера, отдаёт метрики для
Prometheus и раздаёт скрипт трекера активности сайта:

```text
контейнер backend:        backend:3000
порт backend на сервере:  http://localhost:7654
публичный metrics API:    https://metrics-api.dcote.net
```

Скрипты, HTTP-события и WebSocket статистики обращаются к
`metrics-api.dcote.net`. Плеер остаётся на `video.dcote.net`, но получает
metrics origin через `METRICS_PUBLIC_BASE_URL`.

Точный reverse-proxy контракт описан в `docs/public-routing.md`.

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

### Exact month/year analytics

The backend keeps exact received events and online-state changes in the
`analytics_data` Docker volume. It does not run another database service.
SQLite writes occur only for real events or presence value changes.

The `/analytics` API that backs that datasource is not public: it answers only
a peer address inside the private ranges **and** a request carrying
`Authorization: Bearer <METRICS_AUTH_TOKEN>`. Grafana reads the same
`metrics_auth_token` Docker secret as Prometheus, so no extra configuration is
needed — but the reverse proxy must never forward `/analytics`.

Grafana uses the internal `Dcote analytics` datasource for historical
dashboard panels. Complete UTC days come from compact daily totals, while the
first and last partial days use original events. This keeps arbitrary time
ranges exact and makes query cost nearly independent of whether the selected
range is one month or one year.

Analytics are retained for 400 days by default. Override this with
`ANALYTICS_RETENTION_DAYS` (minimum 366).

Exact event history starts when this version is deployed. Existing Prometheus
counter samples are intentionally not presented as exact historical events:
they cannot reconstruct the original event timestamps or arbitrary range
boundaries. Preserve an existing Prometheus volume if its legacy sampled
history is still needed during the transition.

### Public URL плеера

Backend вставляет metrics origin в HTML плеера из переменной окружения:

```env
METRICS_PUBLIC_BASE_URL=https://metrics-api.dcote.net
```

В development плеер с `?stage=dev` использует свой локальный origin.

### Метрики активности сайта

Для метрик активности сайта основной сайт должен подключить трекер с публичного
адреса metrics API:

```text
https://metrics-api.dcote.net/site-presence-tracker.js
```

После подключения скрипт сам открывает WebSocket:

```text
wss://metrics-api.dcote.net/metrics/site/ws
```

Reverse proxy передаёт эти URL в одноимённые внутренние route:

```text
GET /site-presence-tracker.js
WS  /metrics/site/ws
```

Для общего layout основного сайта:

```blade
<script>
	window.DCOTE_SITE_METRICS = {
		metricsBaseUrl: "https://metrics-api.dcote.net",
		userId: @json(
			auth()->check()
				? hash_hmac('sha256', (string) auth()->id(), (string) config('app.key'))
				: null
		),
		page: @json(request()->route()?->getName() ?? request()->route()?->uri() ?? request()->path()),
	};
</script>
<script defer src="https://metrics-api.dcote.net/site-presence-tracker.js"></script>
```
