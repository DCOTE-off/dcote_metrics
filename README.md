## Dcote metrics

Метрика для аниме.

### Старт

```bash
#Linux
cp .env.example .env

#Windows CMD
copy .env.example .env

#Windows PowerShell
Copy-Item .env.example .env
```

```env
# Для стейджа в докере и для нодежс.
STAGE=development #production

# А это ну понятно дефолт юзер для графана.
#Grafana 
GF_SECURITY_ADMIN_USER=user
GF_SECURITY_ADMIN_PASSWORD=password

#А это надо указать в прод режиме чтобы не было проблем с url.
GF_SERVER_ROOT_URL=https://video.dcote.net/grafana
GF_SERVER_SERVE_FROM_SUB_PATH=true
```

| Сервис | Порт |
|------------|----------|
| backend | 7654 | 
| prometheus | 9090 |
| grafana | 7070 |
| node_exporter | 9100 |

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
