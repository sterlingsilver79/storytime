// Serverless proxy to Anthropic. Holds the API key server-side.
// Set ANTHROPIC_API_KEY in your Vercel project settings.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { messages, system, max_tokens = 1000 } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages_required" });

    // Prompt caching: the system prompt is identical every call, so cache it.
    // Cached reads bill at ~10% of input cost (90% off the repeated part).
    const sys = system
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : undefined;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Cheap default; override with CLAUDE_MODEL in Vercel if you want.
        model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
        max_tokens,
        system: sys,
        messages,
      }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "proxy_failed" });
  }
}
