/**
 * digest-worker.ts
 *
 * n8n の Code ノードで使用する集計ロジック。
 * 未処理の location イベントを滞在セグメントに変換し、
 * digest テキストを生成する。
 *
 * n8n ワークフロー:
 *   ① cron(5分) → ② PostgreSQL クエリ（未処理 events 取得）
 *   → ③ Code ノード（この関数）→ ④ digest INSERT
 *   → ⑤ events.processed_at UPDATE → ⑥ OpenClaw 送信
 */

// ---------- Types ----------

interface LocationPayload {
  event: "enter" | "exit" | "dwell";
  place_id: string;
  lat?: number;
  lng?: number;
  accuracy_m?: number;
}

interface RawEvent {
  id: number;
  event_id: string;
  type: string;
  ts: string;
  payload: LocationPayload;
  device_id: string | null;
  meta: Record<string, unknown>;
  processed_at: string | null;
  created_at: string;
}

interface StaySegment {
  place_id: string;
  enter_at: string;
  exit_at: string | null;
  duration_min: number | null;
}

interface DigestOutput {
  period_start: string;
  period_end: string;
  type: string;
  summary: {
    segments: StaySegment[];
    text: string;
    event_ids: string[];
  };
}

// ---------- Core Logic ----------

/**
 * location イベントを滞在セグメントに集約する
 *
 * enter → (dwell) → exit を1つのセグメントにまとめる。
 * exit がない場合は「滞在中」として扱う。
 */
function buildStaySegments(events: RawEvent[]): StaySegment[] {
  const locationEvents = events
    .filter((e) => e.type === "location")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (locationEvents.length === 0) return [];

  const segments: StaySegment[] = [];
  let currentSegment: StaySegment | null = null;

  for (const event of locationEvents) {
    const payload = event.payload;

    if (payload.event === "enter") {
      // 前のセグメントが閉じていない場合、現在時刻で閉じる
      if (currentSegment && !currentSegment.exit_at) {
        currentSegment.exit_at = event.ts;
        currentSegment.duration_min = calcDurationMin(
          currentSegment.enter_at,
          currentSegment.exit_at
        );
      }

      currentSegment = {
        place_id: payload.place_id,
        enter_at: event.ts,
        exit_at: null,
        duration_min: null,
      };
      segments.push(currentSegment);
    } else if (payload.event === "exit") {
      if (currentSegment && currentSegment.place_id === payload.place_id) {
        currentSegment.exit_at = event.ts;
        currentSegment.duration_min = calcDurationMin(
          currentSegment.enter_at,
          currentSegment.exit_at
        );
        currentSegment = null;
      } else {
        // enter なしの exit → 単独セグメントとして記録
        segments.push({
          place_id: payload.place_id,
          enter_at: event.ts,
          exit_at: event.ts,
          duration_min: 0,
        });
      }
    }
    // dwell は既存セグメントの中間イベントとして無視（セグメントに含まれる）
  }

  return segments;
}

function calcDurationMin(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / 60000);
}

/**
 * セグメント群から人間が読める digest テキストを生成する
 *
 * 例: "[LocationDigest] 10:00-10:25 自宅 → 10:30 オフィス到着"
 */
function generateDigestText(segments: StaySegment[]): string {
  if (segments.length === 0) return "[LocationDigest] イベントなし";

  const parts = segments.map((seg) => {
    const enterTime = formatTime(seg.enter_at);
    if (seg.exit_at && seg.duration_min !== null && seg.duration_min > 0) {
      const exitTime = formatTime(seg.exit_at);
      return `${enterTime}-${exitTime} ${seg.place_id}(${seg.duration_min}分)`;
    }
    return `${enterTime} ${seg.place_id}到着`;
  });

  return `[LocationDigest] ${parts.join(" → ")}`;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * メインの集計関数
 *
 * n8n の Code ノードから呼び出す。
 * 未処理イベントの配列を受け取り、digest 出力を返す。
 */
export function processEvents(events: RawEvent[]): DigestOutput | null {
  if (events.length === 0) return null;

  const segments = buildStaySegments(events);
  const text = generateDigestText(segments);

  const timestamps = events.map((e) => new Date(e.ts).getTime());
  const periodStart = new Date(Math.min(...timestamps)).toISOString();
  const periodEnd = new Date(Math.max(...timestamps)).toISOString();

  return {
    period_start: periodStart,
    period_end: periodEnd,
    type: "location",
    summary: {
      segments,
      text,
      event_ids: events.map((e) => e.event_id),
    },
  };
}

/**
 * OpenClaw 送信用のペイロードを生成する
 */
export function buildOpenClawPayload(
  digest: DigestOutput,
  digestId: string
): Record<string, unknown> {
  return {
    message: `${digest.summary.text}\n[digest_id: ${digestId}]`,
    name: "EventDigest",
    wakeMode: "now",
    deliver: true,
    channel: "last",
  };
}

// ---------- n8n Code ノード用のエントリポイント ----------

/**
 * n8n Code ノードで以下のように使用:
 *
 * ```js
 * // 前のノードから未処理イベントを受け取る
 * const events = $input.all().map(item => item.json);
 * const { processEvents, buildOpenClawPayload } = require('./digest-worker');
 *
 * const digest = processEvents(events);
 * if (!digest) return [];
 *
 * return [{ json: digest }];
 * ```
 */
