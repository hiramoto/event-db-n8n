# Personal Event Pipeline — n8n + OpenClaw on Sakura VPS

スマホ（Android / Tasker）から送信した個人イベントデータ（位置情報など）を収集・集約し、exe.dev 上の OpenClaw に圧縮して渡すことで、タイミングに応じたパーソナルなメッセージを受け取るためのシステム。

## 全体構成

```
┌──────────────┐
│  Android     │  Tasker + AutoLocation
│  (スマホ)    │  ジオフェンス enter/exit/dwell
└──────┬───────┘
       │  POST /events (Bearer Token)
       │  via Cloudflare (orange cloud ON)
       ▼
┌──────────────────────────────────────────────────────┐
│  Sakura VPS (Docker Compose)                         │
│                                                      │
│  ┌──────────┐    ┌──────────┐    ┌────────────────┐ │
│  │  Caddy   │───▶│ Event API│───▶│   PostgreSQL   │ │
│  │ (TLS:    │    │ (公開)   │    │ eventdb / n8ndb│ │
│  │  Origin  │    └──────────┘    └───────┬────────┘ │
│  │  Cert)   │                            │          │
│  └──────────┘                    ┌───────┴────────┐ │
│                                  │      n8n       │ │
│       Caddy は Event API のみ    │ (内部のみ)     │ │
│       n8n は外部に公開しない      │ 管理: SSH tunnel│ │
│                                  └───────┬────────┘ │
│                                          │          │
└──────────────────────────────────────────┼──────────┘
                                           │
                     n8n: cron(5分) → バッチ集計 → digest 生成
                                           │
                                           ▼
                                 ┌───────────────────┐
                                 │    OpenClaw        │
                                 │   (exe.dev)        │
                                 │  POST /hooks/agent │
                                 │  Bearer Token 認証  │
                                 └───────────────────┘
```

## 確定方針

開発を始める前に決め切った事項。これらは変更しない限り全体の前提となる。

### TLS 方針

**Cloudflare プロキシ ON（オレンジ雲）+ Origin Certificate + Full (Strict) + Authenticated Origin Pulls**

- Cloudflare が外向き TLS を終端し、CDN / WAF / Rate Limiting を提供
- Caddy は Cloudflare Origin Certificate でオリジン側 TLS を提供（最長15年有効、Let's Encrypt 不要）
- Authenticated Origin Pulls により Cloudflare 経由以外のアクセスを TLS レベルで拒否
- さくら VPS のパケットフィルタで 80/443 を Cloudflare IP のみに制限

### n8n の公開方針

**n8n は外部に公開しない。入口は Event API のみ。**

- n8n の管理 UI は SSH トンネル経由でのみアクセス（`ssh -L 5678:localhost:5678 vps`）
- n8n に `WEBHOOK_URL` は設定しない（外部から n8n webhook を叩かない）
- n8n は DB をポーリングして未処理イベントを取得する（cron トリガー → DB クエリ）
- OpenClaw への送信は n8n から HTTP Request ノードで行う（アウトバウンドのみ）

### 状態管理（未処理の定義）

**`events.processed_at` で管理する。**

- `events.processed_at TIMESTAMPTZ NULL` — 初期値 NULL = 未処理
- n8n バッチは `WHERE processed_at IS NULL` を対象に集計
- digest 生成成功後に対象イベントの `processed_at` を現在時刻で UPDATE
- OpenClaw 送信成功時に `digests.sent_at` を更新
- 送信失敗時は `sent_at` を NULL のまま残し、次回バッチで再送

### 冪等性（重複排除）

**envelope に `event_id`（UUID）を必須化し、DB で UNIQUE 制約。**

- スマホの再送・二重送信を DB レベルで吸収
- Event API は `INSERT ... ON CONFLICT (event_id) DO NOTHING` で 200 を返す

### マイグレーション

**Prisma Migrate でスキーマ管理。**

- `docker-entrypoint-initdb.d` は DB 作成のみ（`CREATE DATABASE eventdb` / `CREATE DATABASE n8ndb`）
- テーブル定義は `prisma/schema.prisma` で管理し `prisma migrate deploy` で適用
- 開発中のスキーマ変更も migration ファイルで追跡

## コンセプト

- **入口は Event API だけ**を公開し、n8n は内部に閉じる
- **DB（SoR）に必ず保存してから**処理する（イベントは消えない）
- **envelope 固定設計**: `POST /events` のエンドポイントは変えず、`type` / `payload` を増やすだけで拡張可能
- **圧縮してから OpenClaw へ**: 生データは溜め、状態変化と短い要約だけを外部へ送る
- **5分以内の応答**: イベント発生から OpenClaw のメッセージ受信まで最大5分（cron 間隔）

## イベント設計

### 共通エンベロープ

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "location",
  "ts": "2025-02-23T10:30:00+09:00",
  "payload": { ... },
  "device_id": "android-main",
  "meta": {}
}
```

| フィールド | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `event_id` | UUID | Yes | クライアント生成。重複排除キー |
| `type` | string | Yes | イベント種別（`location`, `email`, `todo`, `vital`） |
| `ts` | ISO 8601 | Yes | イベント発生時刻（タイムゾーン付き） |
| `payload` | object | Yes | type ごとの詳細データ |
| `device_id` | string | No | 送信元デバイス識別子 |
| `meta` | object | No | 拡張用メタデータ |

### Phase 1: location（初期リリース）

```json
{
  "event_id": "...",
  "type": "location",
  "ts": "2025-02-23T10:30:00+09:00",
  "payload": {
    "event": "enter",
    "place_id": "office",
    "lat": 34.855,
    "lng": 136.381,
    "accuracy_m": 15
  },
  "device_id": "android-main"
}
```

- `place_id` は places テーブルで管理する辞書
- `event`: `enter` / `exit` / `dwell`
- Tasker + AutoLocation のジオフェンスで自動送信

### Phase 2 以降（拡張予定）

| type | payload 例 | 備考 |
|------|-----------|------|
| `email` | subject, from, labels | ヘッダ中心、本文は含めない |
| `todo` | task_id, old_status, new_status | 状態遷移のみ |
| `vital` | sub_type (wake/sleep/exercise/watch_off) | 低次元の状態イベント |

## 圧縮パイプライン（n8n）

n8n が cron（5分間隔）で DB をポーリングし、3段の圧縮を行う。

```
① バッチ取得   : SELECT * FROM events WHERE processed_at IS NULL ORDER BY ts
② 集計        : 滞在セグメント化（enter → dwell → exit を1行に）
③ digest 生成 : OpenClaw 向けの短いテキスト or JSON に変換 → digests テーブルへ INSERT
④ 状態更新    : 対象 events の processed_at を現在時刻で UPDATE
⑤ 送信        : digests WHERE sent_at IS NULL → OpenClaw /hooks/agent へ POST
⑥ 送信確認    : 成功なら digests.sent_at を UPDATE、失敗なら次回バッチで再送
```

集計処理は n8n の Code ノードや外部スクリプト（TypeScript / Python）で実装可能。

### OpenClaw への送信フォーマット

```bash
POST https://<openclaw-vm>.exe.xyz/hooks/agent
Authorization: Bearer <OPENCLAW_HOOK_TOKEN>
Content-Type: application/json

{
  "message": "[LocationDigest] 10:00-10:25 自宅 → 10:30 オフィス到着",
  "name": "EventDigest",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last"
}
```

- `wakeMode: "now"` で即座にエージェントを起動
- `deliver: true` + `channel: "last"` で最後に使ったチャンネルにメッセージ配信
- 失敗時は `digests.sent_at` が NULL のまま残り、次回バッチで再送
- `digest_id` を message に含めることで OpenClaw 側で重複判定が可能

## データベース設計

同一 PostgreSQL インスタンスに 2 つのデータベースを作成。

### eventdb（Prisma Migrate で管理）

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Place {
  placeId   String   @id @map("place_id")
  label     String
  lat       Float?
  lng       Float?
  radiusM   Int      @default(100) @map("radius_m")
  createdAt DateTime @default(now()) @map("created_at")

  @@map("places")
}

model Event {
  id          BigInt    @id @default(autoincrement())
  eventId     String    @unique @map("event_id")  // UUID, 冪等キー
  type        String
  ts          DateTime
  payload     Json
  deviceId    String?   @map("device_id")
  meta        Json      @default("{}")
  processedAt DateTime? @map("processed_at")       // NULL = 未処理
  createdAt   DateTime  @default(now()) @map("created_at")

  @@index([type, ts])
  @@index([processedAt])
  @@map("events")
}

model Digest {
  id          BigInt    @id @default(autoincrement())
  periodStart DateTime  @map("period_start")
  periodEnd   DateTime  @map("period_end")
  type        String
  summary     Json
  sentAt      DateTime? @map("sent_at")            // NULL = 未送信
  createdAt   DateTime  @default(now()) @map("created_at")

  @@index([sentAt])
  @@map("digests")
}
```

### n8ndb

n8n が自動で作成・管理するので手動操作は不要。

### タイムゾーン規約

- DB には `timestamptz` で保存（Prisma の `DateTime` はデフォルトで timestamptz）
- API で `ts` が省略された場合はサーバー時刻（UTC）で補完
- digest の period は `[period_start, period_end)` 半開区間

## ディレクトリ構成

```
event-pipeline/
├── README.md
├── docker-compose.yml
├── .env                        # ← .gitignore 対象
├── .env.example
├── caddy/
│   ├── Caddyfile
│   └── certs/                  # Origin Cert + Key + Origin Pull CA
│       ├── origin.pem
│       ├── origin-key.pem
│       └── origin-pull-ca.pem
├── event-api/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma
│   └── src/
│       └── index.ts            # Hono / Fastify
├── db/
│   └── init.sh                 # DB 作成のみ（テーブルは Prisma で管理）
├── scripts/
│   └── digest-worker.ts        # n8n Code ノード用の集計ロジック
└── n8n/
    └── workflows/              # エクスポートした n8n ワークフロー JSON
```

## docker-compose.yml

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile
      - ./caddy/certs:/etc/caddy/certs:ro
      - caddy_data:/data
      - caddy_config:/config

  event-api:
    build: ./event-api
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/eventdb
      - API_TOKEN=${API_TOKEN}
    depends_on:
      - postgres
    expose:
      - "3000"

  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    environment:
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_DATABASE=n8ndb
      - DB_POSTGRESDB_USER=${POSTGRES_USER}
      - DB_POSTGRESDB_PASSWORD=${POSTGRES_PASSWORD}
      # WEBHOOK_URL は設定しない（外部から叩かない）
      - GENERIC_TIMEZONE=Asia/Tokyo
      - EVENTDB_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/eventdb
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      - postgres
    expose:
      - "5678"
    # ports は公開しない — SSH トンネルでアクセス

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./db/init.sh:/docker-entrypoint-initdb.d/init.sh
    expose:
      - "5432"

volumes:
  caddy_data:
  caddy_config:
  n8n_data:
  pg_data:
```

## .env.example

```bash
# Domain
DOMAIN=example.com
API_SUBDOMAIN=events

# PostgreSQL
POSTGRES_USER=pipeline
POSTGRES_PASSWORD=CHANGE_ME

# Event API
API_TOKEN=CHANGE_ME_LONG_RANDOM_STRING

# OpenClaw (exe.dev)
OPENCLAW_HOOK_URL=https://<vm-name>.exe.xyz/hooks/agent
OPENCLAW_HOOK_TOKEN=CHANGE_ME
```

## db/init.sh

```bash
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE eventdb;
    CREATE DATABASE n8ndb;
EOSQL

# テーブル作成は Prisma Migrate で行うため、ここでは DB 作成のみ
```

## Caddyfile

```caddyfile
{
    email you@example.com
    auto_https off
}

{$API_SUBDOMAIN}.{$DOMAIN} {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin-key.pem {
        client_auth {
            mode require_and_verify
            trusted_ca_cert_file /etc/caddy/certs/origin-pull-ca.pem
        }
    }
    reverse_proxy event-api:3000
}
```

## Cloudflare 設定チェックリスト

- [ ] サブドメイン `events.example.com` → さくら VPS IP（オレンジ雲 ON）
- [ ] SSL/TLS → 暗号化モード: **Full (Strict)**
- [ ] SSL/TLS → Origin Server → **Origin Certificate 作成**（RSA, 15年）→ `caddy/certs/` に配置
- [ ] SSL/TLS → Origin Server → **Authenticated Origin Pulls: ON**
- [ ] Origin Pull CA 証明書をダウンロード → `caddy/certs/origin-pull-ca.pem`
- [ ] WAF → Rate Limiting: `/events` に対して 100 req/min/IP
- [ ] WAF → Custom Rule: `POST` 以外のメソッドを `/events` でブロック
- [ ] さくら VPS パケットフィルタ: 80/443 を [Cloudflare IP](https://www.cloudflare.com/ips/) のみ許可

## Tasker 設定（Android）

### 必要なアプリ

- Tasker（有料）
- AutoLocation プラグイン（有料）— ジオフェンスに使用

### ジオフェンス → HTTP POST の構成

```
Profile: LocationEvent
  State: AutoLocation Geofences [Name: <場所名>, Enter/Exit: Both]

Enter Task:
  A1: Variable Set [%event → enter]
  A2: Perform Task [SendEvent]

Exit Task:
  A1: Variable Set [%event → exit]
  A2: Perform Task [SendEvent]
```

```
Task: SendEvent
  A1: Java Function [%uuid = randomUUID]
  A2: HTTP Request [
        Method: POST
        URL: https://events.example.com/events
        Headers:
          Content-Type: application/json
          Authorization: Bearer <API_TOKEN>
        Body: {
          "event_id": "%uuid",
          "type": "location",
          "ts": "%TIMES",
          "payload": {
            "event": "%event",
            "place_id": "%algeofence",
            "lat": %allatitude,
            "lng": %allongitude,
            "accuracy_m": %alaccuracy
          },
          "device_id": "android-main"
        }
        Timeout: 30
      ]
```

### バッテリー最適化

- WiFi 接続状態を自宅検知の第一手段にする（追加電力ゼロ）
- ジオフェンス監視は WiFi 切断時のみ有効化
- AutoLocation は Balanced Power モードを使用
- Tasker: GPS Check Time 300秒以上、GPS Timeout 30秒

## OpenClaw との連携

### アーキテクチャ

```
n8n (内部) → HTTP Request → OpenClaw /hooks/agent (exe.dev)
```

- n8n が cron で DB をポーリングし digest を生成
- digest を OpenClaw の webhook に POST（アウトバウンドのみ）
- OpenClaw は exe.dev 上で稼働（静的 IP なし → IP 制限ではなく Bearer Token で認証）

### 失敗時の再送

- `digests.sent_at IS NULL` の digest を次回バッチで再送
- n8n の HTTP Request ノードで retry（指数バックオフ）を設定
- digest_id を message に含め、OpenClaw 側で重複を認識可能にする

## マイルストーン

### Phase 0: インフラ構築

- [ ] さくら VPS 契約（推奨: 2GB RAM 以上）
- [ ] Ubuntu セットアップ、Docker / Docker Compose インストール
- [ ] パケットフィルタ設定（80/443 を Cloudflare IP のみ許可）
- [ ] Cloudflare: サブドメイン設定、Origin Certificate 発行、Full (Strict)、Authenticated Origin Pulls ON
- [ ] `caddy/certs/` に Origin Cert + Key + Origin Pull CA を配置
- [ ] `docker compose up` で Caddy + PostgreSQL 起動、HTTPS 確認
- [ ] SSH トンネルで n8n 管理画面にアクセスできることを確認

### Phase 1: Location イベント（MVP）

- [ ] Event API 実装（POST /events, GET /events, Bearer Token 認証, 冪等性）
- [ ] Prisma schema 定義 → `prisma migrate deploy` でテーブル作成
- [ ] places テーブルに自宅・職場などの初期データ投入
- [ ] Tasker + AutoLocation でジオフェンス設定、テスト送信
- [ ] Cloudflare WAF: Rate Limiting + POST only ルール設定
- [ ] n8n ワークフロー: cron(5分) → 未処理 events 取得 → 滞在セグメント化 → digests 保存 → processed_at 更新
- [ ] n8n → OpenClaw `/hooks/agent` への digest 送信
- [ ] 送信失敗時の再送動作を確認

### Phase 2: OpenClaw 統合の最適化

- [ ] OpenClaw workspace に skill 作成（digest 解釈ルール）
- [ ] タイミング制御（通勤中・帰宅後などに応じたメッセージング）
- [ ] digest フォーマット最適化（OpenClaw の応答品質を見ながら調整）
- [ ] pg_dump 日次バックアップの自動化

### Phase 3: イベントタイプ追加

- [ ] email イベント（ヘッダのみ）
- [ ] todo ステータス変更イベント
- [ ] vital イベント（起床・運動など）

## 未決事項

| 項目 | 選択肢 / メモ |
|------|--------------|
| VPS プラン | 2GB / 4GB — n8n + Postgres の常駐を考慮して決定 |
| Event API の FW | Hono / Fastify（TypeScript） |
| 監視 / アラート | Uptime Kuma / Healthchecks.io 等 |
| バックアップ先 | pg_dump → さくらオブジェクトストレージ or S3 互換 |
| OpenClaw skill の詳細設計 | digest の解釈ルール、応答テンプレート |
| dwell イベントの生成方法 | Tasker 側 or n8n 側で滞在時間から生成 |

## 開発環境

- **ホスト OS**: Windows（Docker Desktop / WSL2）
- **本番**: さくら VPS（Ubuntu）
- **OpenClaw**: exe.dev

## 参考リンク

- [OpenClaw](https://github.com/openclaw/openclaw) — パーソナル AI アシスタント
- [OpenClaw Docs: Webhook](https://docs.openclaw.ai/automation/webhook)
- [OpenClaw Docs: exe.dev](https://docs.openclaw.ai/install/exe-dev)
- [n8n](https://n8n.io/) — ワークフロー自動化
- [Caddy](https://caddyserver.com/) — リバースプロキシ
- [Prisma](https://www.prisma.io/) — TypeScript ORM + Migration
- [Tasker](https://tasker.joaoapps.com/) — Android 自動化
- [AutoLocation](https://joaoapps.com/autolocation/) — Tasker ジオフェンスプラグイン
- [Cloudflare Origin Certificate](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- [Cloudflare Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/)
- [さくらの VPS](https://vps.sakura.ad.jp/)
