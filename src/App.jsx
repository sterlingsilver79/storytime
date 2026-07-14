import React, { useState, useRef, useEffect, useCallback } from "react";
import { anthropic } from "./api";
import { storage } from "./storage";

/*
  Story + Learning companion (plain look).
  Behavior lives in SYSTEM_PROMPT. Memory persists via a shared database (see src/storage.js)
  under the key "learningProfile" (concepts learned, words corrected, past stories).

  Design choice you can change: a checkpoint unlocks the next part once he
  ANSWERS it (right or wrong, with the correct answer always shown). Say the
  word if you'd rather it require the correct answer before moving on.
*/

const SYSTEM_PROMPT = `You run an interactive story-and-learning session for Sterling, age 11. He is sharp and dislikes being talked down to, and he struggles with spelling. Teach real things through the story.

Every turn you return ONE JSON object only (no code fences, no text around it):
{
  "spellingCorrections": [ { "wrong": "", "right": "" } ],
  "storyMemory": "one sentence summarizing the whole story so far",
  "story": "the next part of the story (about 60-120 words)",
  "concept": { "name": "", "oneLine": "" },
  "checkpoint": {
    "type": "mc" | "tf" | "open",
    "question": "",
    "options": ["", "", "", ""],
    "correctAnswer": "",
    "explanation": ""
  }
}

Rules:
- SPELLING FIRST: If his message has misspelled words, list each in spellingCorrections as {wrong, right}, using his exact misspelling and the correct spelling. Correct him directly and specifically every time — do not let misspellings slide. If nothing is misspelled, use an empty array.
- REAL LEARNING IN THE STORY: Build the story he asks for, but weave in a genuine, accurate real-world concept (science, nature, space, history, how things work, math, or language). The fantasy is the wrapper; the concept must be true. Put its name and a one-line meaning in "concept".
- CHECKPOINT: End every turn with a question that tests that concept. Rotate the type across turns: "mc" (give 4 options), "tf" (options ["True","False"]), or "open" (omit options or use []). Always fill correctAnswer and a short explanation. It must be answerable from what you just taught.
- MEMORY: You'll be given a summary of past stories, concepts he's learned, and words he's misspelled before. Refer back naturally, don't repeat the same concept, and every few turns make the checkpoint revisit an earlier concept or re-test a word he previously misspelled.
- VOICE: accurate first, simple second. Warm but not gushing. No fake enthusiasm, no piling on praise. Keep segments short so it moves.
- SAFETY: appropriate for an 11-year-old — nothing violent, scary, sexual, or adult; no profanity; never ask for personal info. If he seems upset or unsafe, gently point him to a parent or trusted adult without alarming him. Don't lecture or moralize.`;

const EVAL_SYSTEM = `You judge a child's open-ended answer. Given the question, the intended answer, and the child's answer, decide if the child is essentially correct or on the right track. Return ONLY JSON: {"correct": true or false, "feedback": "one or two warm, specific sentences; if the child misspelled anything, correct it directly (wrong -> right)"}.`;

async function callClaude(messages, systemExtra = "") {
  const data = await anthropic({
    system: SYSTEM_PROMPT + (systemExtra ? "\n\nMEMORY:\n" + systemExtra : ""),
    messages,
  });
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

async function evalOpen(question, intended, child) {
  const data = await anthropic({
    system: EVAL_SYSTEM,
    messages: [{ role: "user", content: `Question: ${question}\nIntended answer: ${intended}\nChild's answer: ${child}` }],
  });
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return JSON.parse(strip(raw));
}

const REPORT_SYSTEM = `You write a short, candid progress report for a PARENT about their 11-year-old son, based on saved data from a story-based learning app he uses. Be specific and useful, not flattering. Cover, in a few short plain paragraphs: what topics and concepts he's been learning; how his spelling is going and any pattern in the words he misspells; his engagement (roughly how much he's done); apparent strengths; gaps or things worth reinforcing; and 2-3 concrete suggestions for what to explore next. Base everything ONLY on the data provided. If the data is thin, say so plainly rather than padding. Write to the parent, not the child.`;

const strip = (t) => t.replace(/```json/gi, "").replace(/```/g, "").trim();
const today = () => new Date().toISOString().slice(0, 10);

const DEFAULT_PROFILE = { concepts: [], words: [], stories: [], currentStory: "" };

export default function StoryLearn() {
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [convo, setConvo] = useState([]); // AI message history
  const [blocks, setBlocks] = useState([]); // rendered turns
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

  // load persisted memory
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
    const stories = [...p.stories.slice(-3).map((s) => s.summary), p.currentStory].filter(Boolean);
    const concepts = p.concepts.slice(-8).map((c) => c.name);
    const words = p.words.slice(-8).map((w) => `${w.wrong}->${w.right}`);
    let out = "";
    if (stories.length) out += `Past/current stories: ${stories.join(" | ")}\n`;
    if (concepts.length) out += `Concepts he's learned: ${concepts.join(", ")}\n`;
    if (words.length) out += `Words he's misspelled before (revisit sometimes): ${words.join(", ")}\n`;
    return out;
  }

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
      const data = await anthropic({
        system: REPORT_SYSTEM,
        messages: [{ role: "user", content: `Saved data (JSON):\n${JSON.stringify(safe)}\n\n${userPrompt}` }],
      });
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      setReportText(text || "No report came back — try again.");
    } catch (e) {
      setReportText("Couldn't generate the report — try again.");
    } finally { setReportBusy(false); }
  }

  function copyReport() {
    try { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {}
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
    if (turn.storyMemory) p.currentStory = turn.storyMemory;
    if (Array.isArray(turn.spellingCorrections) && turn.spellingCorrections.length) {
      p.words = [...p.words, ...turn.spellingCorrections.map((s) => ({ ...s, date: today() }))];
    }
    saveProfile(p);
  }

  function recordConcept(concept) {
    if (!concept || !concept.name) return;
    const p = { ...profileRef.current };
    if (!p.concepts.some((c) => c.name.toLowerCase() === concept.name.toLowerCase())) {
      p.concepts = [...p.concepts, { name: concept.name, oneLine: concept.oneLine, date: today() }];
      saveProfile(p);
    }
  }

  async function requestTurn(userContent, displayUser) {
    setBusy(true);
    const apiMsgs = [...convo, { role: "user", content: userContent }];
    try {
      const raw = await callClaude(apiMsgs, memoryText());
      const turn = JSON.parse(strip(raw));
      setConvo([...apiMsgs, { role: "assistant", content: raw }]);
      setBlocks((b) => [...b, { turn, answered: false, correct: null, selected: null, openText: "", feedback: null, userShown: displayUser }]);
      recordTurn(turn);
    } catch (e) {
      setBlocks((b) => [...b, { error: "That didn't come through — try sending it again." }]);
    } finally {
      setBusy(false);
    }
  }

  function start() {
    const text = input.trim();
    if ((!text && !pendingImage) || busy) return;
    let content;
    if (pendingImage) {
      content = [{ type: "image", source: { type: "base64", media_type: pendingImage.mediaType, data: pendingImage.b64 } }];
      content.push({ type: "text", text: (text || "Write a story about my drawing.") + " Return ONLY the JSON object." });
    } else {
      content = text + " Return ONLY the JSON object.";
    }
    const disp = { text, img: pendingImage ? pendingImage.dataURL : null };
    setInput(""); setPendingImage(null);
    requestTurn(content, disp);
  }

  async function submitAnswer(idx) {
    const block = blocks[idx];
    const cp = block.turn.checkpoint;
    if (!cp) return;

    if (cp.type === "open") {
      const ans = (block.openText || "").trim();
      if (!ans) return;
      setBusy(true);
      try {
        const res = await evalOpen(cp.question, cp.correctAnswer, ans);
        updateBlock(idx, { answered: true, correct: !!res.correct, feedback: res.feedback });
      } catch (e) {
        updateBlock(idx, { answered: true, correct: null, feedback: "Good try. The idea we were after: " + cp.explanation });
      } finally { setBusy(false); }
    } else {
      const sel = block.selected;
      if (sel == null) return;
      const correct = String(sel).trim().toLowerCase() === String(cp.correctAnswer).trim().toLowerCase();
      updateBlock(idx, { answered: true, correct });
    }
    recordConcept(block.turn.concept);
  }

  function updateBlock(idx, patch) {
    setBlocks((b) => b.map((bl, i) => (i === idx ? { ...bl, ...patch } : bl)));
  }

  function continueStory(idx) {
    const block = blocks[idx];
    const cp = block.turn.checkpoint;
    const ans = cp.type === "open" ? block.openText : block.selected;
    const verdict = block.correct === true ? "correct" : block.correct === false ? "incorrect" : "answered";
    const msg = `My answer to "${cp.question}" was "${ans}" (${verdict}). Continue the story to the next part and checkpoint. Return ONLY the JSON object.`;
    requestTurn(msg, null);
  }

  function newStory() {
    const p = { ...profileRef.current };
    if (p.currentStory) { p.stories = [...p.stories, { summary: p.currentStory, date: today() }]; p.currentStory = ""; }
    saveProfile(p);
    setConvo([]); setBlocks([]); setInput(""); setPendingImage(null);
  }

  const lastIdx = blocks.length - 1;
  const gateOpen = blocks.length === 0 || (blocks[lastIdx] && (blocks[lastIdx].error || (blocks[lastIdx].turn && blocks[lastIdx].answered)));

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
        .usermsg .b { display:inline-block; background:#f0f1f3; padding:8px 12px; border-radius:12px; border-bottom-right-radius:4px; font-size:15px; max-width:80%; text-align:left; }
        .usermsg img { max-width:180px; border-radius:8px; display:block; margin:0 0 6px auto; }
        .turn { margin:0 0 18px; }
        .spell { background:#fbf3ef; border:1px solid #f0d9cd; border-radius:9px; padding:9px 12px; margin-bottom:10px; font-size:14px; }
        .spell .h { font-weight:700; color:#b25a35; margin-bottom:3px; }
        .spell .w { font-weight:700; } .spell .w .x { color:#b23b3b; text-decoration:line-through; } .spell .w .r { color:#1f9d6b; }
        .story { font-size:15.5px; line-height:1.65; margin-bottom:8px; white-space:pre-wrap; }
        .concept { font-size:13px; color:#5a5c63; background:#f5f6f8; border-radius:7px; padding:6px 10px; margin-bottom:12px; }
        .concept b { color:#40424a; }
        .cp { border:1px solid #e6e6e8; border-radius:10px; padding:13px; }
        .cp .q { font-weight:600; font-size:15px; margin-bottom:10px; }
        .opt { display:block; width:100%; text-align:left; border:1px solid #d9dade; background:#fff; border-radius:9px; padding:9px 12px; margin-bottom:7px; font-size:14.5px; cursor:pointer; font-family:inherit; }
        .opt:hover:not(:disabled) { background:#f6f6f8; }
        .opt.sel { border-color:#1f2023; }
        .opt.right { border-color:#1f9d6b; background:#eefaf3; }
        .opt.wrong { border-color:#d98a76; background:#fcf1ee; }
        .opt:disabled { cursor:default; }
        textarea.open { width:100%; border:1px solid #d9dade; border-radius:9px; padding:10px; font-family:inherit; font-size:14.5px; min-height:60px; resize:vertical; }
        textarea.open:focus { outline:none; border-color:#b0b2b8; }
        .cpbtn { margin-top:9px; border:none; background:#1f2023; color:#fff; padding:9px 16px; border-radius:9px; font-weight:600; font-size:14px; cursor:pointer; }
        .cpbtn:disabled { background:#c8c9cd; cursor:default; }
        .result { margin-top:10px; font-size:14px; line-height:1.5; }
        .result .tag { font-weight:700; }
        .result .tag.ok { color:#1f9d6b; } .result .tag.no { color:#c0563c; }
        .expl { color:#40424a; margin-top:3px; }
        .locknote { color:#9a9ca4; font-size:12.5px; margin-top:8px; }
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
        .cont { border:none; background:#1f2023; color:#fff; padding:10px 16px; border-radius:10px; cursor:pointer; font-size:15px; font-weight:600; width:100%; }
        .cont:disabled { background:#c8c9cd; }
        .prog { padding:12px 16px; border-bottom:1px solid #ececee; background:#fafafb; font-size:13.5px; }
        .prog h4 { margin:0 0 6px; font-size:13px; color:#40424a; }
        .prog .list { color:#5a5c63; line-height:1.6; }
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
        <b className="s-title" onClick={openReport}>Story &amp; Learning</b>
        <div>
          {blocks.length > 0 && <button onClick={newStory}>New story</button>}
        </div>
      </div>

      <div className="s-scroll" ref={scrollRef}>
        {blocks.length === 0 && !busy && (
          <div className="s-empty">Tell it what the story should be about,<br />or attach a drawing to start.</div>
        )}

        {blocks.map((bl, idx) => {
          if (bl.error) return <div className="turn" key={idx} style={{ color: "#c0563c" }}>{bl.error}</div>;
          const t = bl.turn, cp = t.checkpoint;
          const isLast = idx === lastIdx;
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
                <div className="story">{t.story}</div>
                {t.concept && t.concept.name && (
                  <div className="concept"><b>{t.concept.name}</b> — {t.concept.oneLine}</div>
                )}

                {cp && (
                  <div className="cp">
                    <div className="q">{cp.question}</div>

                    {cp.type !== "open" && (cp.options || []).map((opt, oi) => {
                      let cls = "opt";
                      if (bl.answered) {
                        if (String(opt).toLowerCase() === String(cp.correctAnswer).toLowerCase()) cls += " right";
                        else if (bl.selected === opt) cls += " wrong";
                      } else if (bl.selected === opt) cls += " sel";
                      return (
                        <button key={oi} className={cls} disabled={bl.answered || busy}
                          onClick={() => updateBlock(idx, { selected: opt })}>{opt}</button>
                      );
                    })}

                    {cp.type === "open" && (
                      <textarea className="open" placeholder="Type your answer" value={bl.openText}
                        disabled={bl.answered || busy}
                        onChange={(e) => updateBlock(idx, { openText: e.target.value })} />
                    )}

                    {!bl.answered && (
                      <button className="cpbtn" disabled={busy || (cp.type === "open" ? !bl.openText.trim() : bl.selected == null)}
                        onClick={() => submitAnswer(idx)}>Check answer</button>
                    )}

                    {bl.answered && (
                      <div className="result">
                        <span className={"tag " + (bl.correct ? "ok" : "no")}>{bl.correct ? "Correct." : "Not quite."}</span>
                        <div className="expl">{cp.type === "open" ? bl.feedback : cp.explanation}</div>
                        {cp.type !== "open" && !bl.correct && (
                          <div className="expl">Answer: <b>{cp.correctAnswer}</b></div>
                        )}
                      </div>
                    )}

                    {!bl.answered && <div className="locknote">Answer this to keep going.</div>}
                  </div>
                )}

                {isLast && bl.answered && (
                  <div style={{ marginTop: 12 }}>
                    <button className="cont" disabled={busy} onClick={() => continueStory(idx)}>Continue</button>
                  </div>
                )}
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
          <button className="attach" disabled={!gateOpen || busy} onClick={() => fileRef.current && fileRef.current.click()} title="Attach a drawing">＋</button>
          <textarea className="ta" placeholder={gateOpen ? "What should the story be about?" : "Answer the question above to continue"}
            value={input} disabled={!gateOpen || busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } }} rows={1} />
          <button className="go" disabled={!gateOpen || busy || (!input.trim() && !pendingImage)} onClick={start}>Send</button>
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
                  <div className="stat"><div className="n">{profile.stories.length}</div><div className="l">stories done</div></div>
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
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#40424a" }}>Concepts learned</div>
                    <div style={{ fontSize: 13.5, color: "#5a5c63", lineHeight: 1.6 }}>{profile.concepts.length ? profile.concepts.map((c) => c.name).join(" · ") : "None yet."}</div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#40424a", marginTop: 8 }}>Words corrected</div>
                    <div style={{ fontSize: 13.5, color: "#5a5c63", lineHeight: 1.6 }}>{profile.words.length ? profile.words.map((w) => `${w.wrong}→${w.right}`).join(" · ") : "None yet."}</div>
                  </div>
                </details>

                <div className="rp-note">
                  This report is generated from what's been saved on this device. It reflects the app's records, not a formal assessment.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
