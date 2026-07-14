// Shared, cross-device memory. Calls our serverless storage function,
// which reads/writes a database keyed to one child. Same shape the app
// expects: get(key) -> { value }, set(key, value) -> { ok }.
async function call(action, body) {
  const r = await fetch("/api/storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  if (!r.ok) throw new Error("storage failed: " + r.status);
  return r.json();
}
export const storage = {
  get: (key) => call("get", { key }),
  set: (key, value) => call("set", { key, value }),
  del: (key) => call("del", { key }),
  list: (prefix = "") => call("list", { prefix }),
};
