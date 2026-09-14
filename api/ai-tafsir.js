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

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

const db = admin.firestore();

// গুগল মাঝেমধ্যেই ফ্রি মডেলের নাম/লাইনআপ বদলায়। Vercel-এর Function log-এ
// "model not found"-জাতীয় এরর দেখলে aistudio.google.com-এ বর্তমান ফ্রি
// মডেলের নাম দেখে শুধু এই একটা লাইন বদলে দিলেই চলবে।
const GEMINI_MODEL = 'gemini-2.5-flash';
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST ব্যবহার করুন' });
  }

  if (!process.env.GEMINI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('ai-tafsir: GEMINI_API_KEY অথবা FIREBASE_SERVICE_ACCOUNT env variable সেট করা নেই');
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

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
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

    if (!geminiRes.ok) {
      // Vercel Dashboard → Project → Logs-এ এই লাইনটা দেখলে আসল কারণ
      // (ভুল API key, ভুল মডেল নাম, কোটা শেষ, বিলিং লাগবে ইত্যাদি) বোঝা যাবে
      console.error('ai-tafsir: Gemini API error', geminiRes.status, JSON.stringify(geminiData));
      // ব্যর্থ কলের জন্য দৈনিক সীমা থেকে এই প্রশ্নটা ফেরত দিন — Google/
      // আমাদের সমস্যায় ইউজারের কোটা যেন নষ্ট না হয়
      await usageRef.set({ count: admin.firestore.FieldValue.increment(-1) }, { merge: true });
      return res.status(502).json({ error: 'upstream_error' });
    }

    const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
    const answer = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || '').join('')
      : '';

    return res.status(200).json({
      answer: answer || 'দুঃখিত, উত্তর তৈরি করা যায়নি।',
      remainingToday: Math.max(0, DAILY_LIMIT - newCount),
    });
  } catch (e) {
    console.error('ai-tafsir: unexpected error', e);
    return res.status(500).json({ error: 'server_error' });
  }
};
