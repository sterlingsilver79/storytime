// Serverless storage backed by Upstash Redis (free tier).
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.
// CHILD namespace keeps one child's data together; change it if you add a sibling.
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const NS = (process.env.CHILD_ID || "sterling") + ":";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const { action, key, value, prefix = "" } = req.body || {};
  try {
    if (action === "get") {
      const v = await redis.get(NS + key);
      // Upstash auto-parses JSON; the app expects a raw string to JSON.parse itself.
      const out = v == null ? null : (typeof v === "string" ? v : JSON.stringify(v));
      return res.json({ value: out });
    }
    if (action === "set") {
      await redis.set(NS + key, value);
      return res.json({ ok: true });
    }
    if (action === "del") {
      await redis.del(NS + key);
      return res.json({ ok: true });
    }
    if (action === "list") {
      const keys = await redis.keys(NS + prefix + "*");
      return res.json({ keys: keys.map((k) => k.slice(NS.length)) });
    }
    return res.status(400).json({ error: "bad_action" });
  } catch (e) {
    return res.status(500).json({ error: "storage_failed" });
  }
}
