// ============================================================
// AI তাফসীর / প্রশ্নোত্তর সহকারী
// ============================================================
// এই ফাইল শুধু ব্রাউজার থেকে POST /api/ai-tafsir এ প্রশ্ন পাঠায় আর
// উত্তর দেখায়। আসল AI (Gemini) কলটা api/ai-tafsir.js (Vercel সার্ভারলেস
// ফাংশন) করে — তাই Gemini API key কখনো এই ফাইলে বা ব্রাউজারে থাকে না।
//
// সেটআপ (সম্পূর্ণ ফ্রি, কোনো কার্ড লাগে না): SETUP_AI_TAFSIR.txt দেখুন।
//
// দুইটা এন্ট্রি-পয়েন্ট:
//  ১) রিডারে প্রতিটি আয়াতের নিচে "AI তাফসীর" বাটন — openAiTafsirModal(ayahCtx)
//     সেই আয়াতের আরবি+অনুবাদ প্রেক্ষাপট হিসেবে নিয়ে খোলে।
//  ২) ড্রয়ারের "AI তাফসীর সহকারী" — openAiTafsirModal(null), সাধারণ প্রশ্নোত্তর মোড।
//
// ==== আধুনিকীকরণ (এই আপডেট) ====
// নেটওয়ার্ক/অথ/রেট-লিমিট লজিক অপরিবর্তিত — শুধু UI/UX স্তরে যোগ হয়েছে:
//  · প্রতিটি মডেল-বাবলের পাশে ছোট্ট অ্যাভাটার + **বোল্ড**/বুলেট/নাম্বার-লিস্ট
//    রেন্ডারিং (formatAiTafsirText) — আগে উত্তর পুরোপুরি প্লেইন টেক্সট ছিল
//  · উত্তরের নিচে কপি বাটন (navigator.clipboard, বাকি অ্যাপের প্যাটার্ন অনুসরণ করে)
//  · ইনপুট বার এখন অটো-গ্রো (আগে সবসময় ১ লাইনে আটকে থাকতো) + hard
//    maxlength + ২০০০-ক্যারেক্টার সীমার কাছে গেলে কাউন্টার দেখায়
//    (ব্যাকএন্ড api/ai-tafsir.js এই সীমাতেই সাইলেন্টলি ছেঁটে দিতো)
//  · সেন্ড বাটনে বিজি অবস্থায় স্পিনার (আগে শুধু disabled+faded ছিল)
//  · প্রতিটি নতুন বার্তায় হালকা fade+slide-in — glow/blur/gradient কোথাও
//    নেই, prefers-reduced-motion এ base.css এর গ্লোবাল রুল অনুযায়ী বন্ধ হয়ে যায়
//  · বাগফিক্স: চিপ একবার লুকানোর পর (প্রথম প্রশ্ন পাঠানোর পরে) মোডাল বন্ধ
//    করে আবার খুললে chips.style.display='none' রয়ে যেত — নতুন সাজেশন আর
//    কখনো দেখাতো না। এখন প্রতিবার openAiTafsirModal এ রিসেট হয়।
// ============================================================

let aiTafsirHistory = [];        // [{role:'user'|'model', parts:[{text}]}, ...] — চলতি চ্যাটের সব টার্ন
let aiTafsirCurrentAyah = null;  // {surahBn, ayahNum, arabic, translation} অথবা null (general mode)
let aiTafsirBusy = false;

const AI_TAFSIR_AYAH_PROMPTS = [
  'এই আয়াতের মূল শিক্ষা কী?',
  'এই আয়াতটি কখন/কোন প্রেক্ষাপটে নাযিল হয়েছিল?',
  'আজকের জীবনে এই আয়াত কীভাবে প্রয়োগ করা যায়?'
];
const AI_TAFSIR_GENERAL_PROMPTS = [
  'সালাতে মনোযোগ ধরে রাখার উপায় কী?',
  'কুরআন তেলাওয়াতের আদব কী কী?',
  'তাওবা করার সঠিক নিয়ম কী?'
];

const AIT_MAX_CHARS = 2000;          // api/ai-tafsir.js এর question.slice(0,2000) এর সাথে মিলিয়ে রাখা
const AIT_COUNTER_THRESHOLD = 1800;  // এর নিচে কাউন্টার লুকানো থাকে, অহেতুক জায়গা নেয় না
const AIT_TEXTAREA_MAX_H = 120;      // css/ai-tafsir.css এর textarea max-height এর সাথে মিলিয়ে রাখা

function aiTafsirDeviceId(){
  let id = localStorage.getItem('qb_ait_device_id');
  if(!id){
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try{ localStorage.setItem('qb_ait_device_id', id); }catch(e){}
  }
  return id;
}

async function aiTafsirAuthPayload(){
  try{
    if(typeof fbAuth !== 'undefined' && fbAuth && fbAuth.currentUser){
      const idToken = await fbAuth.currentUser.getIdToken();
      return { idToken };
    }
  }catch(e){ /* সাইন-ইন থাকলেও token আনতে ব্যর্থ হলে নিচে anonymous fallback */ }
  return { deviceId: aiTafsirDeviceId() };
}

// ---------- হালকা মার্কডাউন → HTML (pure JS, কোনো লাইব্রেরি নেই) ----------
// সাপোর্ট করে: **বোল্ড**, *ইটালিক*, "- "/"• "/"* " বুলেট লিস্ট,
// "1. "/"১. " নাম্বার লিস্ট (বাংলা+ইংরেজি অঙ্ক দুটোই), খালি লাইনে প্যারাগ্রাফ ব্রেক।
// escapeHtml() দিয়ে আগেই এসকেপ করা টেক্সটের উপর কাজ করে — তাই AI-এর উত্তরে
// আক্ষরিক HTML থাকলেও তা কখনো ট্যাগ হিসেবে রেন্ডার হবে না, নিরাপদ।
const AIT_BULLET_RE = /^[-*•]\s+(.+)/;
const AIT_NUMBERED_RE = /^([০-৯]+|\d+)[.)]\s+(.+)/;

function aiTafsirInline(str){
  return str
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function formatAiTafsirText(text){
  const escaped = escapeHtml(text || '').replace(/\r\n/g, '\n');
  const lines = escaped.split('\n');
  const blocks = [];
  let para = [];
  let list = null; // {type:'ul'|'ol', items:[]}

  const flushPara = () => { if(para.length){ blocks.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if(list){ blocks.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } };

  lines.forEach(raw => {
    const line = raw.trim();
    const bullet = line.match(AIT_BULLET_RE);
    const numbered = !bullet && line.match(AIT_NUMBERED_RE);
    if(bullet){
      flushPara();
      if(!list || list.type !== 'ul'){ flushList(); list = { type: 'ul', items: [] }; }
      list.items.push('<li>' + aiTafsirInline(bullet[1]) + '</li>');
    } else if(numbered){
      flushPara();
      if(!list || list.type !== 'ol'){ flushList(); list = { type: 'ol', items: [] }; }
      list.items.push('<li>' + aiTafsirInline(numbered[2]) + '</li>');
    } else if(line === ''){
      flushPara(); flushList();
    } else {
      flushList();
      para.push(aiTafsirInline(line));
    }
  });
  flushPara(); flushList();

  return blocks.join('') || '';
}

// ---------- মডেল-বার্তার অ্যাভাটার — হেডার/ড্রয়ারের wand-sparkles আইকনের
// সাথে সামঞ্জস্যপূর্ণ, যাতে পুরো ফিচার জুড়ে একই "AI" ভিজ্যুয়াল আইডেন্টিটি থাকে ----------
function aiTafsirAvatarEl(){
  const span = document.createElement('span');
  span.className = 'ait-avatar';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
  return span;
}

function aiTafsirCopyBtn(rawText){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ait-copy-btn';
  btn.setAttribute('aria-label', 'উত্তর কপি করুন');
  btn.innerHTML = '<i class="fa-regular fa-copy"></i> কপি';
  btn.onclick = () => {
    if(!navigator.clipboard) return;
    navigator.clipboard.writeText(rawText).then(() => {
      btn.classList.add('ait-copied');
      btn.innerHTML = '<i class="fa-solid fa-check"></i> কপি হয়েছে';
      if(typeof showToast === 'function') showToast('কপি হয়েছে');
      setTimeout(() => {
        btn.classList.remove('ait-copied');
        btn.innerHTML = '<i class="fa-regular fa-copy"></i> কপি';
      }, 1600);
    }).catch(() => {});
  };
  return btn;
}

// ayahCtx দিলে সেই আয়াত-প্রসঙ্গে খোলে, null দিলে সাধারণ প্রশ্নোত্তর মোডে।
function openAiTafsirModal(ayahCtx){
  aiTafsirCurrentAyah = ayahCtx || null;
  aiTafsirHistory = [];

  const head = document.getElementById('aiTafsirHeadCtx');
  const chips = document.getElementById('aiTafsirChips');
  const body = document.getElementById('aiTafsirChat');
  const input = document.getElementById('aiTafsirInput');
  if(!head || !chips || !body || !input) return;

  body.innerHTML = '';
  input.value = '';
  aiTafsirResizeInput();
  aiTafsirUpdateCharCount();

  if(ayahCtx){
    head.style.display = 'block';
    head.innerHTML = `
      <div class="ait-ctx-surah">${escapeHtml(ayahCtx.surahBn || '')} · আয়াত ${toBn(ayahCtx.ayahNum || '')}</div>
      <div class="ait-ctx-ar">${ayahCtx.arabic || ''}</div>
      ${ayahCtx.translation ? `<div class="ait-ctx-tr">${escapeHtml(ayahCtx.translation)}</div>` : ''}`;
    chips.innerHTML = AI_TAFSIR_AYAH_PROMPTS.map(p => `<button type="button" class="ait-chip">${p}</button>`).join('');
  } else {
    head.style.display = 'none';
    head.innerHTML = '';
    chips.innerHTML = AI_TAFSIR_GENERAL_PROMPTS.map(p => `<button type="button" class="ait-chip">${p}</button>`).join('');
  }
  chips.style.display = ''; // আগের সেশনে চিপ হাইড হয়ে থাকলেও নতুন মোডাল-ওপেনে ফিরিয়ে আনে

  document.querySelectorAll('#aiTafsirChips .ait-chip').forEach(c => {
    c.onclick = () => { input.value = c.textContent; sendAiTafsirQuestion(); };
  });

  appendAiTafsirBubble('model', ayahCtx
    ? 'এই আয়াত নিয়ে যা জানতে চান জিজ্ঞাসা করুন। নিচের সাজেশনগুলো থেকেও বেছে নিতে পারেন।'
    : 'ইসলাম বা কুরআন নিয়ে যেকোনো প্রশ্ন করুন। কোনো নির্দিষ্ট আয়াতের ব্যাখ্যা জানতে চাইলে রিডারে সেই আয়াতের নিচের "AI তাফসীর" বাটন থেকে জিজ্ঞাসা করলে আরও নির্ভুল উত্তর পাবেন।'
  );

  openModal('aiTafsirModal');
  input.focus();
}

function appendAiTafsirBubble(role, text, isError){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return null;

  const row = document.createElement('div');
  row.className = 'ait-msg ait-msg-' + role;
  if(role === 'model') row.appendChild(aiTafsirAvatarEl());

  const col = document.createElement('div');
  col.className = 'ait-msg-col';

  const bubble = document.createElement('div');
  bubble.className = 'ait-bubble ait-' + role + (isError ? ' ait-error' : '');
  bubble.innerHTML = formatAiTafsirText(text);
  col.appendChild(bubble);

  if(role === 'model' && !isError && text && text.trim()){
    col.appendChild(aiTafsirCopyBtn(text));
  }

  row.appendChild(col);
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
  return bubble;
}

function appendAiTafsirTyping(){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return null;

  const row = document.createElement('div');
  row.className = 'ait-msg ait-msg-model';
  row.appendChild(aiTafsirAvatarEl());

  const col = document.createElement('div');
  col.className = 'ait-msg-col';
  const bubble = document.createElement('div');
  bubble.className = 'ait-bubble ait-model ait-typing';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  col.appendChild(bubble);

  row.appendChild(col);
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
  return row; // .remove() পুরো সারি (অ্যাভাটারসহ) সরিয়ে দেবে
}

// ---------- ইনপুট বার: অটো-গ্রো টেক্সটএরিয়া + ক্যারেক্টার কাউন্টার ----------
// আগে টেক্সটএরিয়া সবসময় ১ লাইনের উচ্চতায় আটকে থাকতো (ভেতরে স্ক্রল হতো);
// এখন লেখা বাড়ার সাথে সাথে বক্সও বাড়ে (সর্বোচ্চ ১২০px), তারপর ভেতরে স্ক্রল হয়।
function aiTafsirResizeInput(){
  const el = document.getElementById('aiTafsirInput');
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, AIT_TEXTAREA_MAX_H) + 'px';
}

function aiTafsirUpdateCharCount(){
  const el = document.getElementById('aiTafsirInput');
  const counter = document.getElementById('aiTafsirCharCount');
  if(!el || !counter) return;
  const len = el.value.length;
  if(len >= AIT_COUNTER_THRESHOLD){
    counter.textContent = `${toBn(len)} / ${toBn(AIT_MAX_CHARS)}`;
    counter.classList.add('ait-visible');
  } else {
    counter.classList.remove('ait-visible');
  }
}

function aiTafsirSetSendLoading(loading){
  const btn = document.getElementById('aiTafsirSend');
  if(!btn) return;
  btn.classList.toggle('ait-send-loading', loading);
  btn.innerHTML = loading
    ? '<i class="fa-solid fa-circle-notch fa-spin"></i>'
    : '<i class="fa-solid fa-paper-plane"></i>';
}

async function sendAiTafsirQuestion(){
  if(aiTafsirBusy) return;
  const inputEl = document.getElementById('aiTafsirInput');
  const sendBtn = document.getElementById('aiTafsirSend');
  if(!inputEl) return;
  const question = inputEl.value.trim();
  if(!question) return;

  // প্রথম প্রশ্ন পাঠানোর পরে সাজেস্টেড চিপগুলো (এই আয়াতের মূল শিক্ষা কী?
  // ইত্যাদি) আর দরকার নেই — এগুলো সরিয়ে দিলে চ্যাট এরিয়া বড় জায়গা পায়,
  // ফলে AI-এর উত্তর ভালোভাবে দেখা যায়।
  const chipsEl = document.getElementById('aiTafsirChips');
  if(chipsEl && chipsEl.childElementCount){
    chipsEl.innerHTML = '';
    chipsEl.style.display = 'none';
  }

  inputEl.value = '';
  aiTafsirResizeInput();
  aiTafsirUpdateCharCount();
  appendAiTafsirBubble('user', question);
  aiTafsirHistory.push({ role: 'user', parts: [{ text: question }] });

  aiTafsirBusy = true;
  if(sendBtn){ sendBtn.disabled = true; }
  aiTafsirSetSendLoading(true);
  const typingEl = appendAiTafsirTyping();

  try{
    const authPart = await aiTafsirAuthPayload();
    const res = await fetch('/api/ai-tafsir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: aiTafsirHistory.slice(0, -1),
        ayahContext: aiTafsirCurrentAyah,
        ...authPart
      })
    });
    const data = await res.json().catch(() => ({}));
    if(typingEl) typingEl.remove();

    if(!res.ok){
      aiTafsirHistory.pop();
      if(data.error === 'rate_limited'){
        appendAiTafsirBubble('model', 'আজকের জন্য প্রশ্নের সীমা শেষ হয়ে গেছে 🙏 আগামীকাল আবার চেষ্টা করুন।', true);
      } else if(data.error === 'not_configured'){
        appendAiTafsirBubble('model', 'এই ফিচারটি এখনো সেটআপ করা হয়নি। SETUP_AI_TAFSIR.txt ফাইলটি অনুসরণ করুন।', true);
      } else {
        appendAiTafsirBubble('model', 'দুঃখিত, এখন উত্তর দিতে পারছি না। একটু পর আবার চেষ্টা করুন।', true);
      }
      return;
    }

    appendAiTafsirBubble('model', data.answer || '');
    aiTafsirHistory.push({ role: 'model', parts: [{ text: data.answer || '' }] });
    if(typeof data.remainingToday === 'number'){
      const counter = document.getElementById('aiTafsirRemaining');
      if(counter) counter.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> আজ আর ${toBn(data.remainingToday)}টি প্রশ্ন করা যাবে`;
    }
  }catch(e){
    if(typingEl) typingEl.remove();
    aiTafsirHistory.pop();
    appendAiTafsirBubble('model', 'ইন্টারনেট সংযোগ পরীক্ষা করুন।', true);
  }finally{
    aiTafsirBusy = false;
    if(sendBtn){ sendBtn.disabled = false; }
    aiTafsirSetSendLoading(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sendBtn = document.getElementById('aiTafsirSend');
  const inputEl = document.getElementById('aiTafsirInput');
  const closeBtn = document.getElementById('aiTafsirClose');
  const chatEl = document.getElementById('aiTafsirChat');

  if(chatEl){
    chatEl.setAttribute('role', 'log');
    chatEl.setAttribute('aria-live', 'polite');
  }

  if(inputEl){
    inputEl.maxLength = AIT_MAX_CHARS;

    // টেক্সটএরিয়াকে একটা wrapper এর ভেতরে ঢুকিয়ে সেখানে ক্যারেক্টার-কাউন্টার
    // বসানো হয় — pure JS দিয়ে DOM নোড সরানো হচ্ছে, index.html ছোঁয়া হয়নি;
    // existing event listeners (যেগুলো নিচে বসছে) এই মুভের পরেও ঠিক থাকে।
    const wrap = document.createElement('div');
    wrap.className = 'ait-input-wrap';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);
    const counter = document.createElement('span');
    counter.id = 'aiTafsirCharCount';
    counter.className = 'ait-char-count';
    wrap.appendChild(counter);

    inputEl.addEventListener('input', () => { aiTafsirResizeInput(); aiTafsirUpdateCharCount(); });
    inputEl.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendAiTafsirQuestion(); }
    });
  }

  if(sendBtn) sendBtn.onclick = sendAiTafsirQuestion;
  if(closeBtn) closeBtn.onclick = () => closeModal('aiTafsirModal');
  if(typeof wireModalBackdrop === 'function') wireModalBackdrop('aiTafsirModal');
});
