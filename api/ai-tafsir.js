// api/ai-tafsir.js
// Vercel Serverless Function. Deploy path: POST /api/ai-tafsir
//
// কী করে: ব্রাউজার থেকে প্রশ্ন নিয়ে Google-এর ফ্রি Gemini API-তে পাঠায়,
// উত্তর ফেরত দেয়। GEMINI_API_KEY কখনো ব্রাউজারে যায় না — শুধু এই
// সার্ভারলেস ফাংশনের ভেতরেই থাকে, তাই কেউ পেজ সোর্স দেখেও চুরি করতে
// পারবে না।
//
// কেন Gemini: Google AI Studio-র ফ্রি টায়ারে API key নিতে কোনো কার্ড
// লাগে না, মেয়াদও শেষ হয় না (শুধু রেট-লিমিট আছে) — ২০২৬ সালে এটাই
// একমাত্র বড় প্রোভাইডার যেখানে সত্যিকারের "no card" ফ্রি টায়ার আছে।
//
// রেট-লিমিট কেন লাগলো: ফ্রি টায়ারের পুরো কোটা (দৈনিক ~১৫০০ রিকোয়েস্ট)
// আপনার অ্যাপের সব ইউজারের মধ্যে ভাগ হয় — একজন ইউজার অতিরিক্ত ব্যবহার
// করলে বাকি সবার জন্য অ্যাপ বন্ধ হয়ে যেতে পারে। তাই প্রতি ইউজার/ডিভাইস
// প্রতিদিন সর্বোচ্চ DAILY_LIMIT-টা প্রশ্ন করতে পারবে — নিচে বদলানো যায়।
//
// প্রয়োজনীয় প্যাকেজ (project root এ, package.json দেখুন):
//   npm install firebase-admin
//   (এই ফাংশনের জন্য নতুন কিছু install করতে হয় না — Node-এর বিল্ট-ইন
//   fetch() দিয়েই Gemini API কল করা হয়েছে)
//
// প্রয়োজনীয় Environment Variables (Vercel Dashboard → Settings → Environment Variables):
//   GEMINI_API_KEY             -> aistudio.google.com থেকে ফ্রি নেওয়া API key (SETUP_AI_TAFSIR.txt দেখুন)
//   FIREBASE_SERVICE_ACCOUNT   -> আগে থেকেই থাকার কথা (api/send-reset-email.js এর জন্য যেটা বসানো হয়েছিল) —
//                                  এটাই দিয়ে দৈনিক প্রশ্ন-সংখ্যা গোনা হয়

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

const db = admin.firestore();

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// প্রতি ইউজার/ডিভাইস প্রতিদিন সর্বোচ্চ কতগুলো প্রশ্ন করতে পারবে।
const DAILY_LIMIT = 20;

const SYSTEM_PROMPT = `আপনি "কুরআন বাংলা" অ্যাপের একজন সহায়ক ইসলামিক জ্ঞান-সহকারী। আপনার কাজ কুরআনের আয়াত ও সাধারণ ইসলামি বিষয়ে বাংলা ভাষায় প্রশ্নের উত্তর দেওয়া।

কঠোরভাবে মেনে চলার নিয়ম:
১) ব্যবহারকারীকে যদি নির্দিষ্ট আয়াতের আরবি টেক্সট ও অনুবাদ দেওয়া হয়, সেটাকেই মূল ভিত্তি ধরে উত্তর দিন — নিজের থেকে ভিন্ন আয়াত অনুমান করবেন না।
২) তাফসীরবিদদের মধ্যে মতভেদ থাকা বিষয়ে সেটা সততার সাথে উল্লেখ করুন (যেমন "কিছু তাফসীরে... অন্যদিকে...") — একটি মতকে একমাত্র সঠিক হিসেবে চাপিয়ে দেবেন না।
৩) দুর্বল সনদ বা মতভেদপূর্ণ বর্ণনাকে কখনো নিশ্চিত সহীহ হিসেবে দাবি করবেন না।
৪) আপনি কোনো ফতোয়া বা চূড়ান্ত ব্যক্তিগত ধর্মীয় রায় দেন না। ব্যক্তিগত জীবনের গুরুত্বপূর্ণ সিদ্ধান্ত (বিবাহ, তালাক, মিরাস, ইত্যাদি নির্দিষ্ট মাসআলা) সংক্রান্ত প্রশ্নে সবসময় বলুন একজন যোগ্য স্থানীয় আলেমের সাথে সরাসরি কথা বলতে।
৫) উত্তর মোটামুটি সংক্ষিপ্ত ও স্পষ্ট রাখুন (কয়েকটি অনুচ্ছেদ), যদি না ব্যবহারকারী নিজে বিস্তারিত/গভীর ব্যাখ্যা চান।
৬) আপনি একজন AI সহকারী, মানব আলেম নন — এটা কখনো আড়াল করবেন না বা ভুলে যাবেন না।
৭) সবসময় বাংলায় উত্তর দিন, বিনয়ী ও শ্রদ্ধাশীল ভাষায়।`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST ব্যবহার করুন' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'not_configured' });
  }

  const { question, history, ayahContext, idToken, deviceId } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'প্রশ্ন দেওয়া হয়নি' });
  }
  if (question.length > 800) {
    return res.status(400).json({ error: 'প্রশ্নটি অনেক লম্বা — একটু ছোট করে লিখুন' });
  }

  try {
    // ---------- ১) কে জিজ্ঞেস করছে — সাইন-ইন করা থাকলে যাচাইকৃত uid, নাহলে anonymous device id ----------
    let limitKey = null;
    if (idToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        limitKey = 'u_' + decoded.uid;
      } catch (e) { /* invalid/expired token — নিচে deviceId দিয়ে fallback হবে */ }
    }
    if (!limitKey) {
      if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'শনাক্তকরণ তথ্য নেই' });
      }
      limitKey = 'd_' + deviceId.slice(0, 64);
    }

    // ---------- ২) দৈনিক রেট-লিমিট চেক + বৃদ্ধি (একটাই transaction, race-condition safe) ----------
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const usageRef = db.collection('ai_tafsir_usage').doc(`${limitKey}_${today}`);
    const remaining = await db.runTransaction(async (t) => {
      const snap = await t.get(usageRef);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= DAILY_LIMIT) return -1;
      t.set(usageRef, { count: count + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return DAILY_LIMIT - count - 1;
    });
    if (remaining < 0) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    // ---------- ৩) Gemini-কে পাঠানোর মতো contents সাজানো ----------
    const contents = [];
    let contextIntro = '';
    if (ayahContext && ayahContext.arabic) {
      contextIntro = `[প্রেক্ষাপট — ${ayahContext.surahBn || ''}, আয়াত ${ayahContext.ayahNum || ''}]\nআরবি: ${ayahContext.arabic}\nঅনুবাদ: ${ayahContext.translation || ''}\n\n`;
    }
    const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
    safeHistory.forEach((turn) => {
      if (turn && (turn.role === 'user' || turn.role === 'model') && turn.parts && turn.parts[0] && typeof turn.parts[0].text === 'string') {
        contents.push({ role: turn.role, parts: [{ text: turn.parts[0].text.slice(0, 2000) }] });
      }
    });
    contents.push({ role: 'user', parts: [{ text: contextIntro + question.trim() }] });

    // ---------- ৪) Gemini API কল ----------
    const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini API error:', geminiRes.status, errText);
      return res.status(502).json({ error: 'ai_error' });
    }

    const data = await geminiRes.json();
    const answer = data && data.candidates && data.candidates[0] && data.candidates[0].content
      ? (data.candidates[0].content.parts || []).map(p => p.text || '').join('').trim()
      : '';

    if (!answer) {
      // সাধারণত safety filter ব্লক করলে candidates খালি আসে
      return res.status(200).json({
        answer: 'দুঃখিত, এই প্রশ্নের সরাসরি উত্তর দেওয়া গেল না। প্রশ্নটি একটু ভিন্নভাবে জিজ্ঞাসা করে দেখুন।',
        remainingToday: remaining,
      });
    }

    return res.status(200).json({ answer, remainingToday: remaining });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
};
