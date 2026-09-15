// api/ai-tafsir.js
// Vercel Serverless Function — Deploy path: POST /api/ai-tafsir
//
// js/ai-tafsir.js (ব্রাউজার) শুধু এখানে প্রশ্ন পাঠায় আর উত্তর দেখায়।
// আসল Gemini API কলটা এই ফাইলেই (সার্ভারে) হয় — তাই GEMINI_API_KEY
// কখনো ব্রাউজারে/ক্লায়েন্ট কোডে যায় না।
//
// প্রয়োজনীয় প্যাকেজ: firebase-admin (root package.json-এ আগে থেকেই আছে,
// নতুন কিছু npm install করার দরকার নেই)।
//
// প্রয়োজনীয় Environment Variables (Vercel Dashboard → Settings →
// Environment Variables → Production ও Preview দুই জায়গাতেই):
//   GEMINI_API_KEY             -> https://aistudio.google.com থেকে ফ্রি key
//   FIREBASE_SERVICE_ACCOUNT   -> আগে থেকেই থাকার কথা (send-reset-email.js
//                                 ফিচারের জন্য বসানো হয়েছিল); এখানেও
//                                 সাইন-ইন যাচাই ও দৈনিক প্রশ্ন-সংখ্যা
//                                 গোনার জন্য ব্যবহৃত হয়।
//
// env variable যোগ/পরিবর্তনের পর Vercel-এ Redeploy বাধ্যতামূলক —
// নাহলে চলমান ডিপ্লয়মেন্ট নতুন variable দেখতে পাবে না।
//
// ==== এই আপডেটে যা ঠিক হয়েছে ====
// ১) FIREBASE_SERVICE_ACCOUNT না থাকলে বা ভুল ফরম্যাটে থাকলে আগে পুরো
//    ফাংশনটাই ক্র্যাশ করে HTML/খালি এরর পেজ দিত (JSON.parse module-এর
//    টপ-লেভেলে ছিল) — ব্রাউজারে তখন res.json() পার্স ব্যর্থ হয়ে
//    "ইন্টারনেট সংযোগ পরীক্ষা করুন" জাতীয় ভুল বার্তা দেখাতো, আসল কারণ
//    (কনফিগ মিসিং) কখনো বোঝা যেতো না। এখন এটা try/catch দিয়ে ধরা হয় এবং
//    পরিষ্কার JSON এরর (`not_configured`) ফেরত দেয়।
// ২) FIREBASE_SERVICE_ACCOUNT পেস্ট করার সময় private_key এর ভেতরের
//    নিউলাইন (\n) মাঝে মাঝে literal দুই-ক্যারেক্টার ব্যাকস্ল্যাশ-n হয়ে
//    যায় (Vercel dashboard এ পেস্ট করার সময়) — এতে admin.credential.cert
//    ব্যর্থ হয়। এখন সেটা স্বয়ংক্রিয়ভাবে ঠিক করে নেয়।
// ৩) গুগল প্রায়ই ফ্রি মডেলের নাম/লাইনআপ বদলায় বা বন্ধ করে দেয় (যেমন
//    gemini-2.5-flash ১৬ অক্টোবর ২০২৬-এ বন্ধ হয়ে যাচ্ছে)। আগে একটামাত্র
//    মডেল নাম হার্ডকোড ছিল — সেটা বন্ধ/পরিবর্তন হলেই পুরো ফিচার মরে
//    যেতো। এখন একটা লিস্ট আছে — একটা মডেল ব্যর্থ হলে (৪০৪/কোটা/অন্য
//    এরর) সাথে সাথে পরেরটা স্বয়ংক্রিয়ভাবে ট্রাই হয়, ইউজার কিছুই টের
//    পায় না। ভবিষ্যতে গুগল আবার নাম বদলালেও অ্যাপ নিজে থেকেই সামলে
//    নেবে যতক্ষণ লিস্টের অন্তত একটা মডেল চালু থাকে।

const admin = require('firebase-admin');

// ---------- Firebase Admin init (ক্র্যাশ-প্রুফ) ----------
let firebaseInitError = null;
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env variable খালি/নেই');
    const svc = JSON.parse(raw);
    // Vercel dashboard-এ পেস্ট করার সময় private_key এর নিউলাইন মাঝে মাঝে
    // literal "\n" (ব্যাকস্ল্যাশ + n) থেকে যায় — থাকলে আসল নিউলাইনে বদলে দিন।
    if (svc && typeof svc.private_key === 'string') {
      svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } catch (e) {
    firebaseInitError = e;
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// ---------- Gemini মডেল — ফলব্যাক লিস্ট (উপর থেকে নিচে ক্রমানুসারে ট্রাই হয়) ----------
// গুগল ফ্রি মডেল প্রায়ই বদলায়/বন্ধ করে — একটা ব্যর্থ হলে পরেরটা অটো ট্রাই হয়।
// সবগুলো ব্যর্থ হলে aistudio.google.com এ গিয়ে বর্তমান ফ্রি মডেলের নাম
// দেখে এই লিস্টের উপরে নতুন একটা লাইন যোগ করে দিলেই চলবে।
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite', // স্থিতিশীল, ফ্রি (billing লাগে না) — কমপক্ষে মে ২০২৭ পর্যন্ত
  'gemini-3.5-flash-lite', // নতুন স্থিতিশীল ভার্সন, ফ্রি — কমপক্ষে জুলাই ২০২৭ পর্যন্ত
  'gemini-2.5-flash',      // পুরনো মডেল, ১৬ অক্টোবর ২০২৬-এ বন্ধ হবে — ততদিন ব্যাকআপ হিসেবে
  'gemini-flash-latest',   // গুগলের অটো-আপডেট alias — উপরের সব ব্যর্থ হলে শেষ ভরসা
];
const DAILY_LIMIT = 20; // ইউজার/ডিভাইস প্রতি দৈনিক প্রশ্নের সীমা

const SYSTEM_PROMPT = 'আপনি একজন বিনয়ী ও জ্ঞানী ইসলামিক সহকারী। কুরআনের আয়াত ও ইসলামী বিষয়ে সহজ, নির্ভরযোগ্য বাংলা ভাষায় উত্তর দিন। উত্তর সংক্ষিপ্ত ও প্রাসঙ্গিক রাখুন। নিশ্চিত না হলে স্পষ্টভাবে সেটা জানান এবং একজন আলেমের সাথে পরামর্শ করার পরামর্শ দিন।';

function todayKeyDhaka() {
  // এশিয়া/ঢাকা সময় অনুযায়ী "আজ" — দিন বদল বাংলাদেশ সময়ের মধ্যরাতে হয়,
  // UTC মধ্যরাতে না। en-CA লোকেল সরাসরি YYYY-MM-DD ফরম্যাট দেয়।
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// একটা নির্দিষ্ট মডেল দিয়ে Gemini কল করে — সফল হলে answer টেক্সট, নাহলে null
async function tryOneModel(model, contents) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
      }),
    }
  );
  const geminiData = await geminiRes.json().catch(() => ({}));
  const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
  const answer = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map((p) => p.text || '').join('').trim()
    : '';

  if (!geminiRes.ok || !answer) {
    return { ok: false, status: geminiRes.status, data: geminiData };
  }
  return { ok: true, answer };
}

// GEMINI_MODELS লিস্ট ক্রমানুসারে ট্রাই করে — প্রথমটা ব্যর্থ হলে পরেরটা,
// এভাবে যতক্ষণ না একটা কাজ করে বা লিস্ট শেষ হয়ে যায়।
async function askGeminiWithFallback(contents) {
  let lastFailure = null;
  for (const model of GEMINI_MODELS) {
    try {
      const result = await tryOneModel(model, contents);
      if (result.ok) return { answer: result.answer, modelUsed: model };
      // Vercel Dashboard → Project → Logs-এ এই লাইনটা দেখলে কোন মডেল কেন
      // ব্যর্থ হলো (ভুল নাম, কোটা শেষ, বিলিং লাগবে ইত্যাদি) বোঝা যাবে
      console.error(`ai-tafsir: model "${model}" ব্যর্থ, status ${result.status}`, JSON.stringify(result.data).slice(0, 500));
      lastFailure = result;
    } catch (e) {
      console.error(`ai-tafsir: model "${model}" কল করতে গিয়ে এরর:`, e.message);
      lastFailure = { status: 0, data: { error: e.message } };
    }
  }
  return { answer: null, failure: lastFailure };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST ব্যবহার করুন' });
  }

  if (!process.env.GEMINI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT || firebaseInitError || !db) {
    console.error(
      'ai-tafsir: not configured —',
      !process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY নেই' : '',
      !process.env.FIREBASE_SERVICE_ACCOUNT ? 'FIREBASE_SERVICE_ACCOUNT নেই' : '',
      firebaseInitError ? `Firebase init এরর: ${firebaseInitError.message}` : ''
    );
    return res.status(500).json({ error: 'not_configured' });
  }

  const { question, history, ayahContext, idToken, deviceId } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'প্রশ্ন দেওয়া হয়নি' });
  }

  // পরিচয় নির্ধারণ — সাইন-ইন থাকলে Firebase uid যাচাই করে, না থাকলে
  // anonymous deviceId দিয়ে দৈনিক সীমা গোনা হয়
  let identityKey = null;
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      identityKey = `uid_${decoded.uid}`;
    } catch (e) {
      console.error('ai-tafsir: idToken যাচাই ব্যর্থ:', e.message);
    }
  }
  if (!identityKey) {
    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(401).json({ error: 'পরিচয় শনাক্ত করা যায়নি, আবার চেষ্টা করুন' });
    }
    identityKey = `dev_${deviceId}`;
  }

  const usageRef = db.collection('ai_tafsir_usage').doc(`${identityKey}_${todayKeyDhaka()}`);

  try {
    // দৈনিক সীমা — ট্রানজেকশনে গুনে বাড়ানো হয়, যাতে পরপর দ্রুত একাধিক
    // রিকোয়েস্ট (যেমন ডাবল-ট্যাপ) এলেও কেউ সীমা এড়িয়ে যেতে না পারে
    let newCount = null;
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const current = snap.exists ? (snap.data().count || 0) : 0;
      if (current >= DAILY_LIMIT) return false;
      newCount = current + 1;
      tx.set(usageRef, {
        count: newCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });

    if (!allowed) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    // পূর্ববর্তী চ্যাট-হিস্ট্রি (সর্বোচ্চ শেষ ১০ টার্ন — টোকেন খরচ নিয়ন্ত্রণে)
    const contents = [];
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    for (const turn of trimmedHistory) {
      if (turn && (turn.role === 'user' || turn.role === 'model') && Array.isArray(turn.parts)) {
        const text = String((turn.parts[0] && turn.parts[0].text) || '').slice(0, 4000);
        if (text) contents.push({ role: turn.role, parts: [{ text }] });
      }
    }

    let questionText = question.trim().slice(0, 2000);
    if (ayahContext && typeof ayahContext === 'object' && ayahContext.arabic) {
      const surahBn = String(ayahContext.surahBn || '').slice(0, 200);
      const ayahNum = String(ayahContext.ayahNum || '').slice(0, 20);
      const arabic = String(ayahContext.arabic || '').slice(0, 1000);
      const translation = String(ayahContext.translation || '').slice(0, 2000);
      questionText = `[প্রসঙ্গ: ${surahBn} আয়াত ${ayahNum} — ${arabic}${translation ? ' — অনুবাদ: ' + translation : ''}]\n\n${questionText}`;
    }
    contents.push({ role: 'user', parts: [{ text: questionText }] });

    const { answer } = await askGeminiWithFallback(contents);

    if (!answer) {
      // লিস্টের সবগুলো মডেলই ব্যর্থ হলে দৈনিক সীমা থেকে এই প্রশ্নটা ফেরত
      // দিন — Google/আমাদের সমস্যায় ইউজারের কোটা যেন নষ্ট না হয়
      await usageRef.set({ count: admin.firestore.FieldValue.increment(-1) }, { merge: true });
      return res.status(502).json({ error: 'upstream_error' });
    }

    return res.status(200).json({
      answer,
      remainingToday: Math.max(0, DAILY_LIMIT - newCount),
    });
  } catch (e) {
    console.error('ai-tafsir: unexpected error', e);
    return res.status(500).json({ error: 'server_error' });
  }
};
