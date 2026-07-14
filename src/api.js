// Talks to our own serverless proxy, never to Anthropic directly.
// The API key lives on the server (see api/chat.js), never in the browser.
export async function anthropic({ messages, system, max_tokens = 1000 }) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, system, max_tokens }),
  });
  if (!r.ok) throw new Error("chat proxy failed: " + r.status);
  return r.json();
}
