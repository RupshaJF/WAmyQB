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
//  ১) রিডারে প্রতিটি আয়াতের নিচে "✨ AI তাফসীর" বাটন — openAiTafsirModal(ayahCtx)
//     সেই আয়াতের আরবি+অনুবাদ প্রেক্ষাপট হিসেবে নিয়ে খোলে।
//  ২) ড্রয়ারের "AI তাফসীর সহকারী" — openAiTafsirModal(null), সাধারণ প্রশ্নোত্তর মোড।
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

  document.querySelectorAll('#aiTafsirChips .ait-chip').forEach(c => {
    c.onclick = () => { input.value = c.textContent; sendAiTafsirQuestion(); };
  });

  appendAiTafsirBubble('model', ayahCtx
    ? 'এই আয়াত নিয়ে যা জানতে চান জিজ্ঞাসা করুন। নিচের সাজেশনগুলো থেকেও বেছে নিতে পারেন।'
    : 'ইসলাম বা কুরআন নিয়ে যেকোনো প্রশ্ন করুন। কোনো নির্দিষ্ট আয়াতের ব্যাখ্যা জানতে চাইলে রিডারে সেই আয়াতের নিচের "✨ AI তাফসীর" বাটন থেকে জিজ্ঞাসা করলে আরও নির্ভুল উত্তর পাবেন।'
  );

  openModal('aiTafsirModal');
  input.focus();
}

function appendAiTafsirBubble(role, text, isError){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return null;
  const div = document.createElement('div');
  div.className = 'ait-bubble ait-' + role + (isError ? ' ait-error' : '');
  div.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function appendAiTafsirTyping(){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return null;
  const div = document.createElement('div');
  div.className = 'ait-bubble ait-model ait-typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
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
  appendAiTafsirBubble('user', question);
  aiTafsirHistory.push({ role: 'user', parts: [{ text: question }] });

  aiTafsirBusy = true;
  if(sendBtn) sendBtn.disabled = true;
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
      if(counter) counter.textContent = `আজ আর ${toBn(data.remainingToday)}টি প্রশ্ন করা যাবে`;
    }
  }catch(e){
    if(typingEl) typingEl.remove();
    aiTafsirHistory.pop();
    appendAiTafsirBubble('model', 'ইন্টারনেট সংযোগ পরীক্ষা করুন।', true);
  }finally{
    aiTafsirBusy = false;
    if(sendBtn) sendBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sendBtn = document.getElementById('aiTafsirSend');
  const inputEl = document.getElementById('aiTafsirInput');
  const closeBtn = document.getElementById('aiTafsirClose');

  if(sendBtn) sendBtn.onclick = sendAiTafsirQuestion;
  if(inputEl){
    inputEl.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendAiTafsirQuestion(); }
    });
  }
  if(closeBtn) closeBtn.onclick = () => closeModal('aiTafsirModal');
  if(typeof wireModalBackdrop === 'function') wireModalBackdrop('aiTafsirModal');
});
