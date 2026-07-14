import React, { useState, useRef, useEffect, useCallback } from "react";
import { anthropic } from "./api";
import { storage } from "./storage";

/*
  Chat companion (plain look). It answers questions, chats normally, and writes
  stories when he asks or shares a drawing — not everything is a story.
  Behavior lives in SYSTEM_PROMPT. Memory persists via a shared database
  (see src/storage.js) under "learningProfile".
*/

const SYSTEM_PROMPT = `You are a chat companion for Sterling, age 11. He is sharp and dislikes being talked down to, and he struggles with spelling.

Respond in whatever form actually fits his message — do NOT turn everything into a story:
- If he asks a straightforward question, just answer it: clearly, accurately, plainly. No story, no whimsy.
- If he asks for a story, or shares a drawing to build one from, then write one. Keep it grounded, not overly whimsical.
- Otherwise, just talk with him normally, the way a knowledgeable person would.

Throughout:
- SPELLING: If his message has misspelled words, begin your reply by correcting them directly and specifically (his exact misspelling, then the correct spelling), and also list them in spellingCorrections. Don't let misspellings slide. If nothing is misspelled, use an empty array.
- Weave in real, accurate information naturally whenever it fits — no labels, no "fun fact" framing, no quizzes. Just be substantive and honest. If you don't know something, say so.
- Voice: accurate first, simple second. Warm but not gushing. No fake enthusiasm or piled-on praise — he notices.
- SAFETY: keep everything appropriate for an 11-year-old — nothing violent, scary, sexual, or adult; no profanity; never ask for personal info. If he seems upset or unsafe, gently point him to a parent or trusted adult without alarming him. Don't lecture or moralize.

Return ONLY one JSON object, no code fences, no text around it:
{
  "spellingCorrections": [ { "wrong": "", "right": "" } ],
  "reply": "your actual response to him — an answer, a normal chat message, or a story, whatever fits",
  "learned": "if you taught a real concept this turn, a short phrase naming it (for the parent's private records only, never shown to him); otherwise null"
}`;

const REPORT_SYSTEM = `You write a short, candid progress report for a PARENT about their 11-year-old son, based on saved data from an app he uses to chat, ask questions, learn, and make up stories. Be specific and useful, not flattering. Cover, in a few short plain paragraphs: what topics and concepts he's been exploring; how his spelling is going and any pattern in the words he misspells; his engagement (roughly how much he's done); apparent strengths; gaps or things worth reinforcing; and 2-3 concrete suggestions for what to explore next. Base everything ONLY on the data provided. If the data is thin, say so plainly rather than padding. Write to the parent, not the child.`;

const strip = (t) => t.replace(/```json/gi, "").replace(/```/g, "").trim();
const today = () => new Date().toISOString().slice(0, 10);

// Cost control: only send recent history to the model, and never re-send images.
const HISTORY_LIMIT = 12;
function capHistory(convo) {
  let h = convo.slice(-HISTORY_LIMIT);
  while (h.length && h[0].role === "assistant") h = h.slice(1); // must start with a user turn
  return h;
}
function stripImages(content) {
  if (Array.isArray(content)) {
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    const hadImage = content.some((b) => b.type === "image");
    return (hadImage ? "[a drawing he shared] " : "") + text;
  }
  return content;
}

async function callClaude(messages, systemExtra = "") {
  const data = await anthropic({
    system: SYSTEM_PROMPT + (systemExtra ? "\n\nMEMORY:\n" + systemExtra : ""),
    messages,
  });
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const DEFAULT_PROFILE = { concepts: [], words: [] };

export default function StoryLearn() {
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [convo, setConvo] = useState([]); // API context (no images, capped)
  const [blocks, setBlocks] = useState([]); // what's shown on screen
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [busy, setBusy] = useState(false);

  // parent report
  const [showReport, setShowReport] = useState(false);
  const [reportUnlocked, setReportUnlocked] = useState(false);
  const [pinEntry, setPinEntry] = useState("");
  const [newPin, setNewPin] = useState("");
  const [reportText, setReportText] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [askText, setAskText] = useState("");
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  useEffect(() => {
    (async () => {
      try {
        const r = await storage.get("learningProfile");
        if (r && r.value) setProfile({ ...DEFAULT_PROFILE, ...JSON.parse(r.value) });
      } catch (e) { /* no profile yet */ }
    })();
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [blocks, busy]);

  async function saveProfile(p) {
    setProfile(p);
    try { await storage.set("learningProfile", JSON.stringify(p)); } catch (e) {}
  }

  function memoryText() {
    const p = profileRef.current;
    const concepts = p.concepts.slice(-10).map((c) => c.name);
    const words = p.words.slice(-10).map((w) => `${w.wrong}->${w.right}`);
    let out = "";
    if (concepts.length) out += `Things he's learned before: ${concepts.join(", ")}\n`;
    if (words.length) out += `Words he's misspelled before (worth reinforcing): ${words.join(", ")}\n`;
    return out;
  }

  const onPickFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage({ dataURL: reader.result, b64: String(reader.result).split(",")[1], mediaType: file.type });
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  function recordTurn(turn) {
    const p = { ...profileRef.current };
    let changed = false;
    if (Array.isArray(turn.spellingCorrections) && turn.spellingCorrections.length) {
      p.words = [...p.words, ...turn.spellingCorrections.map((s) => ({ ...s, date: today() }))];
      changed = true;
    }
    if (turn.learned && typeof turn.learned === "string" &&
        !p.concepts.some((c) => c.name.toLowerCase() === turn.learned.toLowerCase())) {
      p.concepts = [...p.concepts, { name: turn.learned, date: today() }];
      changed = true;
    }
    if (changed) saveProfile(p);
  }

  async function requestTurn(userContent, displayUser) {
    setBusy(true);
    const history = capHistory(convo);
    const apiMsgs = [...history, { role: "user", content: userContent }]; // image only rides on this turn
    try {
      const raw = await callClaude(apiMsgs, memoryText());
      let turn;
      try { turn = JSON.parse(strip(raw)); }
      catch { turn = { reply: raw, spellingCorrections: [], learned: null }; }
      // store a lean, image-free history so future calls stay cheap
      const storedUser = { role: "user", content: stripImages(userContent) };
      setConvo([...history, storedUser, { role: "assistant", content: turn.reply || raw }]);
      setBlocks((b) => [...b, { turn, userShown: displayUser }]);
      recordTurn(turn);
    } catch (e) {
      setBlocks((b) => [...b, { error: "Something went wrong — try sending that again." }]);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const text = input.trim();
    if ((!text && !pendingImage) || busy) return;
    let content;
    if (pendingImage) {
      content = [{ type: "image", source: { type: "base64", media_type: pendingImage.mediaType, data: pendingImage.b64 } }];
      content.push({ type: "text", text: text || "Here's my drawing." });
    } else {
      content = text;
    }
    const disp = { text, img: pendingImage ? pendingImage.dataURL : null };
    setInput(""); setPendingImage(null);
    requestTurn(content, disp);
  }

  function newChat() {
    setConvo([]); setBlocks([]); setInput(""); setPendingImage(null);
  }

  // ---- parent report ----
  function openReport() {
    setShowReport(true);
    setReportUnlocked(false);
    setPinEntry(""); setReportText(""); setAskText("");
  }
  function tryUnlock() {
    if (pinEntry === profileRef.current.parentPin) setReportUnlocked(true);
    else setPinEntry("");
  }
  async function savePin() {
    if (!/^\d{4}$/.test(newPin)) return;
    await saveProfile({ ...profileRef.current, parentPin: newPin });
    setNewPin(""); setReportUnlocked(true);
  }
  async function aiReport(userPrompt) {
    setReportBusy(true);
    try {
      const { parentPin, ...safe } = profileRef.current; // never send the PIN to the model
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: REPORT_SYSTEM,
          messages: [{ role: "user", content: `Saved data (JSON):\n${JSON.stringify(safe)}\n\n${userPrompt}` }],
        }),
      });
      const data = await res.json();
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      setReportText(text || "No report came back — try again.");
    } catch (e) {
      setReportText("Couldn't generate the report — try again.");
    } finally { setReportBusy(false); }
  }
  function copyReport() {
    try { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {}
  }

  return (
    <div className="s-root">
      <style>{`
        * { box-sizing:border-box; }
        .s-root { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
          color:#1f2023; background:#fff; height:100%; display:flex; flex-direction:column;
          border:1px solid #e6e6e8; border-radius:10px; overflow:hidden; max-height:660px; }
        .s-bar { padding:11px 16px; border-bottom:1px solid #ececee; display:flex; justify-content:space-between; align-items:center; }
        .s-bar b { font-size:14px; color:#40424a; }
        .s-bar button { border:none; background:none; color:#6a6c73; font-size:13px; cursor:pointer; font-weight:600; }
        .s-scroll { flex:1; overflow-y:auto; padding:16px; }
        .s-empty { color:#9a9ca4; font-size:15px; text-align:center; margin-top:44px; line-height:1.6; }
        .usermsg { text-align:right; margin:0 0 14px; }
        .usermsg .b { display:inline-block; background:#f0f1f3; padding:8px 12px; border-radius:12px; border-bottom-right-radius:4px; font-size:15px; max-width:80%; text-align:left; white-space:pre-wrap; }
        .usermsg img { max-width:180px; border-radius:8px; display:block; margin:0 0 6px auto; }
        .turn { margin:0 0 18px; }
        .spell { background:#fbf3ef; border:1px solid #f0d9cd; border-radius:9px; padding:9px 12px; margin-bottom:10px; font-size:14px; }
        .spell .h { font-weight:700; color:#b25a35; margin-bottom:3px; }
        .spell .w { font-weight:700; } .spell .w .x { color:#b23b3b; text-decoration:line-through; } .spell .w .r { color:#1f9d6b; }
        .reply { font-size:15.5px; line-height:1.65; white-space:pre-wrap; }
        .s-input { border-top:1px solid #ececee; padding:12px; }
        .thumb { display:inline-flex; align-items:center; gap:8px; background:#f4f4f6; border-radius:8px; padding:6px 8px; margin-bottom:8px; font-size:13px; color:#5a5c63; }
        .thumb img { width:32px; height:32px; object-fit:cover; border-radius:5px; }
        .thumb button { border:none; background:none; color:#8a8c93; cursor:pointer; }
        .inrow { display:flex; align-items:flex-end; gap:8px; }
        textarea.ta { flex:1; resize:none; border:1px solid #d9dade; border-radius:10px; padding:11px 12px; font-family:inherit; font-size:15px; line-height:1.4; max-height:130px; min-height:44px; }
        textarea.ta:focus { outline:none; border-color:#b0b2b8; }
        .ta:disabled { background:#f6f6f7; color:#a0a2a8; }
        .attach { border:1px solid #d9dade; background:#fff; width:44px; height:44px; border-radius:10px; cursor:pointer; font-size:18px; color:#6a6c73; flex:none; }
        .attach:disabled { opacity:.5; cursor:default; }
        .go { border:none; background:#1f2023; color:#fff; height:44px; padding:0 18px; border-radius:10px; cursor:pointer; font-size:15px; font-weight:600; flex:none; }
        .go:disabled { background:#c8c9cd; cursor:default; }
        .dots span { display:inline-block; width:6px; height:6px; margin-right:4px; background:#c2c4ca; border-radius:50%; animation:b 1.2s infinite; }
        .dots span:nth-child(2){ animation-delay:.2s;} .dots span:nth-child(3){ animation-delay:.4s;}
        @keyframes b { 0%,60%,100%{opacity:.3;} 30%{opacity:1;} }
        .rp-overlay { position:absolute; inset:0; background:rgba(20,22,26,.42); display:flex; align-items:center; justify-content:center; padding:16px; z-index:10; }
        .rp { background:#fff; border-radius:12px; width:100%; max-width:520px; max-height:88%; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,.3); }
        .rp-head { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; border-bottom:1px solid #ececee; }
        .rp-head b { font-size:15px; } .rp-head button { border:none; background:none; font-size:18px; color:#8a8c93; cursor:pointer; }
        .rp-body { padding:16px; }
        .rp-stats { display:flex; gap:10px; margin-bottom:14px; }
        .stat { flex:1; background:#f6f6f8; border-radius:9px; padding:10px 12px; text-align:center; }
        .stat .n { font-size:20px; font-weight:700; color:#1f2023; } .stat .l { font-size:12px; color:#6a6c73; margin-top:2px; }
        .rp-btn { border:none; background:#1f2023; color:#fff; padding:9px 15px; border-radius:9px; font-weight:600; font-size:14px; cursor:pointer; }
        .rp-btn:disabled { background:#c8c9cd; cursor:default; }
        .rp-out { white-space:pre-wrap; font-size:14.5px; line-height:1.6; background:#fafafb; border:1px solid #ececee; border-radius:9px; padding:12px; margin-top:12px; }
        .rp-ask { display:flex; gap:8px; margin-top:14px; }
        .rp-ask input { flex:1; border:1px solid #d9dade; border-radius:9px; padding:9px 11px; font-family:inherit; font-size:14px; }
        .rp-ask input:focus { outline:none; border-color:#b0b2b8; }
        .rp-note { font-size:12px; color:#9a9ca4; margin-top:12px; line-height:1.5; }
        .rp-pin { text-align:center; padding:24px 8px; }
        .rp-pin input { border:1px solid #d9dade; border-radius:9px; padding:10px; font-size:18px; text-align:center; letter-spacing:6px; width:140px; }
        .rp-pin input:focus { outline:none; border-color:#b0b2b8; }
        .rp-row { display:flex; gap:8px; align-items:center; justify-content:center; margin-top:12px; }
        .link { color:#6a6c73; font-size:13px; cursor:pointer; background:none; border:none; }
        .s-title { cursor:default; user-select:none; -webkit-user-select:none; }
      `}</style>

      <div className="s-bar">
        <b className="s-title" onClick={openReport}>Chat</b>
        <div>
          {blocks.length > 0 && <button onClick={newChat}>New chat</button>}
        </div>
      </div>

      <div className="s-scroll" ref={scrollRef}>
        {blocks.length === 0 && !busy && (
          <div className="s-empty">Ask a question, upload a drawing,<br />or ask for a story.</div>
        )}

        {blocks.map((bl, idx) => {
          if (bl.error) return <div className="turn" key={idx} style={{ color: "#c0563c" }}>{bl.error}</div>;
          const t = bl.turn;
          return (
            <div key={idx}>
              {bl.userShown && (bl.userShown.text || bl.userShown.img) && (
                <div className="usermsg">
                  {bl.userShown.img && <img src={bl.userShown.img} alt="drawing" />}
                  {bl.userShown.text && <span className="b">{bl.userShown.text}</span>}
                </div>
              )}
              <div className="turn">
                {Array.isArray(t.spellingCorrections) && t.spellingCorrections.length > 0 && (
                  <div className="spell">
                    <div className="h">Spelling fix</div>
                    {t.spellingCorrections.map((s, i) => (
                      <div className="w" key={i}><span className="x">{s.wrong}</span> → <span className="r">{s.right}</span></div>
                    ))}
                  </div>
                )}
                <div className="reply">{t.reply}</div>
              </div>
            </div>
          );
        })}

        {busy && <div className="turn dots"><span></span><span></span><span></span></div>}
      </div>

      <div className="s-input">
        {pendingImage && (
          <div className="thumb">
            <img src={pendingImage.dataURL} alt="attached" />
            <span>Drawing attached</span>
            <button onClick={() => setPendingImage(null)}>✕</button>
          </div>
        )}
        <div className="inrow">
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} style={{ display: "none" }} />
          <button className="attach" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()} title="Attach a drawing">＋</button>
          <textarea className="ta" placeholder="Message"
            value={input} disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} rows={1} />
          <button className="go" disabled={busy || (!input.trim() && !pendingImage)} onClick={send}>Send</button>
        </div>
      </div>

      {showReport && (
        <div className="rp-overlay" onClick={() => setShowReport(false)}>
          <div className="rp" onClick={(e) => e.stopPropagation()}>
            <div className="rp-head">
              <b>Parent report</b>
              <button onClick={() => setShowReport(false)}>✕</button>
            </div>

            {!profile.parentPin ? (
              <div className="rp-body">
                <div className="rp-pin">
                  <div style={{ marginBottom: 4, color: "#40424a", fontSize: 14, fontWeight: 600 }}>Set a parent PIN</div>
                  <div style={{ marginBottom: 12, color: "#8a8c93", fontSize: 12.5, lineHeight: 1.5 }}>
                    Choose a 4-digit PIN. This area stays hidden behind it, so it's not visible to him.
                  </div>
                  <input inputMode="numeric" maxLength={4} value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => { if (e.key === "Enter") savePin(); }} placeholder="1234" />
                  <div className="rp-row"><button className="rp-btn" disabled={!/^\d{4}$/.test(newPin)} onClick={savePin}>Set PIN</button></div>
                </div>
              </div>
            ) : !reportUnlocked ? (
              <div className="rp-body">
                <div className="rp-pin">
                  <div style={{ marginBottom: 10, color: "#40424a", fontSize: 14 }}>Enter parent PIN</div>
                  <input type="password" inputMode="numeric" value={pinEntry} maxLength={4}
                    onChange={(e) => setPinEntry(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => { if (e.key === "Enter") tryUnlock(); }} />
                  <div className="rp-row"><button className="rp-btn" onClick={tryUnlock}>Unlock</button></div>
                </div>
              </div>
            ) : (
              <div className="rp-body">
                <div className="rp-stats">
                  <div className="stat"><div className="n">{profile.concepts.length}</div><div className="l">concepts</div></div>
                  <div className="stat"><div className="n">{profile.words.length}</div><div className="l">words fixed</div></div>
                </div>

                <button className="rp-btn" disabled={reportBusy} onClick={() => aiReport("Write the progress report.")}>
                  {reportBusy ? "Writing…" : "Generate report"}
                </button>

                {reportText && (
                  <>
                    <div className="rp-out">{reportText}</div>
                    <div style={{ marginTop: 8 }}>
                      <button className="link" onClick={copyReport}>{copied ? "Copied" : "Copy"}</button>
                    </div>
                  </>
                )}

                <div className="rp-ask">
                  <input placeholder="Ask about his progress…" value={askText}
                    onChange={(e) => setAskText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && askText.trim()) { aiReport(`The parent asks: "${askText.trim()}". Answer using the data.`); } }} />
                  <button className="rp-btn" disabled={reportBusy || !askText.trim()}
                    onClick={() => aiReport(`The parent asks: "${askText.trim()}". Answer using the data.`)}>Ask</button>
                </div>

                <details style={{ marginTop: 16 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "#6a6c73" }}>Raw records</summary>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#40424a" }}>Things he's learned</div>
                    <div style={{ fontSize: 13.5, color: "#5a5c63", lineHeight: 1.6 }}>{profile.concepts.length ? profile.concepts.map((c) => c.name).join(" · ") : "None yet."}</div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#40424a", marginTop: 8 }}>Words corrected</div>
                    <div style={{ fontSize: 13.5, color: "#5a5c63", lineHeight: 1.6 }}>{profile.words.length ? profile.words.map((w) => `${w.wrong}→${w.right}`).join(" · ") : "None yet."}</div>
                  </div>
                </details>

                <div className="rp-note">
                  This report is generated from what's been saved. It reflects the app's records, not a formal assessment.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
