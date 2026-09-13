// ---------- WhatsApp-style "Status" feature (smart / modern edition) ----------
// A row of circular avatars sits above the Daily-Ayah card on the home tab —
// your own status (tap the + to post) plus everyone else's active (last
// 24h) statuses. Tapping a circle opens a full-screen story viewer with
// segmented progress bars, tap-to-advance / hold-to-pause, quick emoji
// reactions, and — for your own status only — a "কারা দেখেছে" (who viewed)
// list with a live count, exactly like WhatsApp. Both posting AND viewing
// require a completed sign-in/sign-up (js/auth.js openAuthFlow) — there is
// no guest path here. Every visual here is flat solid color / borders —
// no glow, blur, or drop-shadow "lighting" effects anywhere.
//
// Three status types can be posted from the composer's segmented switcher:
//   টেক্সট (text)  — background color (curated palette or any custom flat
//                     color via a native color picker), a chosen font from
//                     a visual specimen sheet, text alignment, and 3 text
//                     sizes.
//   ছবি   (image)  — a photo + optional caption (unchanged from before).
//   আয়াত  (ayah)   — pick any Surah + Ayah number; the Arabic (Uthmani) and
//                     Bangla translation are fetched from the same Quran
//                     API the rest of the app already uses and rendered as
//                     a shareable Ayah card with a "সূরা X, আয়াত Y" tag.
//
// Viewing a status has WhatsApp-style quick reactions (❤️😂😮😢🙏👍) for
// other people's statuses, and — for your own — a reaction-count chip next
// to the view count, with each viewer's reaction (if any) shown in the
// "কারা দেখেছে" sheet. Long-pressing someone's circle on the home row mutes
// them (grey ring, sorted to the end) without affecting seen/unseen
// tracking. Deleting a status now uses an in-app confirm bar instead of the
// browser's native confirm().
//
// Firestore layout (see firestore.rules for the matching security rules):
//   statuses/{statusId}                 one doc per posted status
//     uid, name, avatarColor, avatarIcon  — snapshot of the poster
//     type: 'text' | 'image' | 'ayah'
//     text        — status text (type:text) or optional caption (type:image)
//     bgIndex     — index into STATUS_BG_COLORS (type:text/ayah)
//     bgColor     — custom hex color, overrides bgIndex when present
//     font        — id from STATUS_FONTS (type:text)
//     textAlign   — 'left' | 'center' | 'right' (type:text)
//     textSize    — 'sm' | 'md' | 'lg' (type:text)
//     imageData   — compressed JPEG data URL (type:image)
//     surahNum, ayahNum, surahName, arabicText, translation — (type:ayah)
//     createdAt, expiresAt — client epoch-ms (24h TTL; expired ones simply
//                             stop matching the "still active" query below —
//                             no cleanup job needed for them to disappear)
//     viewCount   — denormalized counter, +1 per unique viewer
//     reactionCount — denormalized counter, +1/-1 as people react/un-react
//   statuses/{statusId}/views/{viewerUid}
//     name, avatarColor, avatarIcon, viewedAt
//   statuses/{statusId}/reactions/{reactorUid}
//     emoji, name, avatarColor, avatarIcon, reactedAt

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_ITEM_MS = 6000; // how long a single item plays before auto-advancing
const STATUS_ROW_CACHE_MS = 40000;

const STATUS_BG_COLORS = ['#2E6F5E','#7A2E44','#3D4F8A','#6B3F8A','#8A4A2E','#2E6B8A','#5A6B2E','#3A3A46','#4A7A9E','#9E4A6B'];

const STATUS_FONTS = [
  { id:'sans',    family:"'Hind Siliguri', sans-serif",           weight:600 },
  { id:'serif',   family:"'Noto Serif Bengali', Georgia, serif",  weight:600 },
  { id:'mono',    family:"'Courier New', monospace",              weight:700 },
  { id:'script',  family:"cursive",                                weight:500 },
  { id:'display', family:"Impact, 'Hind Siliguri', sans-serif",   weight:700, upper:true }
];

const STATUS_TEXT_SIZES = { sm:22, md:26, lg:32 };            // composer preview sizes
const STATUS_VIEW_TEXT_SIZES = { sm:22, md:28, lg:36 };       // full-screen viewer sizes
const STATUS_ALIGN_CYCLE = ['left','center','right'];
const STATUS_SIZE_CYCLE = ['sm','md','lg'];
const STATUS_REACTIONS = ['❤️','😂','😮','😢','🙏','👍'];

// Standard ayah-count-per-surah table (114 entries, surah 1..114) — used
// only to bound the ayah-number input in the picker sheet.
const SURAH_AYAH_COUNTS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];

let statusGroupsCache = [];  // last fetched groups, {uid,name,avatarColor,avatarIcon,items:[]}[]
let statusRowFetchedAt = 0;
let statusRowLoading = false;

let statusComposerState = {
  mode:'text', colorIndex:0, bgColor:null, fontIndex:0, textAlign:'center', textSize:'md',
  imageDataUrl:null, textValue:'', captionText:'', ayah:null, sending:false
};

let statusViewerState = {
  open:false, groups:[], groupIndex:0, itemIndex:0,
  timer:null, itemStartedAt:0, remainingMs:0, paused:false, currentFill:null
};

let pendingDeleteItem = null;
let pendingDeleteGroup = null;

// ---------- Local (per-device) caches — only drive the ring color / avoid
// re-sending duplicate view or reaction writes / remember mutes; the real
// counts + viewer/reaction lists always live server-side so they're correct
// from any device (js/idb.js) ----------
function getSeenStatusIds(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_seen') || '[]')); }catch(e){ return new Set(); }
}
function markStatusSeenLocally(id){
  const set = getSeenStatusIds();
  if(set.has(id)) return;
  set.add(id);
  const arr = Array.from(set);
  try{ IDBKV.set('qr_status_seen', JSON.stringify(arr.length > 300 ? arr.slice(arr.length - 300) : arr)); }catch(e){}
}
function getRecordedViewIds(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_view_recorded') || '[]')); }catch(e){ return new Set(); }
}
function markViewRecordedLocally(id){
  const set = getRecordedViewIds();
  if(set.has(id)) return;
  set.add(id);
  const arr = Array.from(set);
  try{ IDBKV.set('qr_status_view_recorded', JSON.stringify(arr.length > 500 ? arr.slice(arr.length - 500) : arr)); }catch(e){}
}
function getMutedUids(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_muted') || '[]')); }catch(e){ return new Set(); }
}
function toggleMuteUid(uid){
  const set = getMutedUids();
  if(set.has(uid)) set.delete(uid); else set.add(uid);
  try{ IDBKV.set('qr_status_muted', JSON.stringify(Array.from(set))); }catch(e){}
}
function getMyReactionsCache(){
  try{ return JSON.parse(IDBKV.get('qr_status_my_reactions') || '{}'); }catch(e){ return {}; }
}
function setMyReactionCache(statusId, emoji){
  const map = getMyReactionsCache();
  if(emoji) map[statusId] = emoji; else delete map[statusId];
  try{ IDBKV.set('qr_status_my_reactions', JSON.stringify(map)); }catch(e){}
}

// ==================================================================
// Home-tab row
// ==================================================================
function renderStatusRow(){
  const wrap = document.getElementById('statusRow');
  if(!wrap) return;

  if(!state.user){
    wrap.innerHTML = `
      <button type="button" class="status-locked-bar" id="statusLockedBar">
        <div class="status-locked-ic"><i class="fa-solid fa-circle-user"></i></div>
        <div class="status-locked-text">
          <div class="status-locked-title">স্ট্যাটাস দেখতে সাইন ইন করুন</div>
          <div class="status-locked-sub">অন্যদের স্ট্যাটাস দেখতে ও নিজে স্ট্যাটাস দিতে অ্যাকাউন্ট প্রয়োজন</div>
        </div>
        <i class="fa-solid fa-chevron-left"></i>
      </button>`;
    const bar = document.getElementById('statusLockedBar');
    if(bar) bar.onclick = () => openAuthFlow('choice');
    return;
  }

  if(!document.getElementById('statusRowInner')){
    wrap.innerHTML = `<div class="status-row" id="statusRowInner"></div>`;
  }
  renderStatusRowFromCache();

  const fresh = (Date.now() - statusRowFetchedAt) < STATUS_ROW_CACHE_MS;
  if(!fresh && !statusRowLoading && typeof fbDb !== 'undefined' && firebaseReady){
    statusRowLoading = true;
    fetchAndGroupStatuses().then(groups => {
      statusGroupsCache = groups;
      statusRowFetchedAt = Date.now();
      renderStatusRowFromCache();
    }).finally(() => { statusRowLoading = false; });
  }
}

function fetchAndGroupStatuses(){
  if(!firebaseReady || typeof fbDb === 'undefined' || !fbDb || !state.user) return Promise.resolve(statusGroupsCache);
  const now = Date.now();
  return fbDb.collection('statuses')
    .where('expiresAt', '>', now)
    .orderBy('expiresAt', 'asc')
    .get()
    .then(snap => {
      const byUid = {};
      snap.forEach(docSnap => {
        const d = docSnap.data() || {};
        if(!d.uid || !d.createdAt) return;
        if(!byUid[d.uid]) byUid[d.uid] = { uid:d.uid, name:d.name||'ব্যবহারকারী', avatarColor:d.avatarColor||'', avatarIcon:d.avatarIcon||'', items:[], _latestAt:0 };
        byUid[d.uid].items.push(Object.assign({ id: docSnap.id }, d));
        if(d.createdAt >= byUid[d.uid]._latestAt){
          byUid[d.uid]._latestAt = d.createdAt;
          byUid[d.uid].name = d.name || byUid[d.uid].name;
          byUid[d.uid].avatarColor = d.avatarColor || byUid[d.uid].avatarColor;
          byUid[d.uid].avatarIcon = d.avatarIcon || byUid[d.uid].avatarIcon;
        }
      });
      const groups = Object.values(byUid);
      groups.forEach(g => { g.items.sort((a,b) => a.createdAt - b.createdAt); delete g._latestAt; });
      return groups;
    })
    .catch(err => { console.warn('status row fetch failed:', err); return statusGroupsCache; });
}

function renderStatusRowFromCache(){
  const inner = document.getElementById('statusRowInner');
  if(!inner || !state.user) return;
  const seen = getSeenStatusIds();
  const muted = getMutedUids();
  const myUid = state.user.uid;

  function groupHasUnseen(g){ return g.items.some(it => !seen.has(it.id)); }
  function groupLatest(g){ return g.items.length ? g.items[g.items.length - 1].createdAt : 0; }
  function groupLatestItem(g){ return g.items.length ? g.items[g.items.length - 1] : null; }
  function ayahBadge(g){
    const it = groupLatestItem(g);
    return (it && it.type === 'ayah') ? `<span class="status-ayah-badge"><i class="fa-solid fa-book-quran"></i></span>` : '';
  }

  const selfGroup = statusGroupsCache.find(g => g.uid === myUid) || null;
  const others = statusGroupsCache.filter(g => g.uid !== myUid);
  const nonMuted = others.filter(g => !muted.has(g.uid));
  const mutedOthers = others.filter(g => muted.has(g.uid));
  const unseenGroups = nonMuted.filter(groupHasUnseen).sort((a,b) => groupLatest(b) - groupLatest(a));
  const seenGroups = nonMuted.filter(g => !groupHasUnseen(g)).sort((a,b) => groupLatest(b) - groupLatest(a));
  const mutedSorted = mutedOthers.sort((a,b) => groupLatest(b) - groupLatest(a));
  const orderedOthers = unseenGroups.concat(seenGroups).concat(mutedSorted);
  const allGroups = (selfGroup ? [selfGroup] : []).concat(orderedOthers);

  let html = '';
  if(selfGroup && selfGroup.items.length){
    const hasUnseen = groupHasUnseen(selfGroup);
    html += `
      <button type="button" class="status-item self ${hasUnseen ? 'has-unseen' : 'all-seen'}" id="statusSelfItem">
        <div class="status-ring"><div class="status-avatar" style="background:${selfGroup.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph({ name: selfGroup.name, avatarIcon: selfGroup.avatarIcon })}
          ${ayahBadge(selfGroup)}
          <span class="status-plus-badge" id="statusSelfPlusBadge"><i class="fa-solid fa-plus"></i></span>
        </div></div>
        <div class="status-label">আমার স্ট্যাটাস</div>
      </button>`;
  } else {
    html += `
      <button type="button" class="status-item self" id="statusSelfItem">
        <div class="status-ring"><div class="status-avatar" style="background:${state.user.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph(state.user)}
          <span class="status-plus-badge" id="statusSelfPlusBadge"><i class="fa-solid fa-plus"></i></span>
        </div></div>
        <div class="status-label">আমার স্ট্যাটাস</div>
      </button>`;
  }

  orderedOthers.forEach(g => {
    const isMuted = muted.has(g.uid);
    const hasUnseen = !isMuted && groupHasUnseen(g);
    const firstName = (g.name || 'ব্যবহারকারী').trim().split(/\s+/)[0];
    html += `
      <button type="button" class="status-item ${isMuted ? 'muted' : (hasUnseen ? 'has-unseen' : 'all-seen')}" data-uid="${g.uid}">
        <div class="status-ring"><div class="status-avatar" style="background:${g.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph({ name: g.name, avatarIcon: g.avatarIcon })}
          ${ayahBadge(g)}
        </div></div>
        <div class="status-label">${escapeHtml(firstName)}</div>
      </button>`;
  });

  inner.innerHTML = html;

  const selfBtn = document.getElementById('statusSelfItem');
  if(selfBtn){
    selfBtn.onclick = () => {
      if(selfGroup && selfGroup.items.length) openStatusViewer(allGroups, 0, 0);
      else openStatusComposer('text');
    };
  }
  const plusBadge = document.getElementById('statusSelfPlusBadge');
  if(plusBadge){
    plusBadge.onclick = (e) => { e.stopPropagation(); openStatusComposer('text'); };
  }

  // Short tap opens the viewer; a ~480ms hold toggles mute for that person
  // without affecting their seen/unseen tracking.
  inner.querySelectorAll('.status-item:not(.self)').forEach(btn => {
    const uid = btn.getAttribute('data-uid');
    let holdTimeout = null, longPressed = false;
    btn.addEventListener('pointerdown', () => {
      longPressed = false;
      clearTimeout(holdTimeout);
      holdTimeout = setTimeout(() => {
        longPressed = true;
        toggleMuteUid(uid);
        showToast(getMutedUids().has(uid) ? 'স্ট্যাটাস মিউট করা হয়েছে' : 'স্ট্যাটাস আনমিউট করা হয়েছে');
        renderStatusRowFromCache();
      }, 480);
    });
    const cancelHold = () => clearTimeout(holdTimeout);
    btn.addEventListener('pointerup', cancelHold);
    btn.addEventListener('pointercancel', cancelHold);
    btn.addEventListener('pointerleave', cancelHold);
    btn.onclick = () => {
      if(longPressed){ longPressed = false; return; }
      const idx = allGroups.findIndex(g => g.uid === uid);
      if(idx === -1) return;
      openStatusViewer(allGroups, idx, 0);
    };
  });
}

// ==================================================================
// Shared Ayah-card markup (used by both the composer preview and the
// full-screen viewer, so a posted ayah status looks identical to its
// own preview).
// ==================================================================
function ayahStatusMarkup(arabic, translation, refLabel){
  return `
    <div class="status-ayah-block">
      <div class="status-ayah-arabic">${escapeHtml(arabic || '')}</div>
      <div class="status-ayah-translation">${escapeHtml(translation || '')}</div>
      <div class="status-ayah-ref"><i class="fa-solid fa-book-quran"></i>${escapeHtml(refLabel || '')}</div>
    </div>`;
}

// ==================================================================
// Composer (post a text / photo / ayah status)
// ==================================================================
function ensureStatusComposerOverlay(){
  let ov = document.getElementById('statusComposerOverlay');
  if(ov) return ov;
  ov = document.createElement('div');
  ov.id = 'statusComposerOverlay';
  ov.className = 'status-overlay';
  ov.innerHTML = `
    <div class="status-comp-topbar">
      <button type="button" class="status-comp-close" id="statusCompClose"><i class="fa-solid fa-xmark"></i></button>
      <div class="status-comp-modeswitch" id="statusCompModeSwitch">
        <button type="button" class="status-comp-mode-btn" data-mode="text">টেক্সট</button>
        <button type="button" class="status-comp-mode-btn" data-mode="image">ছবি</button>
        <button type="button" class="status-comp-mode-btn" data-mode="ayah">আয়াত</button>
      </div>
      <div class="status-comp-tools" id="statusCompTools"></div>
    </div>
    <div class="status-comp-stage" id="statusCompStage"></div>
    <div class="status-comp-colors" id="statusCompColors"></div>
    <div class="status-comp-bottombar">
      <span class="status-comp-charcount" id="statusCompCharCount"></span>
      <button type="button" class="status-comp-send" id="statusCompSend"><i class="fa-solid fa-check"></i></button>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('statusCompClose').onclick = closeStatusComposer;
  document.getElementById('statusCompSend').onclick = submitStatus;
  ov.querySelectorAll('.status-comp-mode-btn').forEach(btn => {
    btn.onclick = () => switchComposerMode(btn.getAttribute('data-mode'));
  });

  return ov;
}

function openStatusComposer(mode){
  if(!state.user){ if(typeof openAuthFlow === 'function') openAuthFlow('choice'); return; }
  ensureStatusComposerOverlay();
  statusComposerState = {
    mode: (mode === 'image' || mode === 'ayah') ? mode : 'text',
    colorIndex: Math.floor(Math.random() * STATUS_BG_COLORS.length),
    bgColor: null,
    fontIndex: 0,
    textAlign: 'center',
    textSize: 'md',
    imageDataUrl: null,
    textValue: '',
    captionText: '',
    ayah: null,
    sending: false
  };
  renderComposerStage();
  document.getElementById('statusComposerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  if(statusComposerState.mode === 'image'){
    setTimeout(() => { const fi = document.getElementById('statusCompFileInput'); if(fi) fi.click(); }, 30);
  } else if(statusComposerState.mode === 'ayah'){
    setTimeout(openStatusAyahSheet, 30);
  }
}

function closeStatusComposer(){
  const ov = document.getElementById('statusComposerOverlay');
  if(ov) ov.classList.remove('open');
  document.body.style.overflow = '';
  closeStatusFontSheet();
  closeStatusAyahSheet();
}

function switchComposerMode(mode){
  if(mode === statusComposerState.mode){
    if(mode === 'image' && !statusComposerState.imageDataUrl){
      const fi = document.getElementById('statusCompFileInput');
      if(fi) fi.click();
    }
    if(mode === 'ayah' && !statusComposerState.ayah) openStatusAyahSheet();
    return;
  }
  statusComposerState.mode = mode;
  renderComposerStage();
  if(mode === 'image' && !statusComposerState.imageDataUrl){
    setTimeout(() => { const fi = document.getElementById('statusCompFileInput'); if(fi) fi.click(); }, 30);
  }
  if(mode === 'ayah' && !statusComposerState.ayah){
    setTimeout(openStatusAyahSheet, 30);
  }
}

function refreshComposerModeSwitch(){
  const wrap = document.getElementById('statusCompModeSwitch');
  if(!wrap) return;
  wrap.querySelectorAll('.status-comp-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === statusComposerState.mode);
  });
}

function refreshComposerTools(){
  const tools = document.getElementById('statusCompTools');
  if(!tools) return;

  if(statusComposerState.mode === 'text'){
    tools.innerHTML = `
      <button type="button" class="status-comp-tool-btn" id="statusCompFontBtn">Aa</button>
      <button type="button" class="status-comp-tool-btn" id="statusCompAlignBtn"><i class="fa-solid fa-align-${statusComposerState.textAlign}"></i></button>
      <button type="button" class="status-comp-tool-btn" id="statusCompSizeBtn">T</button>`;
    document.getElementById('statusCompFontBtn').onclick = openStatusFontSheet;
    document.getElementById('statusCompAlignBtn').onclick = cycleComposerAlign;
    document.getElementById('statusCompSizeBtn').onclick = cycleComposerSize;
    syncComposerSizeBtn();
  } else if(statusComposerState.mode === 'image'){
    tools.innerHTML = statusComposerState.imageDataUrl
      ? `<button type="button" class="status-comp-tool-btn" id="statusCompChangeImageBtn"><i class="fa-solid fa-image"></i></button>`
      : '';
    tools.insertAdjacentHTML('beforeend', `<input type="file" accept="image/*" id="statusCompFileInput" style="display:none;">`);
    document.getElementById('statusCompFileInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if(file) handleStatusImagePick(file);
      e.target.value = '';
    });
    const changeBtn = document.getElementById('statusCompChangeImageBtn');
    if(changeBtn) changeBtn.onclick = () => document.getElementById('statusCompFileInput').click();
  } else if(statusComposerState.mode === 'ayah'){
    tools.innerHTML = statusComposerState.ayah
      ? `<button type="button" class="status-comp-tool-btn" id="statusCompChangeAyahBtn"><i class="fa-solid fa-arrows-rotate"></i></button>`
      : '';
    const changeBtn = document.getElementById('statusCompChangeAyahBtn');
    if(changeBtn) changeBtn.onclick = openStatusAyahSheet;
  }
}

function renderComposerStage(){
  const stage = document.getElementById('statusCompStage');
  const colorsWrap = document.getElementById('statusCompColors');
  if(!stage) return;
  refreshComposerModeSwitch();
  refreshComposerTools();

  if(statusComposerState.mode === 'image') renderImageStage(stage, colorsWrap);
  else if(statusComposerState.mode === 'ayah') renderAyahStage(stage, colorsWrap);
  else renderTextStage(stage, colorsWrap);

  refreshComposerCharCount();
}

function renderTextStage(stage, colorsWrap){
  stage.style.background = statusComposerState.bgColor || STATUS_BG_COLORS[statusComposerState.colorIndex];
  stage.innerHTML = `<textarea class="status-comp-textarea" id="statusCompTextarea" maxlength="700" placeholder="একটি স্ট্যাটাস লিখুন..."></textarea>`;
  const ta = document.getElementById('statusCompTextarea');
  ta.value = statusComposerState.textValue || '';
  ta.style.textAlign = statusComposerState.textAlign;
  ta.oninput = () => { statusComposerState.textValue = ta.value; refreshComposerCharCount(); };
  applyStatusComposerFont();
  applyStatusComposerSize();
  setTimeout(() => { try{ ta.focus(); }catch(e){} }, 60);
  renderComposerColorSwatches(colorsWrap, true);
}

function renderImageStage(stage, colorsWrap){
  if(statusComposerState.imageDataUrl){
    stage.style.background = '#000';
    stage.innerHTML = `
      <img class="status-comp-preview-img" src="${statusComposerState.imageDataUrl}">
      <div class="status-comp-caption"><input type="text" id="statusCompCaptionInput" maxlength="200" placeholder="ক্যাপশন যোগ করুন..."></div>`;
    const capInput = document.getElementById('statusCompCaptionInput');
    capInput.value = statusComposerState.captionText || '';
    capInput.oninput = () => { statusComposerState.captionText = capInput.value; };
  } else {
    stage.style.background = 'var(--panel)';
    stage.innerHTML = `
      <button type="button" class="status-comp-placeholder-btn" id="statusCompPickImageBtn">
        <i class="fa-solid fa-image"></i><span>ছবি বাছাই করুন</span>
      </button>`;
    document.getElementById('statusCompPickImageBtn').onclick = () => {
      const fi = document.getElementById('statusCompFileInput');
      if(fi) fi.click();
    };
  }
  renderComposerColorSwatches(colorsWrap, false);
}

function renderAyahStage(stage, colorsWrap){
  const ay = statusComposerState.ayah;
  if(ay){
    stage.style.background = statusComposerState.bgColor || STATUS_BG_COLORS[statusComposerState.colorIndex];
    stage.innerHTML = ayahStatusMarkup(ay.arabicText, ay.translation, `সূরা ${ay.surahName}, আয়াত ${toBn(ay.ayahNum)}`);
    renderComposerColorSwatches(colorsWrap, true);
  } else {
    stage.style.background = 'var(--panel)';
    stage.innerHTML = `
      <button type="button" class="status-comp-placeholder-btn" id="statusCompPickAyahBtn">
        <i class="fa-solid fa-book-quran"></i><span>আয়াত বাছাই করুন</span>
      </button>`;
    document.getElementById('statusCompPickAyahBtn').onclick = openStatusAyahSheet;
    renderComposerColorSwatches(colorsWrap, false);
  }
}

function renderComposerColorSwatches(colorsWrap, show){
  if(!colorsWrap) return;
  if(!show){ colorsWrap.style.display = 'none'; colorsWrap.innerHTML = ''; return; }
  colorsWrap.style.display = 'flex';
  colorsWrap.innerHTML = STATUS_BG_COLORS.map((c,i) => `<button type="button" class="status-comp-color-dot" data-i="${i}" style="background:${c}"></button>`).join('') +
    `<label class="status-comp-color-dot status-comp-color-custom">
       <input type="color" id="statusCompCustomColor" value="${statusComposerState.bgColor || '#2E6F5E'}">
       <i class="fa-solid fa-eye-dropper"></i>
     </label>`;
  syncComposerColorActiveState(colorsWrap);

  colorsWrap.querySelectorAll('.status-comp-color-dot[data-i]').forEach(btn => {
    btn.onclick = () => {
      statusComposerState.colorIndex = parseInt(btn.getAttribute('data-i'), 10) || 0;
      statusComposerState.bgColor = null;
      applyComposerStageBackground();
      syncComposerColorActiveState(colorsWrap);
    };
  });
  const customInput = document.getElementById('statusCompCustomColor');
  if(customInput){
    customInput.oninput = () => {
      statusComposerState.bgColor = customInput.value;
      applyComposerStageBackground();
      syncComposerColorActiveState(colorsWrap);
    };
  }
}

function syncComposerColorActiveState(colorsWrap){
  const custom = !!statusComposerState.bgColor;
  colorsWrap.querySelectorAll('.status-comp-color-dot[data-i]').forEach((el,i) => {
    el.classList.toggle('active', !custom && i === statusComposerState.colorIndex);
  });
  const label = colorsWrap.querySelector('.status-comp-color-custom');
  if(!label) return;
  const icon = label.querySelector('i');
  if(custom){
    label.classList.add('active');
    label.style.background = statusComposerState.bgColor;
    if(icon) icon.style.display = 'none';
  } else {
    label.classList.remove('active');
    label.style.background = '';
    if(icon) icon.style.display = '';
  }
}

function applyComposerStageBackground(){
  const stage = document.getElementById('statusCompStage');
  if(!stage || statusComposerState.mode === 'image') return;
  stage.style.background = statusComposerState.bgColor || STATUS_BG_COLORS[statusComposerState.colorIndex];
}

function applyStatusComposerFont(){
  const ta = document.getElementById('statusCompTextarea');
  if(!ta) return;
  const f = STATUS_FONTS[statusComposerState.fontIndex];
  ta.style.fontFamily = f.family;
  ta.style.fontWeight = f.weight || 600;
  ta.style.textTransform = f.upper ? 'uppercase' : 'none';
}

function applyStatusComposerSize(){
  const ta = document.getElementById('statusCompTextarea');
  if(!ta) return;
  ta.style.fontSize = (STATUS_TEXT_SIZES[statusComposerState.textSize] || STATUS_TEXT_SIZES.md) + 'px';
}

function cycleComposerAlign(){
  const idx = STATUS_ALIGN_CYCLE.indexOf(statusComposerState.textAlign);
  statusComposerState.textAlign = STATUS_ALIGN_CYCLE[(idx + 1) % STATUS_ALIGN_CYCLE.length];
  const ta = document.getElementById('statusCompTextarea');
  if(ta) ta.style.textAlign = statusComposerState.textAlign;
  const btn = document.getElementById('statusCompAlignBtn');
  if(btn) btn.innerHTML = `<i class="fa-solid fa-align-${statusComposerState.textAlign}"></i>`;
}

function cycleComposerSize(){
  const idx = STATUS_SIZE_CYCLE.indexOf(statusComposerState.textSize);
  statusComposerState.textSize = STATUS_SIZE_CYCLE[(idx + 1) % STATUS_SIZE_CYCLE.length];
  applyStatusComposerSize();
  syncComposerSizeBtn();
}

function syncComposerSizeBtn(){
  const btn = document.getElementById('statusCompSizeBtn');
  if(!btn) return;
  btn.style.fontSize = ({ sm:12, md:15, lg:18 }[statusComposerState.textSize] || 15) + 'px';
}

function refreshComposerCharCount(){
  const el = document.getElementById('statusCompCharCount');
  if(!el) return;
  el.textContent = statusComposerState.mode === 'text'
    ? `${toBn((statusComposerState.textValue || '').length)}/${toBn(700)}`
    : '';
}

function handleStatusImagePick(file){
  if(!file || !file.type || file.type.indexOf('image/') !== 0){ showToast('একটি ছবি বাছুন'); return; }
  compressImageFile(file, 1080, 0.72).then(dataUrl => {
    statusComposerState.mode = 'image';
    statusComposerState.imageDataUrl = dataUrl;
    renderComposerStage();
  }).catch(() => showToast('ছবি লোড করা যায়নি'));
}

function compressImageFile(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read-failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image-decode-failed'));
      img.onload = () => {
        let width = img.naturalWidth, height = img.naturalHeight;
        if(width > maxDim || height > maxDim){
          if(width >= height){ height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        try{ resolve(canvas.toDataURL('image/jpeg', quality)); }
        catch(e){ reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Font picker sheet (visual specimens instead of blind cycling) ----------
function ensureStatusFontSheet(){
  if(document.getElementById('statusFontSheet')) return;
  const scrim = document.createElement('div');
  scrim.id = 'statusFontScrim';
  scrim.className = 'status-sheet-scrim';
  scrim.onclick = closeStatusFontSheet;
  document.getElementById('statusComposerOverlay').appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.id = 'statusFontSheet';
  sheet.className = 'status-sheet';
  sheet.innerHTML = `
    <div class="status-sheet-handle"></div>
    <div class="status-sheet-title">ফন্ট বাছাই করুন</div>
    <div class="status-font-list" id="statusFontList"></div>`;
  document.getElementById('statusComposerOverlay').appendChild(sheet);
}

function openStatusFontSheet(){
  ensureStatusFontSheet();
  const list = document.getElementById('statusFontList');
  list.innerHTML = STATUS_FONTS.map((f,i) => `
    <button type="button" class="status-font-option${i===statusComposerState.fontIndex?' active':''}" data-i="${i}"
      style="font-family:${f.family};font-weight:${f.weight||600};${f.upper?'text-transform:uppercase;':''}">আমার স্ট্যাটাস</button>`).join('');
  list.querySelectorAll('.status-font-option').forEach(btn => {
    btn.onclick = () => {
      statusComposerState.fontIndex = parseInt(btn.getAttribute('data-i'), 10) || 0;
      applyStatusComposerFont();
      closeStatusFontSheet();
    };
  });
  document.getElementById('statusFontSheet').classList.add('open');
  document.getElementById('statusFontScrim').classList.add('open');
}

function closeStatusFontSheet(){
  const sheet = document.getElementById('statusFontSheet');
  const scrim = document.getElementById('statusFontScrim');
  if(sheet) sheet.classList.remove('open');
  if(scrim) scrim.classList.remove('open');
}

// ---------- Ayah picker sheet — Surah + Ayah number, fetched from the same
// Quran API the rest of the app already uses (js/data.js's API constant). ----------
function ensureStatusAyahSheet(){
  if(document.getElementById('statusAyahSheet')) return;
  const scrim = document.createElement('div');
  scrim.id = 'statusAyahScrim';
  scrim.className = 'status-sheet-scrim';
  scrim.onclick = closeStatusAyahSheet;
  document.getElementById('statusComposerOverlay').appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.id = 'statusAyahSheet';
  sheet.className = 'status-sheet status-ayah-sheet';
  sheet.innerHTML = `
    <div class="status-sheet-handle"></div>
    <div class="status-sheet-title">আয়াত বাছাই করুন</div>
    <div class="status-ayah-picker-body">
      <label class="status-ayah-picker-label">সূরা
        <select id="statusAyahSurahSelect"></select>
      </label>
      <label class="status-ayah-picker-label">আয়াত নম্বর
        <input type="number" id="statusAyahNumInput" min="1" value="1">
      </label>
      <div class="status-ayah-picker-hint" id="statusAyahHint"></div>
      <button type="button" class="status-ayah-picker-submit" id="statusAyahSubmitBtn">স্ট্যাটাসে যোগ করুন</button>
    </div>`;
  document.getElementById('statusComposerOverlay').appendChild(sheet);

  const select = document.getElementById('statusAyahSurahSelect');
  select.innerHTML = surahNamesBn.map((name,i) => `<option value="${i+1}">${toBn(i+1)}. ${escapeHtml(name)}</option>`).join('');
  select.onchange = updateStatusAyahHint;
  document.getElementById('statusAyahNumInput').oninput = updateStatusAyahHint;
  document.getElementById('statusAyahSubmitBtn').onclick = submitStatusAyahPick;
  updateStatusAyahHint();
}

function updateStatusAyahHint(){
  const s = parseInt(document.getElementById('statusAyahSurahSelect').value, 10) || 1;
  const max = SURAH_AYAH_COUNTS[s-1] || 1;
  const numInput = document.getElementById('statusAyahNumInput');
  numInput.max = max;
  if(parseInt(numInput.value, 10) > max) numInput.value = max;
  document.getElementById('statusAyahHint').textContent = `${surahNamesBn[s-1]} সূরায় মোট ${toBn(max)}টি আয়াত রয়েছে`;
}

function openStatusAyahSheet(){
  ensureStatusAyahSheet();
  document.getElementById('statusAyahSheet').classList.add('open');
  document.getElementById('statusAyahScrim').classList.add('open');
}

function closeStatusAyahSheet(){
  const sheet = document.getElementById('statusAyahSheet');
  const scrim = document.getElementById('statusAyahScrim');
  if(sheet) sheet.classList.remove('open');
  if(scrim) scrim.classList.remove('open');
}

function submitStatusAyahPick(){
  const s = parseInt(document.getElementById('statusAyahSurahSelect').value, 10) || 1;
  let a = parseInt(document.getElementById('statusAyahNumInput').value, 10) || 1;
  const max = SURAH_AYAH_COUNTS[s-1] || 1;
  if(a < 1) a = 1;
  if(a > max) a = max;

  const btn = document.getElementById('statusAyahSubmitBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'লোড হচ্ছে...';

  Promise.all([
    fetch(`${API}/ayah/${s}:${a}/quran-uthmani`).then(r => r.json()),
    fetch(`${API}/ayah/${s}:${a}/${state.translationEdition}`).then(r => r.json())
  ]).then(([arRes, bnRes]) => {
    const arabic = arRes && arRes.data ? arRes.data.text : '';
    const bengali = bnRes && bnRes.data ? bnRes.data.text : '';
    if(!arabic) throw new Error('empty-ayah');
    statusComposerState.ayah = { surahNum:s, ayahNum:a, surahName: surahNamesBn[s-1], arabicText: arabic, translation: bengali };
    statusComposerState.mode = 'ayah';
    renderComposerStage();
    closeStatusAyahSheet();
  }).catch(() => {
    showToast('আয়াতটি লোড করা যায়নি, ইন্টারনেট সংযোগ পরীক্ষা করুন');
  }).finally(() => {
    btn.disabled = false;
    btn.textContent = originalLabel;
  });
}

function submitStatus(){
  if(!state.user || statusComposerState.sending) return;
  const sendBtn = document.getElementById('statusCompSend');
  let payload;

  if(statusComposerState.mode === 'image'){
    if(!statusComposerState.imageDataUrl){ showToast('একটি ছবি বাছুন'); return; }
    if(statusComposerState.imageDataUrl.length > 900000){ showToast('ছবিটি অনেক বড়, ছোট আকারের একটি ছবি দিন'); return; }
    payload = { type:'image', imageData: statusComposerState.imageDataUrl, text:(statusComposerState.captionText||'').trim().slice(0,200) };
  } else if(statusComposerState.mode === 'ayah'){
    const ay = statusComposerState.ayah;
    if(!ay){ showToast('আগে একটি আয়াত বাছুন'); openStatusAyahSheet(); return; }
    const bgFields = statusComposerState.bgColor ? { bgColor: statusComposerState.bgColor } : { bgIndex: statusComposerState.colorIndex };
    payload = Object.assign({
      type:'ayah', surahNum: ay.surahNum, ayahNum: ay.ayahNum, surahName: ay.surahName,
      arabicText: ay.arabicText.slice(0,3000), translation: ay.translation.slice(0,3000)
    }, bgFields);
  } else {
    const txt = (statusComposerState.textValue || '').trim();
    if(!txt){ showToast('কিছু লিখুন'); return; }
    const bgFields = statusComposerState.bgColor ? { bgColor: statusComposerState.bgColor } : { bgIndex: statusComposerState.colorIndex };
    payload = Object.assign({
      type:'text', text: txt.slice(0,700), font: STATUS_FONTS[statusComposerState.fontIndex].id,
      textAlign: statusComposerState.textAlign, textSize: statusComposerState.textSize
    }, bgFields);
  }

  statusComposerState.sending = true;
  if(sendBtn){ sendBtn.disabled = true; sendBtn.classList.add('busy'); sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch"></i>'; }

  const now = Date.now();
  const doc = Object.assign({
    uid: state.user.uid,
    name: state.user.name || 'ব্যবহারকারী',
    avatarColor: state.user.avatarColor || '',
    avatarIcon: state.user.avatarIcon || '',
    createdAt: now,
    expiresAt: now + STATUS_TTL_MS,
    viewCount: 0,
    reactionCount: 0
  }, payload);

  fbDb.collection('statuses').add(doc).then(() => {
    showToast('স্ট্যাটাস আপলোড হয়েছে');
    closeStatusComposer();
    statusRowFetchedAt = 0;
    renderStatusRow();
  }).catch(err => {
    console.warn('status upload failed:', err);
    showToast('স্ট্যাটাস আপলোড করা যায়নি, আবার চেষ্টা করুন');
  }).finally(() => {
    statusComposerState.sending = false;
    if(sendBtn){ sendBtn.disabled = false; sendBtn.classList.remove('busy'); sendBtn.innerHTML = '<i class="fa-solid fa-check"></i>'; }
  });
}

// ==================================================================
// Full-screen story viewer
// ==================================================================
function ensureStatusViewerOverlay(){
  let ov = document.getElementById('statusViewerOverlay');
  if(ov) return ov;
  ov = document.createElement('div');
  ov.id = 'statusViewerOverlay';
  ov.className = 'status-overlay';
  ov.innerHTML = `
    <div class="status-view-progress-row" id="statusViewProgressRow"></div>
    <div class="status-view-header">
      <div class="status-view-avatar" id="statusViewAvatar"></div>
      <div class="status-view-who">
        <div class="status-view-name" id="statusViewName"></div>
        <div class="status-view-time" id="statusViewTime"></div>
      </div>
      <button type="button" class="status-view-header-btn" id="statusViewDeleteBtn" style="display:none;"><i class="fa-solid fa-trash"></i></button>
      <button type="button" class="status-view-header-btn" id="statusViewCloseBtn"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="status-view-stage" id="statusViewStage">
      <div class="status-view-tap-zone left" id="statusViewTapLeft"></div>
      <div class="status-view-tap-zone right" id="statusViewTapRight"></div>
      <div id="statusViewItems"></div>
    </div>
    <button type="button" class="status-view-react-btn" id="statusViewReactBtn" style="display:none;"><i class="fa-regular fa-heart"></i></button>
    <div class="status-reaction-bar" id="statusReactionBar">
      ${STATUS_REACTIONS.map(e => `<button type="button" class="status-reaction-emoji" data-e="${e}">${e}</button>`).join('')}
    </div>
    <div class="status-delete-confirm-bar" id="statusDeleteConfirmBar">
      <div class="status-delete-confirm-text">এই স্ট্যাটাসটি মুছে ফেলবেন?</div>
      <div class="status-delete-confirm-actions">
        <button type="button" class="status-delete-confirm-cancel" id="statusDeleteConfirmCancel">বাতিল</button>
        <button type="button" class="status-delete-confirm-ok" id="statusDeleteConfirmOk">মুছে ফেলুন</button>
      </div>
    </div>
    <div class="status-view-footer" id="statusViewFooter" style="display:none;">
      <button type="button" class="status-view-viewers-btn" id="statusViewViewersBtn">
        <i class="fa-solid fa-eye"></i><span id="statusViewViewersCount">০</span>&nbsp;জন দেখেছে
      </button>
      <span class="status-view-reaction-chip" id="statusViewReactionChip" style="display:none;">
        <i class="fa-solid fa-heart"></i><span id="statusViewReactionCount">০</span>
      </span>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('statusViewCloseBtn').onclick = closeStatusViewer;
  document.getElementById('statusViewDeleteBtn').onclick = confirmDeleteCurrentStatusItem;
  document.getElementById('statusViewViewersBtn').onclick = openStatusViewersSheet;
  document.getElementById('statusViewReactBtn').onclick = toggleStatusReactionBar;
  ov.querySelectorAll('.status-reaction-emoji').forEach(btn => {
    btn.onclick = () => sendStatusReaction(btn.getAttribute('data-e'));
  });
  document.getElementById('statusDeleteConfirmCancel').onclick = cancelDeleteCurrentStatusItem;
  document.getElementById('statusDeleteConfirmOk').onclick = confirmDeleteOk;

  attachStatusTapZone(document.getElementById('statusViewTapLeft'), goToPrevStatusItem);
  attachStatusTapZone(document.getElementById('statusViewTapRight'), goToNextStatusItem);

  // Swipe down anywhere on the stage to close, WhatsApp-style.
  const stage = document.getElementById('statusViewStage');
  let touchStartY = null;
  stage.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive:true });
  stage.addEventListener('touchend', (e) => {
    if(touchStartY == null) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartY = null;
    if(dy > 90 && !statusViewerBarOpen()) closeStatusViewer();
  }, { passive:true });

  return ov;
}

function statusViewerBarOpen(){
  const r = document.getElementById('statusReactionBar');
  const d = document.getElementById('statusDeleteConfirmBar');
  return (r && r.classList.contains('open')) || (d && d.classList.contains('open'));
}

// A short press advances; holding the finger/pointer down pauses the
// current item (like a long-press on a WhatsApp status) and a plain
// release afterwards just resumes it without navigating.
function attachStatusTapZone(zone, onTap){
  if(!zone) return;
  let holdTimeout = null, holdActive = false;
  zone.addEventListener('pointerdown', () => {
    if(statusViewerBarOpen()) return;
    holdActive = false;
    clearTimeout(holdTimeout);
    holdTimeout = setTimeout(() => { holdActive = true; pauseStatusItemTimer(); }, 180);
  });
  const release = () => {
    if(statusViewerBarOpen()) return;
    clearTimeout(holdTimeout);
    if(holdActive){ holdActive = false; resumeStatusItemTimer(); }
    else onTap();
  };
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', () => { clearTimeout(holdTimeout); if(holdActive){ holdActive = false; resumeStatusItemTimer(); } });
}

function openStatusViewer(groups, groupIndex, itemIndex){
  if(!state.user){ if(typeof openAuthFlow === 'function') openAuthFlow('choice'); return; }
  if(!groups || !groups.length) return;
  ensureStatusViewerOverlay();
  statusViewerState.open = true;
  statusViewerState.groups = groups;
  statusViewerState.groupIndex = groupIndex || 0;
  statusViewerState.itemIndex = itemIndex || 0;
  document.getElementById('statusViewerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderStatusViewerGroup();
}

function closeStatusViewer(){
  stopStatusItemTimer();
  statusViewerState.open = false;
  const ov = document.getElementById('statusViewerOverlay');
  if(ov) ov.classList.remove('open');
  document.body.style.overflow = '';
  closeStatusViewersSheet();
  closeStatusReactionBar();
  closeStatusDeleteConfirm();
  renderStatusRowFromCache(); // reflect newly-seen items in the row's ring colors
}

function renderStatusViewerGroup(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || !group.items.length){ closeStatusViewer(); return; }

  const avatarEl = document.getElementById('statusViewAvatar');
  avatarEl.style.background = group.avatarColor || PROFILE_AVATAR_COLORS[0];
  avatarEl.innerHTML = avatarGlyph({ name: group.name, avatarIcon: group.avatarIcon });
  const isOwn = group.uid === state.user.uid;
  document.getElementById('statusViewName').textContent = isOwn ? 'আমার স্ট্যাটাস' : (group.name || 'ব্যবহারকারী');

  document.getElementById('statusViewProgressRow').innerHTML =
    group.items.map(() => `<div class="status-view-progress-track"><div class="status-view-progress-fill"></div></div>`).join('');

  document.getElementById('statusViewItems').innerHTML = group.items.map((it,i) => statusViewItemHtml(it,i)).join('');

  document.getElementById('statusViewDeleteBtn').style.display = isOwn ? 'flex' : 'none';
  document.getElementById('statusViewFooter').style.display = isOwn ? 'flex' : 'none';
  const reactBtn = document.getElementById('statusViewReactBtn');
  if(reactBtn) reactBtn.style.display = isOwn ? 'none' : 'flex';
  closeStatusReactionBar();
  closeStatusDeleteConfirm();

  showStatusViewerItem(statusViewerState.itemIndex);
}

function statusViewItemHtml(it, i){
  if(it.type === 'image'){
    return `<div class="status-view-item" data-i="${i}">
      <img src="${it.imageData}" alt="">
      ${it.text ? `<div class="status-view-caption">${escapeHtml(it.text)}</div>` : ''}
    </div>`;
  }
  if(it.type === 'ayah'){
    const bg = it.bgColor || STATUS_BG_COLORS[Number.isInteger(it.bgIndex) ? it.bgIndex : 0] || STATUS_BG_COLORS[0];
    const refLabel = `সূরা ${it.surahName || ''}, আয়াত ${toBn(it.ayahNum || 0)}`;
    return `<div class="status-view-item" data-i="${i}" style="background:${bg};">
      ${ayahStatusMarkup(it.arabicText, it.translation, refLabel)}
    </div>`;
  }
  const font = STATUS_FONTS.find(f => f.id === it.font) || STATUS_FONTS[0];
  const bg = it.bgColor || STATUS_BG_COLORS[Number.isInteger(it.bgIndex) ? it.bgIndex : 0] || STATUS_BG_COLORS[0];
  const align = it.textAlign || 'center';
  const sizePx = STATUS_VIEW_TEXT_SIZES[it.textSize] || STATUS_VIEW_TEXT_SIZES.md;
  return `<div class="status-view-item" data-i="${i}" style="background:${bg};">
    <div class="status-view-text" style="font-family:${font.family};font-weight:${font.weight||600};${font.upper?'text-transform:uppercase;':''}text-align:${align};font-size:${sizePx}px;">${escapeHtml(it.text||'')}</div>
  </div>`;
}

function showStatusViewerItem(idx){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group) return;

  if(idx < 0){
    if(statusViewerState.groupIndex === 0){ idx = 0; }
    else {
      statusViewerState.groupIndex -= 1;
      const prevGroup = statusViewerState.groups[statusViewerState.groupIndex];
      statusViewerState.itemIndex = Math.max(0, prevGroup.items.length - 1);
      renderStatusViewerGroup();
      return;
    }
  }
  if(idx >= group.items.length){
    if(statusViewerState.groupIndex >= statusViewerState.groups.length - 1){ closeStatusViewer(); return; }
    statusViewerState.groupIndex += 1;
    statusViewerState.itemIndex = 0;
    renderStatusViewerGroup();
    return;
  }

  statusViewerState.itemIndex = idx;
  stopStatusItemTimer();

  const tracks = document.querySelectorAll('#statusViewProgressRow .status-view-progress-track');
  tracks.forEach((t,i) => {
    const fill = t.querySelector('.status-view-progress-fill');
    fill.style.transition = 'none';
    if(i < idx){ t.classList.add('done'); fill.style.width = '100%'; }
    else { t.classList.remove('done'); fill.style.width = '0%'; }
  });

  document.querySelectorAll('#statusViewItems .status-view-item').forEach((el,i) => el.classList.toggle('active', i === idx));

  const item = group.items[idx];
  document.getElementById('statusViewTime').textContent = typeof timeAgoBn === 'function' ? timeAgoBn(item.createdAt) : '';

  if(group.uid === state.user.uid){
    document.getElementById('statusViewViewersCount').textContent = toBn(item.viewCount || 0);
    const chip = document.getElementById('statusViewReactionChip');
    if(chip){
      if(item.reactionCount){ chip.style.display = 'flex'; document.getElementById('statusViewReactionCount').textContent = toBn(item.reactionCount); }
      else chip.style.display = 'none';
    }
  } else {
    const cache = getMyReactionsCache();
    updateReactionBtnUI(cache[item.id] || null);
  }

  markStatusSeenLocally(item.id);
  if(group.uid !== state.user.uid) recordStatusView(item);

  startStatusItemTimer(idx, STATUS_ITEM_MS);
}

function startStatusItemTimer(idx, durationMs){
  const tracks = document.querySelectorAll('#statusViewProgressRow .status-view-progress-track');
  const fill = tracks[idx] && tracks[idx].querySelector('.status-view-progress-fill');
  if(!fill) return;
  statusViewerState.currentFill = fill;
  statusViewerState.remainingMs = durationMs;
  statusViewerState.paused = false;
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetHeight; // force reflow so the transition below actually animates
  fill.style.transition = `width ${durationMs}ms linear`;
  fill.style.width = '100%';
  statusViewerState.itemStartedAt = Date.now();
  clearTimeout(statusViewerState.timer);
  statusViewerState.timer = setTimeout(goToNextStatusItem, durationMs);
}

function pauseStatusItemTimer(){
  if(!statusViewerState.open || statusViewerState.paused) return;
  const fill = statusViewerState.currentFill;
  if(fill){
    const w = getComputedStyle(fill).width;
    fill.style.transition = 'none';
    fill.style.width = w;
  }
  clearTimeout(statusViewerState.timer);
  const elapsed = Date.now() - statusViewerState.itemStartedAt;
  statusViewerState.remainingMs = Math.max(200, statusViewerState.remainingMs - elapsed);
  statusViewerState.paused = true;
}

function resumeStatusItemTimer(){
  if(!statusViewerState.open || !statusViewerState.paused) return;
  statusViewerState.paused = false;
  const fill = statusViewerState.currentFill;
  if(fill){
    void fill.offsetHeight;
    fill.style.transition = `width ${statusViewerState.remainingMs}ms linear`;
    fill.style.width = '100%';
  }
  statusViewerState.itemStartedAt = Date.now();
  clearTimeout(statusViewerState.timer);
  statusViewerState.timer = setTimeout(goToNextStatusItem, statusViewerState.remainingMs);
}

function stopStatusItemTimer(){
  clearTimeout(statusViewerState.timer);
  statusViewerState.timer = null;
}

function goToNextStatusItem(){ showStatusViewerItem(statusViewerState.itemIndex + 1); }
function goToPrevStatusItem(){ showStatusViewerItem(statusViewerState.itemIndex - 1); }

// ---------- Quick reactions (❤️😂😮😢🙏👍) on other people's statuses ----------
function toggleStatusReactionBar(){
  const bar = document.getElementById('statusReactionBar');
  if(!bar) return;
  if(bar.classList.contains('open')) closeStatusReactionBar();
  else openStatusReactionBar();
}

function openStatusReactionBar(){
  pauseStatusItemTimer();
  const bar = document.getElementById('statusReactionBar');
  if(bar) bar.classList.add('open');
}

function closeStatusReactionBar(){
  const bar = document.getElementById('statusReactionBar');
  if(bar && bar.classList.contains('open')){
    bar.classList.remove('open');
    if(statusViewerState.open) resumeStatusItemTimer();
  }
}

function updateReactionBtnUI(emoji){
  const btn = document.getElementById('statusViewReactBtn');
  if(!btn) return;
  if(emoji){
    btn.classList.add('reacted');
    btn.textContent = emoji;
  } else {
    btn.classList.remove('reacted');
    btn.innerHTML = '<i class="fa-regular fa-heart"></i>';
  }
}

// Tapping an emoji reacts; tapping the SAME emoji again un-reacts. Picking a
// different emoji while already reacted just changes it (no count change).
function sendStatusReaction(emoji){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  const item = group && group.items[statusViewerState.itemIndex];
  if(!item || !group || !state.user || group.uid === state.user.uid) return;
  if(typeof fbDb === 'undefined' || !fbDb) return;

  const cache = getMyReactionsCache();
  const current = cache[item.id] || null;
  const statusRef = fbDb.collection('statuses').doc(item.id);
  const reactionRef = statusRef.collection('reactions').doc(state.user.uid);

  if(current === emoji){
    reactionRef.delete()
      .then(() => statusRef.update({ reactionCount: firebase.firestore.FieldValue.increment(-1) }))
      .then(() => {
        setMyReactionCache(item.id, null);
        item.reactionCount = Math.max(0, (item.reactionCount || 1) - 1);
        updateReactionBtnUI(null);
      }).catch(err => console.warn('reaction remove failed:', err));
    closeStatusReactionBar();
    return;
  }

  const payload = {
    emoji,
    name: state.user.name || 'ব্যবহারকারী',
    avatarColor: state.user.avatarColor || '',
    avatarIcon: state.user.avatarIcon || '',
    reactedAt: Date.now()
  };
  const isNew = !current;
  const write = isNew ? reactionRef.set(payload) : reactionRef.update({ emoji, reactedAt: Date.now() });
  write.then(() => isNew ? statusRef.update({ reactionCount: firebase.firestore.FieldValue.increment(1) }) : null)
    .then(() => {
      setMyReactionCache(item.id, emoji);
      if(isNew) item.reactionCount = (item.reactionCount || 0) + 1;
      updateReactionBtnUI(emoji);
    }).catch(err => console.warn('reaction send failed:', err));
  closeStatusReactionBar();
}

// ---------- View tracking (records to Firestore once per viewer, ever) ----------
function recordStatusView(item){
  if(!state.user || typeof fbDb === 'undefined' || !fbDb) return;
  if(getRecordedViewIds().has(item.id)) return;
  markViewRecordedLocally(item.id);

  const statusRef = fbDb.collection('statuses').doc(item.id);
  const viewRef = statusRef.collection('views').doc(state.user.uid);
  viewRef.get().then(snap => {
    if(snap.exists) return; // already recorded (e.g. from another device) — don't double count
    const viewerDoc = {
      name: state.user.name || 'ব্যবহারকারী',
      avatarColor: state.user.avatarColor || '',
      avatarIcon: state.user.avatarIcon || '',
      viewedAt: Date.now()
    };
    return viewRef.set(viewerDoc).then(() => statusRef.update({ viewCount: firebase.firestore.FieldValue.increment(1) }));
  }).catch(err => console.warn('status view record failed:', err));
}

// ---------- "কারা দেখেছে" (who viewed) bottom sheet — own status only,
// now also shows each viewer's reaction emoji (if any) next to their name ----------
function ensureStatusViewersSheet(){
  if(document.getElementById('statusViewersSheet')) return;
  const scrim = document.createElement('div');
  scrim.id = 'statusViewersScrim';
  scrim.className = 'status-viewers-sheet-scrim';
  scrim.onclick = closeStatusViewersSheet;
  document.body.appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.id = 'statusViewersSheet';
  sheet.className = 'status-viewers-sheet';
  sheet.innerHTML = `
    <div class="status-viewers-sheet-handle"></div>
    <div class="status-viewers-sheet-title">কারা দেখেছে</div>
    <div class="status-viewers-list" id="statusViewersList"></div>`;
  document.body.appendChild(sheet);
}

function openStatusViewersSheet(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || group.uid !== state.user.uid) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;
  pauseStatusItemTimer();
  ensureStatusViewersSheet();
  document.getElementById('statusViewersSheet').classList.add('open');
  document.getElementById('statusViewersScrim').classList.add('open');
  const list = document.getElementById('statusViewersList');
  list.innerHTML = `<div class="status-viewers-empty">লোড হচ্ছে...</div>`;

  const statusRef = fbDb.collection('statuses').doc(item.id);
  Promise.all([
    statusRef.collection('views').orderBy('viewedAt','desc').get(),
    statusRef.collection('reactions').get()
  ]).then(([viewsSnap, reactionsSnap]) => {
    if(viewsSnap.empty){ list.innerHTML = `<div class="status-viewers-empty">এখনো কেউ দেখেনি</div>`; return; }
    const reactionMap = {};
    reactionsSnap.forEach(d => { reactionMap[d.id] = d.data().emoji; });
    list.innerHTML = viewsSnap.docs.map(d => {
      const v = d.data();
      const emoji = reactionMap[d.id];
      return `<div class="status-viewer-row">
        <div class="status-viewer-avatar" style="background:${v.avatarColor || PROFILE_AVATAR_COLORS[0]}">${avatarGlyph({ name:v.name, avatarIcon:v.avatarIcon })}</div>
        <div class="status-viewer-name">${escapeHtml(v.name || 'ব্যবহারকারী')}</div>
        ${emoji ? `<span class="status-viewer-reaction">${emoji}</span>` : ''}
        <div class="status-viewer-time">${typeof timeAgoBn === 'function' ? timeAgoBn(v.viewedAt) : ''}</div>
      </div>`;
    }).join('');
  }).catch(() => { list.innerHTML = `<div class="status-viewers-empty">লোড করা যায়নি</div>`; });
}

function closeStatusViewersSheet(){
  const sheet = document.getElementById('statusViewersSheet');
  const scrim = document.getElementById('statusViewersScrim');
  if(sheet) sheet.classList.remove('open');
  if(scrim) scrim.classList.remove('open');
  if(statusViewerState.open) resumeStatusItemTimer();
}

// ---------- Delete own status item — in-app confirm bar (no native confirm()) ----------
function confirmDeleteCurrentStatusItem(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || group.uid !== state.user.uid) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;
  pauseStatusItemTimer();
  pendingDeleteItem = item;
  pendingDeleteGroup = group;
  const bar = document.getElementById('statusDeleteConfirmBar');
  if(bar) bar.classList.add('open');
}

function cancelDeleteCurrentStatusItem(){
  closeStatusDeleteConfirm();
  if(statusViewerState.open) resumeStatusItemTimer();
}

function confirmDeleteOk(){
  const item = pendingDeleteItem;
  const group = pendingDeleteGroup;
  closeStatusDeleteConfirm();
  if(item && group) deleteStatusItem(item, group);
}

function closeStatusDeleteConfirm(){
  const bar = document.getElementById('statusDeleteConfirmBar');
  if(bar) bar.classList.remove('open');
  pendingDeleteItem = null;
  pendingDeleteGroup = null;
}

function deleteStatusItem(item, group){
  const statusRef = fbDb.collection('statuses').doc(item.id);
  Promise.all([
    statusRef.collection('views').get(),
    statusRef.collection('reactions').get()
  ]).then(([viewsSnap, reactionsSnap]) => {
    const batch = fbDb.batch();
    viewsSnap.forEach(d => batch.delete(d.ref));
    reactionsSnap.forEach(d => batch.delete(d.ref));
    batch.delete(statusRef);
    return batch.commit();
  }).then(() => {
    showToast('স্ট্যাটাস মুছে ফেলা হয়েছে');
    setMyReactionCache(item.id, null);
    const idx = group.items.indexOf(item);
    if(idx > -1) group.items.splice(idx, 1);
    statusGroupsCache = statusGroupsCache.filter(g => g.uid !== group.uid || g.items.length);
    statusRowFetchedAt = 0;

    if(!group.items.length){
      const gi = statusViewerState.groups.indexOf(group);
      if(gi > -1) statusViewerState.groups.splice(gi, 1);
    }
    if(!statusViewerState.groups.length){ closeStatusViewer(); return; }
    if(statusViewerState.groupIndex >= statusViewerState.groups.length) statusViewerState.groupIndex = statusViewerState.groups.length - 1;
    const curGroup = statusViewerState.groups[statusViewerState.groupIndex];
    statusViewerState.itemIndex = Math.min(statusViewerState.itemIndex, Math.max(0, curGroup.items.length - 1));
    renderStatusViewerGroup();
  }).catch(err => {
    console.warn('status delete failed:', err);
    showToast('মুছে ফেলা যায়নি');
    if(statusViewerState.open) resumeStatusItemTimer();
  });
}
