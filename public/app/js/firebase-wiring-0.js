/* ════════════════════════════════════════════════════════════════
   WIRING — connect Firebase auth + cloud to the existing app
   - Patches enterCL() so signed-in students skip the name/class step
   - Adds "Link a real student" UI to the Parent Hub children list
   - Pulls live progress from linked children
   - Replaces some "Enter Classroom" CTAs with "Sign up / Sign in" prompts
     (only when the user is signed-out AND Firebase is enabled)
   - Wires arena leaderboard to cloud when available
   ════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

// We wait until firebase-0.js fires the ready event so we know if cloud is enabled.
var fbState = { enabled: false, ready: false };

window.addEventListener('lt-firebase-ready', function(e){
  fbState.enabled = !!(e && e.detail && e.detail.enabled);
  fbState.ready = true;
  attachAll();
});

// Even if firebase isn't enabled, we still attach the parent-link button
// (it'll show a friendly "sign in to use this" message) and the auth chip.
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', attachAll);
} else {
  attachAll();
}

var ATTACHED = false;
function attachAll(){
  if (ATTACHED) return;
  ATTACHED = true;
  patchEnterClassroom();
  patchParentHub();
  patchLandingCTAs();
  patchArenaLeaderboard();
}

// ────────────────────────────────────────────────────────────────
// 1. enterCL() — if signed-in, prefer profile data
// ────────────────────────────────────────────────────────────────
function patchEnterClassroom(){
  var orig = window.enterCL;
  if (!orig) return;
  window.enterCL = function(){
    // If signed in, prefer the user's profile data over any blank inputs.
    if (window.LTAuth && window.LTAuth.isSignedIn() && window._LT_LAST_PROFILE){
      var p = window._LT_LAST_PROFILE;
      try {
        var nameInput = document.getElementById('studentName');
        if (nameInput && !nameInput.value.trim() && p.name) nameInput.value = p.name;
        if (p.section) window.chosenSection = p.section;
        if (p.classLevel) window.chosenClass = p.classLevel;
        if (p.stream) window.chosenStream = p.stream;
      } catch(e){}
    }
    return orig.apply(this, arguments);
  };
}

// ────────────────────────────────────────────────────────────────
// 2. Parent Hub — link a real student by email
// ────────────────────────────────────────────────────────────────
function patchParentHub(){
  // Wrap phRenderProgress so we add a "Link real student" panel after.
  var origRender = window.phRenderProgress;
  if (!origRender) return;

  window.phRenderProgress = function(){
    origRender.apply(this, arguments);
    // Inject the link-by-email panel + linked children list at the top
    // of the existing Add-a-Child section.
    var content = document.getElementById('phContent');
    if (!content) return;
    var firstCard = content.querySelector('.ph-card');
    if (!firstCard) return;

    if (firstCard.querySelector('#phLinkPanel')) return;

    var panel = document.createElement('div');
    panel.id = 'phLinkPanel';
    panel.style.cssText = 'background:linear-gradient(135deg,rgba(37,99,235,.15),rgba(37,99,235,.05));border:1px solid rgba(37,99,235,.3);border-radius:12px;padding:18px;margin-bottom:18px;';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;font-weight:800;color:#93c5fd;font-size:.95rem;margin-bottom:6px;">🔗 Link your child\'s real account</div>' +
      '<div style="color:rgba(255,255,255,.7);font-size:.85rem;margin-bottom:12px;">Pull live progress, exam results and streaks from the student\'s real Lesson Teacher account. Ask your child for the email they used to sign up.</div>' +
      '<div id="phLinkAuthZone"></div>' +
      '<div id="phLinkForm" style="display:none;">' +
        '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;">' +
          '<input id="phLinkEmail" class="ph-input" placeholder="child@example.com" type="email" autocomplete="off">' +
          '<button id="phLinkBtn" class="ph-btn">Link</button>' +
        '</div>' +
        '<div id="phLinkStatus" style="margin-top:8px;font-size:.82rem;color:rgba(255,255,255,.6);"></div>' +
      '</div>' +
      '<div id="phLinkedChildren" style="margin-top:14px;"></div>';
    // Insert at top of first card after its h3
    var h3 = firstCard.querySelector('h3');
    if (h3 && h3.nextSibling) firstCard.insertBefore(panel, h3.nextSibling.nextSibling || null);
    else firstCard.insertBefore(panel, firstCard.firstChild);

    refreshLinkPanel();
    if (window.LTAuth && !window.__ltLinkPanelSubscribed) {
      window.__ltLinkPanelSubscribed = true;
      window.LTAuth.onChange(function(){
        // Only refresh if the panel is still mounted in the DOM
        if (document.getElementById('phLinkPanel')) refreshLinkPanel();
      });
    }
  };

  // Re-render if we're already on the progress tab
  if (document.querySelector('.ph-tab.active')){
    var active = document.querySelector('.ph-tab.active');
    if (active && active.dataset.tab === 'progress'){
      try { window.phRenderProgress(); } catch(e){}
    }
  }
}

function refreshLinkPanel(){
  var authZone = document.getElementById('phLinkAuthZone');
  var form = document.getElementById('phLinkForm');
  var listWrap = document.getElementById('phLinkedChildren');
  if (!authZone || !form || !listWrap) return;

  if (!window.LTCloud || !window.LTCloud.ready){
    authZone.innerHTML = '<div style="padding:10px 12px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;color:#fbbf24;font-size:.82rem;">⚠️ Cloud sync not configured. Set up Firebase to link real student accounts.</div>';
    form.style.display = 'none';
    listWrap.innerHTML = '';
    return;
  }
  if (!window.LTAuth || !window.LTAuth.isSignedIn()){
    authZone.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
        '<div style="color:rgba(255,255,255,.7);font-size:.85rem;">Please sign in as a parent to link your child.</div>' +
        '<button class="ph-btn" id="phLinkSignIn" style="align-self:flex-start;background:#2563eb;">Sign in / Create parent account</button>' +
      '</div>';
    form.style.display = 'none';
    listWrap.innerHTML = '';
    var b = document.getElementById('phLinkSignIn');
    if (b) b.onclick = function(){ window.LTAuthUI.open({ mode:'signup', role:'parent' }); };
    return;
  }
  // Signed in
  authZone.innerHTML = '<div style="font-size:.82rem;color:rgba(110,231,183,.85);margin-bottom:8px;">✓ Signed in as ' + escapeHtml(window.LTAuth.user.email) + '</div>';
  form.style.display = 'block';

  // Wire link button (idempotent)
  var btn = document.getElementById('phLinkBtn');
  var emailIn = document.getElementById('phLinkEmail');
  var statusEl = document.getElementById('phLinkStatus');
  if (btn && !btn.__wired){
    btn.__wired = true;
    btn.onclick = async function(){
      var email = (emailIn.value || '').trim();
      if (!email){ statusEl.textContent = 'Enter your child\'s email.'; return; }
      btn.disabled = true; btn.textContent = 'Linking…';
      statusEl.textContent = '';
      try {
        var res = await window.LTCloud.linkChildByEmail(email);
        statusEl.style.color = '#6ee7b7';
        statusEl.textContent = '✓ Linked ' + (res.childName || email);
        emailIn.value = '';
        await renderLinkedChildren();
      } catch(err){
        statusEl.style.color = '#fca5a5';
        statusEl.textContent = (err && err.message) || 'Could not link.';
      } finally {
        btn.disabled = false; btn.textContent = 'Link';
      }
    };
  }

  renderLinkedChildren();
}

async function renderLinkedChildren(){
  var listWrap = document.getElementById('phLinkedChildren');
  if (!listWrap) return;
  if (!window.LTAuth || !window.LTAuth.isSignedIn()) { listWrap.innerHTML = ''; return; }
  listWrap.innerHTML = '<div style="color:rgba(255,255,255,.5);font-size:.82rem;">Loading linked children…</div>';
  var rows = [];
  try { rows = await window.LTCloud.listLinkedChildren(); } catch(e){ rows = []; }
  if (!rows.length){ listWrap.innerHTML = ''; return; }

  // Pull progress for each (in parallel)
  var progresses = await Promise.all(rows.map(function(r){
    return window.LTCloud.fetchChildProgress(r.childUid).catch(function(){ return null; });
  }));

  var html = '<div style="font-weight:800;color:#93c5fd;font-size:.85rem;margin-bottom:8px;">🎓 Linked students</div>';
  rows.forEach(function(r, i){
    var p = progresses[i] || {};
    var xp = p.xp || 0;
    var streak = p.streak || 0;
    var topics = p.topicsCompleted || 0;
    var lastExam = (p.examResults && p.examResults.length) ? p.examResults[p.examResults.length-1] : null;
    html +=
      '<div style="background:rgba(0,0,0,.25);border-radius:10px;padding:12px 14px;margin-bottom:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<div>' +
            '<div style="font-weight:800;color:#fff;">' + escapeHtml(r.childName || r.childEmail) + '</div>' +
            '<div style="font-size:.78rem;color:rgba(255,255,255,.55);">' + escapeHtml(r.childEmail) + '</div>' +
          '</div>' +
          '<button class="ph-link-unlink" data-uid="' + escapeHtml(r.childUid) + '" style="background:rgba(220,38,38,.15);border:1px solid rgba(220,38,38,.3);color:#fca5a5;padding:5px 10px;border-radius:7px;font-size:.75rem;font-weight:700;cursor:pointer;font-family:inherit;">Unlink</button>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">' +
          '<div style="text-align:center;padding:8px;background:rgba(251,191,36,.08);border-radius:8px;"><div style="font-weight:900;color:#fbbf24;font-size:1.05rem;">' + xp + '</div><div style="font-size:.7rem;color:rgba(255,255,255,.6);">XP</div></div>' +
          '<div style="text-align:center;padding:8px;background:rgba(16,185,129,.08);border-radius:8px;"><div style="font-weight:900;color:#10b981;font-size:1.05rem;">' + topics + '</div><div style="font-size:.7rem;color:rgba(255,255,255,.6);">Topics</div></div>' +
          '<div style="text-align:center;padding:8px;background:rgba(124,58,237,.08);border-radius:8px;"><div style="font-weight:900;color:#a78bfa;font-size:1.05rem;">' + streak + '</div><div style="font-size:.7rem;color:rgba(255,255,255,.6);">Streak</div></div>' +
        '</div>' +
        (lastExam
          ? '<div style="margin-top:8px;font-size:.78rem;color:rgba(255,255,255,.65);">Last exam: <b style="color:#fff;">' + escapeHtml(lastExam.subj || lastExam.subject || '') + '</b> — ' + escapeHtml(String(lastExam.score||'')) + (lastExam.grade ? ' (' + escapeHtml(lastExam.grade) + ')' : '') + '</div>'
          : '<div style="margin-top:8px;font-size:.78rem;color:rgba(255,255,255,.4);">No exams logged yet</div>'
        ) +
      '</div>';
  });
  listWrap.innerHTML = html;
  listWrap.querySelectorAll('.ph-link-unlink').forEach(function(btn){
    btn.onclick = async function(){
      if (!confirm('Unlink this student?')) return;
      try {
        await window.LTCloud.unlinkChild(btn.getAttribute('data-uid'));
        await renderLinkedChildren();
      } catch(e){ alert('Could not unlink.'); }
    };
  });
}

// ────────────────────────────────────────────────────────────────
// 3. Landing CTAs — encourage sign-up but don't block
// ────────────────────────────────────────────────────────────────
function patchLandingCTAs(){
  // Don't change the CTAs at all — we already have an account chip.
  // We just intercept "Enter Classroom" CTAs so signed-in students go
  // directly to their classroom (skipping the level-picker), and
  // anyone else continues to pg-beta as today.
  var origGoTo = window.goTo;
  if (!origGoTo) return;
  window.goTo = function(id){
    if (id === 'pg-beta' && window.LTAuth && window.LTAuth.isSignedIn() && window._LT_LAST_PROFILE){
      var p = window._LT_LAST_PROFILE;
      // Parents always go to parent hub from landing
      if (p.role === 'parent'){
        return origGoTo.call(this, 'pg-parent');
      }
    }
    return origGoTo.apply(this, arguments);
  };
}

// ────────────────────────────────────────────────────────────────
// 4. Arena leaderboard — fetch from cloud when available
// ────────────────────────────────────────────────────────────────
function patchArenaLeaderboard(){
  if (!window.ArenaDB) {
    // Try again later — arena loads asynchronously
    setTimeout(patchArenaLeaderboard, 500);
    return;
  }
  var origTop = window.ArenaDB.topLeaders;
  // We expose an async version that prefers cloud, falls back to local
  window.ArenaDB.topLeadersAsync = async function(classGroup, scope, lim){
    if (window.LTAuth && window.LTAuth.isSignedIn() && window.LTCloud && window.LTCloud.ready){
      try {
        var rows = await window.LTCloud.topLeaders(classGroup, scope, lim);
        if (rows && rows.length) return rows;
      } catch(e){}
    }
    return origTop.call(window.ArenaDB, classGroup, scope, lim);
  };
}

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────
function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

})();
