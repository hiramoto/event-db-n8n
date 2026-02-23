import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PrismaClient, Prisma } from "@prisma/client";

const app = new Hono();
const prisma = new PrismaClient();

const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error("API_TOKEN environment variable is required");
  process.exit(1);
}

// ---------- Middleware ----------

/** Bearer Token 認証 */
function bearerAuth(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

// ---------- Routes ----------

/** Health check */
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

/**
 * POST /events
 * イベント受信エンドポイント
 * - Bearer Token 認証
 * - event_id による冪等性（ON CONFLICT DO NOTHING）
 */
app.post("/events", bearerAuth, async (c) => {
  const body = await c.req.json();

  // バリデーション
  const { event_id, type, ts, payload, device_id, meta } = body;

  if (!event_id || typeof event_id !== "string") {
    return c.json({ error: "event_id (string/UUID) is required" }, 400);
  }
  if (!type || typeof type !== "string") {
    return c.json({ error: "type (string) is required" }, 400);
  }
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "payload (object) is required" }, 400);
  }

  // ts が省略された場合はサーバー時刻で補完
  const eventTs = ts ? new Date(ts) : new Date();
  if (isNaN(eventTs.getTime())) {
    return c.json({ error: "ts must be a valid ISO 8601 date" }, 400);
  }

  try {
    // INSERT ... ON CONFLICT (event_id) DO NOTHING で冪等性を担保
    // Prisma の upsert で同等の動作を実現
    // ただし真の DO NOTHING のため $executeRawUnsafe を使用
    await prisma.$executeRaw`
      INSERT INTO events (event_id, type, ts, payload, device_id, meta, created_at)
      VALUES (${event_id}, ${type}, ${eventTs}::timestamptz, ${JSON.stringify(payload)}::jsonb, ${device_id ?? null}, ${JSON.stringify(meta ?? {})}::jsonb, NOW())
      ON CONFLICT (event_id) DO NOTHING
    `;

    return c.json({ status: "ok", event_id }, 200);
  } catch (error) {
    console.error("Failed to insert event:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * GET /events
 * イベント一覧取得（デバッグ・管理用）
 * - Bearer Token 認証
 * - クエリパラメータ: type, limit, offset, unprocessed
 */
app.get("/events", bearerAuth, async (c) => {
  const type = c.req.query("type");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const unprocessed = c.req.query("unprocessed") === "true";

  const where: Prisma.EventWhereInput = {};
  if (type) where.type = type;
  if (unprocessed) where.processedAt = null;

  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where,
      orderBy: { ts: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.event.count({ where }),
  ]);

  // BigInt を文字列にシリアライズ
  const serialized = events.map((e) => ({
    ...e,
    id: e.id.toString(),
  }));

  return c.json({ events: serialized, total, limit, offset });
});

/**
 * GET /places
 * 場所一覧取得
 */
app.get("/places", bearerAuth, async (c) => {
  const places = await prisma.place.findMany({
    orderBy: { createdAt: "desc" },
  });
  return c.json({ places });
});

/**
 * POST /places
 * 場所登録
 */
app.post("/places", bearerAuth, async (c) => {
  const body = await c.req.json();
  const { place_id, label, lat, lng, radius_m } = body;

  if (!place_id || typeof place_id !== "string") {
    return c.json({ error: "place_id (string) is required" }, 400);
  }
  if (!label || typeof label !== "string") {
    return c.json({ error: "label (string) is required" }, 400);
  }

  const place = await prisma.place.upsert({
    where: { placeId: place_id },
    update: { label, lat, lng, radiusM: radius_m ?? 100 },
    create: {
      placeId: place_id,
      label,
      lat,
      lng,
      radiusM: radius_m ?? 100,
    },
  });

  return c.json({ status: "ok", place });
});

/**
 * GET /digests
 * ダイジェスト一覧取得
 */
app.get("/digests", bearerAuth, async (c) => {
  const unsent = c.req.query("unsent") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

  const where: Prisma.DigestWhereInput = {};
  if (unsent) where.sentAt = null;

  const digests = await prisma.digest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const serialized = digests.map((d) => ({
    ...d,
    id: d.id.toString(),
  }));

  return c.json({ digests: serialized });
});

// ---------- Server ----------

const port = parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Event API listening on http://localhost:${info.port}`);
});
