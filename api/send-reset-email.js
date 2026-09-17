// api/send-reset-email.js
// Vercel Serverless Function. Deploy path: POST /api/send-reset-email
//
// কেন এটা লাগলো: Firebase Console-এর "Customize action URL" UI বাগ করছিল,
// তাই সেই সেটিং console থেকে না করে সরাসরি কোডে actionCodeSettings দিয়ে
// দেওয়া হচ্ছে — generatePasswordResetLink() নিজেই secure link বানায়
// (Firebase-ই token verify করবে, এটা কোনো custom/insecure token না),
// শুধু email পাঠানোটা এখন আমরা নিজেরা Gmail SMTP দিয়ে করছি।
//
// প্রয়োজনীয় প্যাকেজ: firebase-admin, nodemailer (root package.json এ
// ইতিমধ্যে দুটোই আছে, নতুন কিছু npm install করার দরকার নেই)।
//
// প্রয়োজনীয় Environment Variables (Vercel Dashboard → Settings →
// Environment Variables → Production ও Preview দুই জায়গাতেই):
//   FIREBASE_SERVICE_ACCOUNT   -> আগে থেকেই থাকার কথা (api/ai-tafsir.js
//                                 ফিচারের জন্যও ব্যবহৃত হয়)
//   GMAIL_USER                 -> আপনার Gmail ঠিকানা
//   GMAIL_APP_PASSWORD         -> Google App Password (সাধারণ পাসওয়ার্ড না)
//                                 ধাপে ধাপে সেটআপ: SETUP_PASSWORD_RESET.txt
//
// ==== এই আপডেটে যা ঠিক হয়েছে (আগে "পাসওয়ার্ড রিসেট করতে গেলে কিছু একটা
// সমস্যা হয়েছে, আবার চেষ্টা করুন" ছাড়া আর কিছুই দেখা যেতো না) ====
// ১) এই ফাইলটা আগে থেকে লেখা থাকলেও ব্রাউজারের কোনো কোড থেকেই এটা কল করা
//    হতো না — js/auth.js ও js/profile-view.js তখনো সরাসরি Firebase ক্লায়েন্ট
//    SDK এর fbAuth.sendPasswordResetEmail() ব্যবহার করত, যেটা Console-এর
//    ওই বাগি action-URL সেটিং এর উপরেই নির্ভরশীল ছিল (উপরের কমেন্ট অনুযায়ী
//    যেটা কাজ করছিল না) — তাই ইমেইল পাঠানোর প্রথম ধাপেই ব্যর্থ হতো, generic
//    এরর ছাড়া কিছু বোঝার উপায় ছিল না। এখন js/auth.js ও js/profile-view.js
//    (তিনটা reset-email trigger জায়গাতেই) এই এন্ডপয়েন্টে POST করে —
//    Console-এর বাগি সেটিং আর স্পর্শই করা হয় না।
// ২) handleCodeInApp: false ছিল — এর মানে লিংকে ক্লিক করলে Firebase-এর
//    নিজস্ব ডিফল্ট পেজে (firebaseapp.com/__/auth/action) যেতো, আমাদের
//    নিজস্ব index.html?mode=resetPassword&oobCode=... এ না — অথচ
//    js/reset-password.js পুরোপুরি এই নিজস্ব-পেজ-হ্যান্ডলিং এর জন্যই লেখা
//    (দেখুন সেই ফাইলের নিজস্ব কমেন্ট)। এখন true করা হয়েছে, তাই লিংক সরাসরি
//    আমাদের ইন-অ্যাপ রিসেট-স্ক্রিনে নিয়ে আসে।
// ৩) FIREBASE_SERVICE_ACCOUNT মিসিং/ভুল-ফরম্যাট থাকলে আগে module লোড হওয়ার
//    সময়েই crash করতো (JSON.parse টপ-লেভেলে, try/catch ছাড়া) — এখন
//    api/ai-tafsir.js এর একই প্যাটার্ন অনুসরণ করে ধরা হয়, পরিষ্কার
//    `not_configured` JSON এরর ফেরত দেয় (HTML/খালি এরর পেজের বদলে), আর
//    private_key এর ভেতরের literal "\n" ও একইভাবে অটো-ফিক্স হয় (Vercel
//    dashboard এ পেস্ট করার সময় মাঝে মাঝে হয়ে যায়)।

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// ---------- Firebase Admin init (ক্র্যাশ-প্রুফ, api/ai-tafsir.js এর প্যাটার্ন) ----------
let firebaseInitError = null;
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env variable খালি/নেই');
    const svc = JSON.parse(raw);
    if (svc && typeof svc.private_key === 'string') {
      svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } catch (e) {
    firebaseInitError = e;
  }
}

// GMAIL_USER/GMAIL_APP_PASSWORD না থাকলে transporter বানানোই হয় না (undefined
// থেকে যায়) — নিচে module.exports এ এটা চেক করে পরিষ্কার not_configured
// এরর ফেরত দেয়, sendMail কল করে গিয়ে অস্পষ্ট auth এরর পাওয়ার বদলে।
let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST ব্যবহার করুন' });
  }

  if (!admin.apps.length || firebaseInitError || !transporter) {
    console.error(
      'send-reset-email: not configured —',
      firebaseInitError ? `Firebase init এরর: ${firebaseInitError.message}` : '',
      !transporter ? 'GMAIL_USER/GMAIL_APP_PASSWORD নেই' : ''
    );
    return res.status(500).json({ error: 'not_configured' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'ইমেইল দেওয়া হয়নি' });
  }
  const cleanEmail = email.trim();

  try {
    // এই url টাই Console-এর Action URL এর বদলি — এখানেই সরাসরি বসছে,
    // তাই বাগি console UI স্পর্শ করারই দরকার নেই। handleCodeInApp: true
    // মানে লিংক সরাসরি এই URL এ (?mode=resetPassword&oobCode=... সহ) নিয়ে
    // আসে — js/reset-password.js ঠিক এই ফরম্যাটটাই আশা করে।
    const actionCodeSettings = {
      url: 'https://quranview.vercel.app/index.html',
      handleCodeInApp: true,
    };

    const link = await admin.auth().generatePasswordResetLink(cleanEmail, actionCodeSettings);

    await transporter.sendMail({
      from: `"কুরআন বাংলা" <${process.env.GMAIL_USER}>`,
      to: cleanEmail,
      subject: 'আপনার পাসওয়ার্ড রিসেট করুন',
      html: `
        <p>সালাম,</p>
        <p>আপনার কুরআন বাংলা অ্যাকাউন্টের পাসওয়ার্ড রিসেট করতে নিচের লিংকে ক্লিক করুন:</p>
        <p><a href="${link}">${link}</a></p>
        <p>আপনি যদি এই অনুরোধ না করে থাকেন, তাহলে এই ইমেইলটি উপেক্ষা করুন।</p>
      `,
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    // ইমেইল রেজিস্টার্ড না থাকলেও একই সফল মেসেজ দিন (security best
    // practice — কোন ইমেইল রেজিস্টার্ড আছে সেটা বাইরের কেউ বুঝতে পারবে না)
    if (e.code === 'auth/user-not-found') {
      return res.status(200).json({ success: true });
    }
    console.error('send-reset-email:', e);
    return res.status(500).json({ error: 'পাঠাতে ব্যর্থ হয়েছে' });
  }
};
