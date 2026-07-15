import React, { useState, useRef, useEffect, useCallback } from "react";
import { anthropic } from "./api";
import { storage } from "./storage";

/*
  Chat companion (plain look). Answers questions, chats, writes stories on request.
  Behavior lives in SYSTEM_PROMPT. Persistence (shared DB via src/storage.js):
    - "learningProfile" : concepts learned, words corrected, parent PIN
    - "chatList"        : [{ id, title, updatedAt }] for the sidebar
    - "chat:<id>"       : { blocks, convo } for each saved conversation
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
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Cost control: only send recent history, and never re-send images.
const HISTORY_LIMIT = 12;
function capHistory(convo) {
  let h = convo.slice(-HISTORY_LIMIT);
  while (h.length && h[0].role === "assistant") h = h.slice(1);
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
// Keep only the last N chats; older ones are evicted (and their data deleted).
const MAX_CHATS = 50;

// Anthropic resizes anything larger than 1568px on the long edge anyway, so sending
// full-res costs latency + can blow the 5MB/image and Vercel ~4.5MB body limits for
// zero benefit. Downscale on upload. Re-encoding to JPEG also normalizes HEIC.
const API_MAX_EDGE = 1568;
const THUMB_MAX = 160; // px on the long edge, for saved chats
const MAX_B64_BYTES = 4_000_000; // stay well under both limits

function resizeDataURL(dataURL, maxEdge, quality) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h); // flatten transparency for JPEG
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL("image/jpeg", quality));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataURL;
    } catch (e) { resolve(null); }
  });
}
const makeThumb = (dataURL) => resizeDataURL(dataURL, THUMB_MAX, 0.6);

// Persist a thumbnail (not the full base64 image) so storage stays small.
function slimBlocks(blks) {
  return blks.map((b) =>
    b.error ? { error: b.error }
      : {
          turn: b.turn,
          userShown: b.userShown
            ? { text: b.userShown.text || "", thumb: b.userShown.thumb || null, hadImg: !!(b.userShown.img || b.userShown.thumb || b.userShown.hadImg) }
            : null,
        }
  );
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
  const [convo, setConvo] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [imgErr, setImgErr] = useState(null);
  const [busy, setBusy] = useState(false);

  // chats
  const [chatList, setChatList] = useState([]); // [{ id, title, updatedAt }]
  const [currentId, setCurrentId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
  const currentIdRef = useRef(null);
  currentIdRef.current = currentId;

  useEffect(() => {
    (async () => {
      try {
        const r = await storage.get("learningProfile");
        if (r && r.value) setProfile({ ...DEFAULT_PROFILE, ...JSON.parse(r.value) });
      } catch (e) {}
      try {
        const cl = await storage.get("chatList");
        if (cl && cl.value) setChatList(JSON.parse(cl.value));
      } catch (e) {}
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
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    setImgErr(null);
    setPreparing(true);
    const reader = new FileReader();
    reader.onload = async () => {
      // Shrink before it goes anywhere: a phone/tablet photo is far too big to send raw.
      const small = await resizeDataURL(reader.result, API_MAX_EDGE, 0.85);
      const url = small || reader.result;
      const b64 = String(url).split(",")[1] || "";
      if (b64.length > MAX_B64_BYTES) {
        setImgErr("That picture is too big to send. Try a smaller photo.");
        setPreparing(false);
        return;
      }
      setPendingImage({ dataURL: url, b64, mediaType: small ? "image/jpeg" : file.type });
      setPreparing(false);
    };
    reader.onerror = () => { setImgErr("Couldn't read that picture."); setPreparing(false); };
    reader.readAsDataURL(file);
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

  function touchChat(id, maybeTitle) {
    setChatList((prev) => {
      const existing = prev.find((c) => c.id === id);
      const title = existing ? existing.title : (maybeTitle || "New chat");
      const others = prev.filter((c) => c.id !== id);
      const all = [{ id, title, updatedAt: Date.now() }, ...others];
      const next = all.slice(0, MAX_CHATS);
      // drop the data for any chat that fell off the end
      all.slice(MAX_CHATS).forEach((c) => { storage.del("chat:" + c.id).catch(() => {}); });
      storage.set("chatList", JSON.stringify(next)).catch(() => {});
      return next;
    });
  }

  async function persistChat(id, blks, cv) {
    try { await storage.set("chat:" + id, JSON.stringify({ blocks: slimBlocks(blks), convo: cv })); } catch (e) {}
  }

  async function requestTurn(userContent, displayUser) {
    setBusy(true);
    let id = currentIdRef.current;
    const isNew = !id;
    if (!id) { id = genId(); setCurrentId(id); currentIdRef.current = id; }
    const history = capHistory(convo);
    const apiMsgs = [...history, { role: "user", content: userContent }]; // image only on this turn
    try {
      const raw = await callClaude(apiMsgs, memoryText());
      let turn;
      try { turn = JSON.parse(strip(raw)); }
      catch { turn = { reply: raw, spellingCorrections: [], learned: null }; }
      const storedUser = { role: "user", content: stripImages(userContent) };
      const nextConvo = [...history, storedUser, { role: "assistant", content: turn.reply || raw }];
      // full image stays on screen for this session; a thumbnail is what gets saved
      const thumb = displayUser && displayUser.img ? await makeThumb(displayUser.img) : null;
      const shown = displayUser ? { ...displayUser, thumb } : displayUser;
      const nextBlocks = [...blocks, { turn, userShown: shown }];
      setConvo(nextConvo);
      setBlocks(nextBlocks);
      recordTurn(turn);
      const title = displayUser && displayUser.text ? displayUser.text.slice(0, 40)
        : displayUser && displayUser.img ? "Drawing" : "Chat";
      touchChat(id, isNew ? title : undefined);
      persistChat(id, nextBlocks, nextConvo);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "";
      setBlocks((b) => [...b, { error: msg.includes("413") || msg.includes("too large")
        ? "That picture was too big to send. Try a smaller one."
        : "Something went wrong — try sending that again." }]);
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
    setCurrentId(null); currentIdRef.current = null;
    setConvo([]); setBlocks([]); setInput(""); setPendingImage(null);
    setSidebarOpen(false);
  }

  async function loadChat(id) {
    if (id === currentIdRef.current) { setSidebarOpen(false); return; }
    try {
      const r = await storage.get("chat:" + id);
      if (r && r.value) {
        const d = JSON.parse(r.value);
        setBlocks(d.blocks || []);
        setConvo(d.convo || []);
        setCurrentId(id); currentIdRef.current = id;
      }
    } catch (e) {}
    setSidebarOpen(false);
  }

  async function deleteChat(id, e) {
    e.stopPropagation();
    try { await storage.del("chat:" + id); } catch (e2) {}
    setChatList((prev) => {
      const next = prev.filter((c) => c.id !== id);
      storage.set("chatList", JSON.stringify(next)).catch(() => {});
      return next;
    });
    if (currentIdRef.current === id) newChat();
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
      const { parentPin, ...safe } = profileRef.current;
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
        .s-root { position:relative; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
          color:#1f2023; background:#fff; height:100%; display:flex; flex-direction:row;
          border:1px solid #e6e6e8; border-radius:10px; overflow:hidden; max-height:660px; }

        .sb { width:198px; flex:none; border-right:1px solid #ececee; background:#fafafb; display:flex; flex-direction:column; }
        .sb-head { padding:10px; }
        .sb-new { width:100%; border:1px solid #d9dade; background:#fff; border-radius:8px; padding:9px; font-family:inherit; font-weight:600; font-size:13px; cursor:pointer; color:#1f2023; }
        .sb-new:hover { background:#f2f2f4; }
        .sb-list { flex:1; overflow-y:auto; padding:4px 6px 8px; }
        .sb-item { display:flex; align-items:center; gap:4px; padding:8px 9px; border-radius:7px; cursor:pointer; font-size:13px; color:#40424a; }
        .sb-item:hover { background:#f0f1f3; }
        .sb-item.on { background:#e9eaee; font-weight:600; }
        .sb-t { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .sb-x { border:none; background:none; color:#b0b2b8; cursor:pointer; font-size:16px; line-height:1; opacity:0; padding:0 2px; }
        .sb-item:hover .sb-x { opacity:1; }
        .sb-x:hover { color:#c0563c; }
        .sb-empty { color:#9a9ca4; font-size:12.5px; padding:12px 8px; text-align:center; }
        .sb-back { display:none; }

        .s-main { flex:1; min-width:0; display:flex; flex-direction:column; }
        .s-bar { padding:11px 14px; border-bottom:1px solid #ececee; display:flex; align-items:center; gap:8px; }
        .ham { border:none; background:none; font-size:16px; color:#6a6c73; cursor:pointer; display:none; padding:0; }
        .s-bar b { font-size:14px; color:#40424a; }
        .s-title { cursor:default; user-select:none; -webkit-user-select:none; }
        .s-scroll { flex:1; overflow-y:auto; padding:16px; }
        .s-empty { color:#9a9ca4; font-size:15px; text-align:center; margin-top:44px; line-height:1.6; }
        .usermsg { text-align:right; margin:0 0 14px; }
        .usermsg .b { display:inline-block; background:#f0f1f3; padding:8px 12px; border-radius:12px; border-bottom-right-radius:4px; font-size:15px; max-width:80%; text-align:left; white-space:pre-wrap; }
        .usermsg img { max-width:180px; border-radius:8px; display:block; margin:0 0 6px auto; }
        .imgnote { font-size:12.5px; color:#9a9ca4; margin:0 0 6px auto; }
        .turn { margin:0 0 18px; }
        .spell { background:#fbf3ef; border:1px solid #f0d9cd; border-radius:9px; padding:9px 12px; margin-bottom:10px; font-size:14px; }
        .spell .h { font-weight:700; color:#b25a35; margin-bottom:3px; }
        .spell .w { font-weight:700; } .spell .w .x { color:#b23b3b; text-decoration:line-through; } .spell .w .r { color:#1f9d6b; }
        .reply { font-size:15.5px; line-height:1.65; white-space:pre-wrap; }
        .s-input { border-top:1px solid #ececee; padding:12px; }
        .imgerr { background:#fcf1ee; border:1px solid #f0d9cd; color:#b23b3b; border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px; font-weight:600; }
        .imgprep { color:#9a9ca4; font-size:13px; margin-bottom:8px; }
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

        @media (max-width:640px) {
          .sb { position:absolute; z-index:20; height:100%; transform:translateX(-100%); transition:transform .2s ease; box-shadow:2px 0 14px rgba(0,0,0,.16); }
          .sb.open { transform:none; }
          .ham { display:inline-block; }
          .sb-back { display:block; position:absolute; inset:0; background:rgba(20,22,26,.3); z-index:15; }
        }

        .rp-overlay { position:absolute; inset:0; background:rgba(20,22,26,.42); display:flex; align-items:center; justify-content:center; padding:16px; z-index:30; }
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
      `}</style>

      {sidebarOpen && <div className="sb-back" onClick={() => setSidebarOpen(false)} />}

      <div className={"sb" + (sidebarOpen ? " open" : "")}>
        <div className="sb-head">
          <button className="sb-new" onClick={newChat}>+ New chat</button>
        </div>
        <div className="sb-list">
          {chatList.length === 0 && <div className="sb-empty">No chats yet</div>}
          {chatList.map((c) => (
            <div key={c.id} className={"sb-item" + (c.id === currentId ? " on" : "")} onClick={() => loadChat(c.id)}>
              <span className="sb-t">{c.title || "Chat"}</span>
              <button className="sb-x" onClick={(e) => deleteChat(c.id, e)} title="Delete">×</button>
            </div>
          ))}
        </div>
      </div>

      <div className="s-main">
        <div className="s-bar">
          <button className="ham" onClick={() => setSidebarOpen((v) => !v)} title="Chats">☰</button>
          <b className="s-title" onClick={openReport}>Chat</b>
        </div>

        <div className="s-scroll" ref={scrollRef}>
          {blocks.length === 0 && !busy && (
            <div className="s-empty">Ask a question, upload a drawing,<br />or ask for a story.</div>
          )}

          {blocks.map((bl, idx) => {
            if (bl.error) return <div className="turn" key={idx} style={{ color: "#c0563c" }}>{bl.error}</div>;
            const t = bl.turn;
            const us = bl.userShown;
            return (
              <div key={idx}>
                {us && (us.text || us.img || us.thumb || us.hadImg) && (
                  <div className="usermsg">
                    {(us.img || us.thumb) && <img src={us.img || us.thumb} alt="drawing" />}
                    {!us.img && !us.thumb && us.hadImg && <div className="imgnote">🖼 drawing</div>}
                    {us.text && <span className="b">{us.text}</span>}
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
          {imgErr && <div className="imgerr">{imgErr}</div>}
          {preparing && <div className="imgprep">Getting your picture ready…</div>}
          {pendingImage && (
            <div className="thumb">
              <img src={pendingImage.dataURL} alt="attached" />
              <span>Drawing attached</span>
              <button onClick={() => { setPendingImage(null); setImgErr(null); }}>✕</button>
            </div>
          )}
          <div className="inrow">
            <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} style={{ display: "none" }} />
            <button className="attach" disabled={busy || preparing} onClick={() => fileRef.current && fileRef.current.click()} title="Attach a drawing">＋</button>
            <textarea className="ta" placeholder="Message"
              value={input} disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} rows={1} />
            <button className="go" disabled={busy || preparing || (!input.trim() && !pendingImage)} onClick={send}>Send</button>
          </div>
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
                  <div className="stat"><div className="n">{chatList.length}</div><div className="l">chats</div></div>
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
