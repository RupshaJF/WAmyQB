// ---------- WhatsApp-style "Status" feature ----------
// A row of circular avatars sits above the Daily-Ayah card on the home tab —
// your own status (tap the + to post) plus everyone else's active (last
// 24h) statuses. Tapping a circle opens a full-screen story viewer with
// segmented progress bars, tap-to-advance / hold-to-pause, and — for your
// own status only — a "কারা দেখেছে" (who viewed) list with a live count,
// exactly like WhatsApp. Both posting AND viewing require a completed
// sign-in/sign-up (js/auth.js openAuthFlow) — there is no guest path here.
//
// Firestore layout (see firestore.rules for the matching security rules):
//   statuses/{statusId}                 one doc per posted status
//     uid, name, avatarColor, avatarIcon  — snapshot of the poster
//     type: 'text' | 'image'
//     text        — status text (type:text) or optional caption (type:image)
//     bgIndex     — index into STATUS_BG_COLORS (type:text)
//     font        — id from STATUS_FONTS (type:text)
//     imageData   — compressed JPEG data URL (type:image)
//     createdAt, expiresAt — client epoch-ms (24h TTL; expired ones simply
//                             stop matching the "still active" query below —
//                             no cleanup job needed for them to disappear)
//     viewCount   — denormalized counter, +1 per unique viewer
//   statuses/{statusId}/views/{viewerUid}
//     name, avatarColor, avatarIcon, viewedAt

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_ITEM_MS = 6000; // how long a single item plays before auto-advancing
const STATUS_ROW_CACHE_MS = 40000;

const STATUS_BG_COLORS = ['#2E6F5E','#7A2E44','#3D4F8A','#6B3F8A','#8A4A2E','#2E6B8A','#5A6B2E','#3A3A46'];

const STATUS_FONTS = [
  { id:'sans',    family:"'Hind Siliguri', sans-serif",           weight:600 },
  { id:'serif',   family:"'Noto Serif Bengali', Georgia, serif",  weight:600 },
  { id:'mono',    family:"'Courier New', monospace",              weight:700 },
  { id:'script',  family:"cursive",                                weight:500 },
  { id:'display', family:"Impact, 'Hind Siliguri', sans-serif",   weight:700, upper:true }
];

let statusGroupsCache = [];  // last fetched groups, {uid,name,avatarColor,avatarIcon,items:[]}[]
let statusRowFetchedAt = 0;
let statusRowLoading = false;

let statusComposerState = { mode:'text', colorIndex:0, fontIndex:0, imageDataUrl:null, textValue:'', captionText:'', sending:false };

let statusViewerState = {
  open:false, groups:[], groupIndex:0, itemIndex:0,
  timer:null, itemStartedAt:0, remainingMs:0, paused:false, currentFill:null
};

// ---------- Local (per-device) caches — only drive the ring color / avoid
// re-sending duplicate view writes; the real count + viewer list always
// live server-side so they're correct from any device (js/idb.js) ----------
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
  const myUid = state.user.uid;

  function groupHasUnseen(g){ return g.items.some(it => !seen.has(it.id)); }
  function groupLatest(g){ return g.items.length ? g.items[g.items.length - 1].createdAt : 0; }

  const selfGroup = statusGroupsCache.find(g => g.uid === myUid) || null;
  const others = statusGroupsCache.filter(g => g.uid !== myUid);
  const unseenGroups = others.filter(groupHasUnseen).sort((a,b) => groupLatest(b) - groupLatest(a));
  const seenGroups = others.filter(g => !groupHasUnseen(g)).sort((a,b) => groupLatest(b) - groupLatest(a));
  const orderedOthers = unseenGroups.concat(seenGroups);
  const allGroups = (selfGroup ? [selfGroup] : []).concat(orderedOthers);

  let html = '';
  if(selfGroup && selfGroup.items.length){
    const hasUnseen = groupHasUnseen(selfGroup);
    html += `
      <button type="button" class="status-item self ${hasUnseen ? 'has-unseen' : 'all-seen'}" id="statusSelfItem">
        <div class="status-ring"><div class="status-avatar" style="background:${selfGroup.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph({ name: selfGroup.name, avatarIcon: selfGroup.avatarIcon })}
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
    const hasUnseen = groupHasUnseen(g);
    const firstName = (g.name || 'ব্যবহারকারী').trim().split(/\s+/)[0];
    html += `
      <button type="button" class="status-item ${hasUnseen ? 'has-unseen' : 'all-seen'}" data-uid="${g.uid}">
        <div class="status-ring"><div class="status-avatar" style="background:${g.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph({ name: g.name, avatarIcon: g.avatarIcon })}
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
  inner.querySelectorAll('.status-item:not(.self)').forEach(btn => {
    btn.onclick = () => {
      const uid = btn.getAttribute('data-uid');
      const idx = allGroups.findIndex(g => g.uid === uid);
      if(idx === -1) return;
      openStatusViewer(allGroups, idx, 0);
    };
  });
}

// ==================================================================
// Composer (post a text or photo status)
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
      <div class="status-comp-tools">
        <button type="button" class="status-comp-tool-btn" id="statusCompFontBtn">Aa</button>
        <label class="status-comp-tool-btn" id="statusCompImageBtn">
          <i class="fa-solid fa-image"></i>
          <input type="file" accept="image/*" id="statusCompFileInput" style="display:none;">
        </label>
      </div>
    </div>
    <div class="status-comp-stage" id="statusCompStage"></div>
    <div class="status-comp-colors" id="statusCompColors"></div>
    <div class="status-comp-bottombar">
      <button type="button" class="status-comp-send" id="statusCompSend"><i class="fa-solid fa-check"></i></button>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('statusCompClose').onclick = closeStatusComposer;
  document.getElementById('statusCompSend').onclick = submitStatus;
  document.getElementById('statusCompFontBtn').onclick = () => {
    statusComposerState.fontIndex = (statusComposerState.fontIndex + 1) % STATUS_FONTS.length;
    applyStatusComposerFont();
  };
  document.getElementById('statusCompFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(file) handleStatusImagePick(file);
    e.target.value = '';
  });

  const colorsWrap = document.getElementById('statusCompColors');
  colorsWrap.innerHTML = STATUS_BG_COLORS.map((c,i) => `<button type="button" class="status-comp-color-dot" data-i="${i}" style="background:${c}"></button>`).join('');
  colorsWrap.querySelectorAll('.status-comp-color-dot').forEach(btn => {
    btn.onclick = () => {
      statusComposerState.colorIndex = parseInt(btn.getAttribute('data-i'), 10) || 0;
      const stage = document.getElementById('statusCompStage');
      if(stage && statusComposerState.mode === 'text') stage.style.background = STATUS_BG_COLORS[statusComposerState.colorIndex];
      colorsWrap.querySelectorAll('.status-comp-color-dot').forEach((el,i) => el.classList.toggle('active', i === statusComposerState.colorIndex));
    };
  });

  return ov;
}

function applyStatusComposerFont(){
  const ta = document.getElementById('statusCompTextarea');
  if(!ta) return;
  const f = STATUS_FONTS[statusComposerState.fontIndex];
  ta.style.fontFamily = f.family;
  ta.style.fontWeight = f.weight || 600;
  ta.style.textTransform = f.upper ? 'uppercase' : 'none';
}

function openStatusComposer(mode){
  if(!state.user){ if(typeof openAuthFlow === 'function') openAuthFlow('choice'); return; }
  ensureStatusComposerOverlay();
  statusComposerState = {
    mode: 'text',
    colorIndex: Math.floor(Math.random() * STATUS_BG_COLORS.length),
    fontIndex: 0, imageDataUrl: null, textValue: '', captionText: '', sending: false
  };
  renderComposerStage();
  document.getElementById('statusComposerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  if(mode === 'image'){
    const fi = document.getElementById('statusCompFileInput');
    if(fi) fi.click();
  }
}

function closeStatusComposer(){
  const ov = document.getElementById('statusComposerOverlay');
  if(ov) ov.classList.remove('open');
  document.body.style.overflow = '';
}

function renderComposerStage(){
  const stage = document.getElementById('statusCompStage');
  const colorsWrap = document.getElementById('statusCompColors');
  const fontBtn = document.getElementById('statusCompFontBtn');
  if(!stage) return;

  if(statusComposerState.mode === 'image' && statusComposerState.imageDataUrl){
    stage.style.background = '#000';
    stage.innerHTML = `
      <img class="status-comp-preview-img" src="${statusComposerState.imageDataUrl}">
      <div class="status-comp-caption"><input type="text" id="statusCompCaptionInput" maxlength="200" placeholder="ক্যাপশন যোগ করুন..."></div>`;
    const capInput = document.getElementById('statusCompCaptionInput');
    capInput.value = statusComposerState.captionText || '';
    capInput.oninput = () => { statusComposerState.captionText = capInput.value; };
    if(colorsWrap) colorsWrap.style.display = 'none';
    if(fontBtn) fontBtn.style.display = 'none';
  } else {
    statusComposerState.mode = 'text';
    stage.style.background = STATUS_BG_COLORS[statusComposerState.colorIndex];
    stage.innerHTML = `<textarea class="status-comp-textarea" id="statusCompTextarea" maxlength="700" placeholder="একটি স্ট্যাটাস লিখুন..."></textarea>`;
    const ta = document.getElementById('statusCompTextarea');
    ta.value = statusComposerState.textValue || '';
    ta.oninput = () => { statusComposerState.textValue = ta.value; };
    applyStatusComposerFont();
    setTimeout(() => { try{ ta.focus(); }catch(e){} }, 60);
    if(colorsWrap){
      colorsWrap.style.display = 'flex';
      colorsWrap.querySelectorAll('.status-comp-color-dot').forEach((el,i) => el.classList.toggle('active', i === statusComposerState.colorIndex));
    }
    if(fontBtn) fontBtn.style.display = 'flex';
  }
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

function submitStatus(){
  if(!state.user || statusComposerState.sending) return;
  const sendBtn = document.getElementById('statusCompSend');
  let payload;

  if(statusComposerState.mode === 'image'){
    if(!statusComposerState.imageDataUrl){ showToast('একটি ছবি বাছুন'); return; }
    if(statusComposerState.imageDataUrl.length > 900000){ showToast('ছবিটি অনেক বড়, ছোট আকারের একটি ছবি দিন'); return; }
    payload = { type:'image', imageData: statusComposerState.imageDataUrl, text:(statusComposerState.captionText||'').trim().slice(0,200) };
  } else {
    const txt = (statusComposerState.textValue || '').trim();
    if(!txt){ showToast('কিছু লিখুন'); return; }
    payload = { type:'text', text: txt.slice(0,700), bgIndex: statusComposerState.colorIndex, font: STATUS_FONTS[statusComposerState.fontIndex].id };
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
    viewCount: 0
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
    <div class="status-view-footer" id="statusViewFooter" style="display:none;">
      <button type="button" class="status-view-viewers-btn" id="statusViewViewersBtn">
        <i class="fa-solid fa-eye"></i><span id="statusViewViewersCount">০</span>&nbsp;জন দেখেছে
      </button>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('statusViewCloseBtn').onclick = closeStatusViewer;
  document.getElementById('statusViewDeleteBtn').onclick = confirmDeleteCurrentStatusItem;
  document.getElementById('statusViewViewersBtn').onclick = openStatusViewersSheet;

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
    if(dy > 90) closeStatusViewer();
  }, { passive:true });

  return ov;
}

// A short press advances; holding the finger/pointer down pauses the
// current item (like a long-press on a WhatsApp status) and a plain
// release afterwards just resumes it without navigating.
function attachStatusTapZone(zone, onTap){
  if(!zone) return;
  let holdTimeout = null, holdActive = false;
  zone.addEventListener('pointerdown', () => {
    holdActive = false;
    clearTimeout(holdTimeout);
    holdTimeout = setTimeout(() => { holdActive = true; pauseStatusItemTimer(); }, 180);
  });
  const release = () => {
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

  showStatusViewerItem(statusViewerState.itemIndex);
}

function statusViewItemHtml(it, i){
  if(it.type === 'image'){
    return `<div class="status-view-item" data-i="${i}">
      <img src="${it.imageData}" alt="">
      ${it.text ? `<div class="status-view-caption">${escapeHtml(it.text)}</div>` : ''}
    </div>`;
  }
  const font = STATUS_FONTS.find(f => f.id === it.font) || STATUS_FONTS[0];
  const bg = STATUS_BG_COLORS[Number.isInteger(it.bgIndex) ? it.bgIndex : 0] || STATUS_BG_COLORS[0];
  return `<div class="status-view-item" data-i="${i}" style="background:${bg};">
    <div class="status-view-text" style="font-family:${font.family};font-weight:${font.weight||600};${font.upper?'text-transform:uppercase;':''}">${escapeHtml(it.text||'')}</div>
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

// ---------- "কারা দেখেছে" (who viewed) bottom sheet — own status only ----------
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

  fbDb.collection('statuses').doc(item.id).collection('views').orderBy('viewedAt','desc').get().then(snap => {
    if(snap.empty){ list.innerHTML = `<div class="status-viewers-empty">এখনো কেউ দেখেনি</div>`; return; }
    list.innerHTML = snap.docs.map(d => {
      const v = d.data();
      return `<div class="status-viewer-row">
        <div class="status-viewer-avatar" style="background:${v.avatarColor || PROFILE_AVATAR_COLORS[0]}">${avatarGlyph({ name:v.name, avatarIcon:v.avatarIcon })}</div>
        <div class="status-viewer-name">${escapeHtml(v.name || 'ব্যবহারকারী')}</div>
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

// ---------- Delete own status item ----------
function confirmDeleteCurrentStatusItem(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || group.uid !== state.user.uid) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;
  pauseStatusItemTimer();
  if(!confirm('এই স্ট্যাটাসটি মুছে ফেলতে চান?')){ resumeStatusItemTimer(); return; }
  deleteStatusItem(item, group);
}

function deleteStatusItem(item, group){
  const statusRef = fbDb.collection('statuses').doc(item.id);
  statusRef.collection('views').get().then(snap => {
    const batch = fbDb.batch();
    snap.forEach(d => batch.delete(d.ref));
    batch.delete(statusRef);
    return batch.commit();
  }).then(() => {
    showToast('স্ট্যাটাস মুছে ফেলা হয়েছে');
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
    resumeStatusItemTimer();
  });
}
