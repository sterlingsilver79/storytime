// Serverless proxy to Anthropic. Holds the API key server-side.
// Set ANTHROPIC_API_KEY in your Vercel project settings.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { messages, system, max_tokens = 1000 } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages_required" });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens,
        system,
        messages,
      }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "proxy_failed" });
  }
}
