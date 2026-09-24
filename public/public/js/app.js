(() => {
  'use strict';

  const API = ''; // same-origin; e.g. set to 'https://yourdomain.com' if hosted separately
  let TOKEN = localStorage.getItem('matchify_token') || null;
  let ME = null;
  let profileQueue = [];
  let matchesCache = [];
  let activeMatchId = null;
  let activeOtherUserId = null;
  let chatPollTimer = null;
  let notifPollTimer = null;
  let socket = null;

  // ---------- Call state ----------
  const call = {
    active: false,
    incoming: null,   // { fromUserId, fromName, matchId, callType }
    peer: null,       // RTCPeerConnection
    localStream: null,
    remoteUserId: null,
    matchId: null,
    callType: null,   // 'audio' | 'video'
    startedAt: null,
    timerInterval: null,
    micOn: true,
    camOn: true,
    pendingCandidates: [],
  };
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // ---------- helpers ----------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) {
    const t = $('#toast');
    $('#toastMsg').textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => t.classList.remove('show'), 2200);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const res = await fetch(API + '/api' + path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setToken(token) {
    TOKEN = token;
    if (token) localStorage.setItem('matchify_token', token);
    else localStorage.removeItem('matchify_token');
  }

  // ---------- Nav switching ----------
  function setActiveNav(name) {
    $all('.navitem[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === name));
    $all('.bn-item[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === name));
    $all('.col.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    if (name === 'discover') loadDiscover();
    if (name === 'matches') loadMatches();
    if (name === 'chat') loadChatList();
    if (name === 'profile') loadProfileForm();
    if (name === 'premium') loadPremiumView();
    if (name === 'ai') initAITalk();
  }
  $all('.navitem[data-nav], .bn-item[data-nav]').forEach(item => {
    item.addEventListener('click', () => setActiveNav(item.dataset.nav));
  });

  // ---------- Enter app ----------
  async function enterApp() {
    document.body.classList.remove('auth-active');
    setActiveNav('discover');
    connectSocket();
    loadNotifications();
    notifPollTimer = setInterval(loadNotifications, 15000);
  }

  // ---------- Countries dropdown ----------
  function populateCountrySelects() {
    const list = window.MATCHIFY_COUNTRIES || [];
    const opts = '<option value="">Select country</option>' + list.map(c => `<option value="${c}">${c}</option>`).join('');
    const regSel = document.getElementById('regCountry');
    const pfSel = document.getElementById('pfCountry');
    if (regSel) regSel.innerHTML = opts;
    if (pfSel) pfSel.innerHTML = opts;
    const discSel = document.getElementById('discoverCountry');
    if (discSel) discSel.innerHTML = '<option value="">🌎 Any country</option>' + list.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  populateCountrySelects();

  // ---------- Cookie consent ----------
  (function initCookieBanner() {
    const KEY = 'matchify_cookie_consent';
    if (!localStorage.getItem(KEY)) {
      $('#cookieBanner').classList.add('open');
    }
    $('#cookieAccept').addEventListener('click', () => {
      localStorage.setItem(KEY, 'accepted');
      $('#cookieBanner').classList.remove('open');
    });
    $('#cookieDecline').addEventListener('click', () => {
      localStorage.setItem(KEY, 'declined');
      $('#cookieBanner').classList.remove('open');
    });
  })();

  // ---------- PWA install (desktop "download" option) ----------
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('#installAppBtn').style.display = 'flex';
  });
  $('#installAppBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#installAppBtn').style.display = 'none';
  });

  // ---------- Discover / swipe ----------
  async function loadDiscover() {
    const stack = $('#cardStack');
    stack.querySelectorAll('.swipe-card').forEach(c => c.remove());
    $('#stackEmpty').style.display = 'none';
    try {
      const qs = new URLSearchParams({ limit: '20' });
      const country = $('#discoverCountry')?.value || '';
      const gender = $('#discoverGender')?.value || 'everyone';
      if (country) qs.set('country', country);
      if (gender && gender !== 'everyone') qs.set('gender', gender);
      const data = await api('/users/discover?' + qs.toString());
      profileQueue = data.profiles;
      renderStack();
    } catch (err) {
      toast(err.message);
    }
  }

  function photoOf(u) {
    return (u.photos && u.photos[0]) || `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(u.name)}`;
  }

  function renderStack() {
    const stack = $('#cardStack');
    stack.querySelectorAll('.swipe-card').forEach(c => c.remove());
    if (!profileQueue.length) {
      $('#stackEmpty').style.display = 'block';
      return;
    }
    $('#stackEmpty').style.display = 'none';
    // render up to 3 cards, topmost = last in DOM order is fine since absolute stacked; we build top-first
    const visible = profileQueue.slice(0, 3).reverse();
    visible.forEach((u, i) => {
      const isTop = (i === visible.length - 1);
      const card = document.createElement('div');
      card.className = 'swipe-card';
      card.style.backgroundImage = `url('${photoOf(u)}')`;
      card.style.zIndex = String(10 + i);
      card.style.transform = isTop ? 'none' : `scale(${1 - (visible.length - 1 - i) * 0.04}) translateY(${(visible.length - 1 - i) * 10}px)`;
      card.dataset.userId = u.id;
      card.innerHTML = `
        <div class="grad"></div>
        <div class="stamp like">LIKE</div>
        <div class="stamp nope">NOPE</div>
        <div class="info">
          <div class="name-row">
            <span class="name">${escapeHtml(u.name)}</span>
            <span class="age">${u.age || ''}</span>
            ${u.verified ? '<span class="verified">✓</span>' : ''}
            ${u.isDemo ? '<span class="demo-badge">DEMO PROFILE</span>' : ''}
          </div>
          <div class="meta-row">
            ${u.job ? `<span class="item">💼 ${escapeHtml(u.job)}</span>` : ''}
            ${u.location ? `<span class="item">📍 ${escapeHtml(u.location)}</span>` : ''}
            ${u.country ? `<span class="item">🌍 ${escapeHtml(u.country)}</span>` : ''}
          </div>
          <div class="meta-row" style="margin-top:6px;">${escapeHtml(u.bio || '')}</div>
        </div>
      `;
      stack.appendChild(card);
      if (isTop) attachDrag(card, u);
    });
  }

  function attachDrag(card, user) {
    let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
    const likeStamp = card.querySelector('.stamp.like');
    const nopeStamp = card.querySelector('.stamp.nope');

    function pointerDown(x, y) { dragging = true; startX = x; startY = y; card.style.transition = 'none'; }
    function pointerMove(x, y) {
      if (!dragging) return;
      dx = x - startX; dy = y - startY;
      const rot = dx / 18;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      likeStamp.style.opacity = Math.max(0, Math.min(1, dx / 100));
      nopeStamp.style.opacity = Math.max(0, Math.min(1, -dx / 100));
    }
    function pointerUp() {
      if (!dragging) return;
      dragging = false;
      card.style.transition = '';
      if (dx > 110) { doSwipe(user, 'like', card); }
      else if (dx < -110) { doSwipe(user, 'pass', card); }
      else {
        card.style.transform = 'none';
        likeStamp.style.opacity = 0; nopeStamp.style.opacity = 0;
      }
      dx = 0; dy = 0;
    }
    // Use Pointer Events with capture so listeners stay scoped to this card
    // (avoids accumulating window-level listeners across re-renders).
    card.addEventListener('pointerdown', e => {
      card.setPointerCapture(e.pointerId);
      pointerDown(e.clientX, e.clientY);
    });
    card.addEventListener('pointermove', e => {
      if (dragging) pointerMove(e.clientX, e.clientY);
    });
    card.addEventListener('pointerup', pointerUp);
    card.addEventListener('pointercancel', pointerUp);
  }

  async function doSwipe(user, action, cardEl) {
    // animate out
    if (cardEl) {
      const dir = action === 'like' ? 1 : action === 'pass' ? -1 : 0;
      cardEl.style.transition = 'transform .35s ease, opacity .35s ease';
      cardEl.style.transform = `translate(${dir * 500}px, ${action === 'superlike' ? -600 : -40}px) rotate(${dir * 30}deg)`;
      cardEl.style.opacity = '0';
    }
    profileQueue = profileQueue.filter(p => p.id !== user.id);
    setTimeout(renderStack, 260);

    try {
      const data = await api('/swipes', { method: 'POST', body: JSON.stringify({ targetId: user.id, action }) });
      if (data.match) {
        openMatchModal(data.match);
      }
    } catch (err) {
      toast(err.message);
    }

    if (profileQueue.length < 3) {
      // top up in background
      try {
        const qs = new URLSearchParams({ limit: '10' });
        const country = $('#discoverCountry')?.value || '';
        const gender = $('#discoverGender')?.value || 'everyone';
        if (country) qs.set('country', country);
        if (gender && gender !== 'everyone') qs.set('gender', gender);
        const more = await api('/users/discover?' + qs.toString());
        const existingIds = new Set(profileQueue.map(p => p.id));
        more.profiles.forEach(p => { if (!existingIds.has(p.id) && p.id !== ME.id) profileQueue.push(p); });
      } catch (e) {}
    }
  }

  $('#btnLike').addEventListener('click', () => { const top = topCardUser(); if (top) doSwipe(top, 'like', $('#cardStack .swipe-card:last-child')); });
  $('#btnPass').addEventListener('click', () => { const top = topCardUser(); if (top) doSwipe(top, 'pass', $('#cardStack .swipe-card:last-child')); });
  $('#btnSuper').addEventListener('click', () => { const top = topCardUser(); if (top) doSwipe(top, 'superlike', $('#cardStack .swipe-card:last-child')); });
  function topCardUser() {
    if (!profileQueue.length) return null;
    return profileQueue[0];
  }

  function openMatchModal(match) {
    $('#matchModalSub').textContent = `You and ${match.user.name} liked each other.`;
    $('#matchModal').classList.add('open');
    $('#matchModal').dataset.matchId = match.id;
    $('#matchModal').dataset.userName = match.user.name;
  }
  $('#matchModalKeep').addEventListener('click', () => $('#matchModal').classList.remove('open'));
  $('#matchModalChat').addEventListener('click', () => {
    const matchId = $('#matchModal').dataset.matchId;
    $('#matchModal').classList.remove('open');
    setActiveNav('chat');
    setTimeout(() => openConversation(matchId), 300);
  });

  $('#applyDiscoverFilters').addEventListener('click', () => loadDiscover());
  $('#randomTalkBtn').addEventListener('click', async () => {
    const btn = $('#randomTalkBtn');
    const original = btn.textContent;
    btn.textContent = 'Finding...'; btn.disabled = true;
    try {
      const data = await api('/users/random-talk', {
        method: 'POST',
        body: JSON.stringify({
          country: $('#discoverCountry').value,
          gender: $('#discoverGender').value,
        }),
      });
      toast(`Random match found: ${data.match.user.name}`);
      setActiveNav('chat');
      setTimeout(() => openConversation(data.match.id), 250);
    } catch (err) { toast(err.message); }
    finally { btn.textContent = original; btn.disabled = false; }
  });

  // ---------- AI Talk ----------
  let aiPersona = 'friendly';
  let aiTalkReady = false;
  function initAITalk() {
    if (aiTalkReady) return;
    aiTalkReady = true;
    $all('.ai-persona').forEach(btn => btn.addEventListener('click', () => {
      $all('.ai-persona').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      aiPersona = btn.dataset.persona;
    }));
    const send = async () => {
      const input = $('#aiChatInput');
      const message = input.value.trim();
      if (!message) return;
      appendAIMessage(message, 'user'); input.value = '';
      try {
        const data = await api('/ai/companion', { method:'POST', body:JSON.stringify({ message, persona: aiPersona }) });
        appendAIMessage(data.reply, 'bot');
      } catch (err) { appendAIMessage(err.message, 'bot'); }
    };
    $('#aiChatSend').addEventListener('click', send);
    $('#aiChatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }
  function appendAIMessage(text, who) {
    const box = $('#aiChatBox');
    const div = document.createElement('div');
    div.className = `ai-msg ${who}`;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ---------- Matches list ----------
  async function loadMatches() {
    const list = $('#matchesList');
    list.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const data = await api('/matches');
      matchesCache = data.matches;
      updateChatBadge();
      if (!data.matches.length) {
        list.innerHTML = '<div class="empty-state">No matches yet — keep swiping in Discover!</div>';
        return;
      }
      list.innerHTML = data.matches.map(m => `
        <div class="match-item" data-match-id="${m.id}" style="cursor:pointer;">
          <div class="avatar sz48" style="background-image:url('${photoOf(m.user)}')"></div>
          <div class="body">
            <div class="row1"><span class="nm">${escapeHtml(m.user.name)}</span>${m.user.isDemo ? '<span class="demo-badge">DEMO</span>' : ''}</div>
            <div class="sub">${m.lastMessage ? escapeHtml(m.lastMessage.text) : 'Say hello 👋'}</div>
          </div>
        </div>
      `).join('');
      list.querySelectorAll('.match-item').forEach(el => {
        el.addEventListener('click', () => {
          setActiveNav('chat');
          setTimeout(() => openConversation(el.dataset.matchId), 100);
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function updateChatBadge() {
    const unread = matchesCache.reduce((sum, m) => sum + (m.unreadCount || 0), 0);
    [$('#chatNavBadge'), $('#chatNavBadgeMobile')].forEach(badge => {
      badge.textContent = unread;
      badge.style.display = unread ? '' : 'none';
    });
  }

  // ---------- Chat ----------
  async function loadChatList() {
    const list = $('#chatList');
    list.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const data = await api('/matches');
      matchesCache = data.matches;
      updateChatBadge();
      if (!data.matches.length) {
        list.innerHTML = '<div class="empty-state">Match with someone in Discover to start chatting.</div>';
        return;
      }
      list.innerHTML = data.matches.map(m => `
        <div class="match-item" data-match-id="${m.id}" style="cursor:pointer;">
          <div class="avatar sz48" style="background-image:url('${photoOf(m.user)}')">${m.unreadCount ? `<span class="dot"></span>` : ''}</div>
          <div class="body">
            <div class="row1"><span class="nm">${escapeHtml(m.user.name)}</span>${m.user.isDemo ? '<span class="demo-badge">DEMO</span>' : ''}</div>
            <div class="sub ${m.unreadCount ? 'new' : ''}">${m.lastMessage ? escapeHtml(m.lastMessage.text) : 'Say hello 👋'}</div>
          </div>
        </div>
      `).join('');
      list.querySelectorAll('.match-item').forEach(el => {
        el.addEventListener('click', () => openConversation(el.dataset.matchId));
      });
      if (activeMatchId) openConversation(activeMatchId, true);
    } catch (err) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  async function openConversation(matchId, silent) {
    matchId = String(matchId);
    activeMatchId = matchId;
    const match = matchesCache.find(m => String(m.id) === matchId);
    if (!match) return;
    activeOtherUserId = match.user.id;
    $('#chatEmpty').style.display = 'none';
    $('#chatConv').style.display = 'flex';
    $('#chatHeadAvatar').style.backgroundImage = `url('${photoOf(match.user)}')`;
    $('#chatHeadName').innerHTML = escapeHtml(match.user.name) + (match.user.isDemo ? '<span class="demo-badge">DEMO</span>' : '');

    try {
      const data = await api(`/matches/${matchId}/messages`);
      renderMessages(data.messages);
      if (!data.messages.length) loadIcebreakers(matchId); else $('#icebreakersRow').style.display = 'none';
    } catch (err) {
      if (!silent) toast(err.message);
    }

    loadCompatBadge(matchId);

    clearInterval(chatPollTimer);
    chatPollTimer = setInterval(async () => {
      if (activeMatchId !== matchId) return;
      try {
        const data = await api(`/matches/${matchId}/messages`);
        renderMessages(data.messages);
      } catch (e) {}
    }, 3000);
  }

  // ---------- AI: compatibility badge ----------
  async function loadCompatBadge(matchId) {
    const badge = $('#compatBadge');
    badge.style.display = 'none';
    try {
      const data = await api(`/ai/compatibility/${matchId}`);
      if (String(activeMatchId) !== String(matchId)) return;
      badge.textContent = `✨ ${data.score}% match`;
      badge.title = data.why || 'AI compatibility score';
      badge.style.display = '';
    } catch (e) { /* silently skip if it fails */ }
  }

  // ---------- AI: icebreaker suggestions ----------
  async function loadIcebreakers(matchId) {
    const row = $('#icebreakersRow');
    try {
      const data = await api('/ai/icebreakers', { method: 'POST', body: JSON.stringify({ matchId }) });
      if (String(activeMatchId) !== String(matchId)) return;
      row.innerHTML = data.icebreakers.map(t => `<div class="icebreaker-chip">${escapeHtml(t)}</div>`).join('');
      row.style.display = data.icebreakers.length ? 'flex' : 'none';
      row.querySelectorAll('.icebreaker-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          $('#chatInputField').value = chip.textContent;
          $('#chatInputField').focus();
        });
      });
    } catch (e) {
      row.style.display = 'none';
    }
  }


  function renderMessages(messages) {
    const body = $('#chatBody');
    if (!messages.length) {
      body.innerHTML = `<div class="conv-empty">No messages yet. Say hi!</div>`;
      return;
    }
    body.innerHTML = messages.map(m => `
      <div class="bubble ${m.senderId === ME.id ? 'me' : 'them'}" data-msg-id="${m.id}" data-text="${escapeHtml(m.text)}">
        <span class="msg-text">${escapeHtml(m.text)}</span>
        <span class="t">${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        ${m.senderId !== ME.id && m.type !== 'call' ? `<span class="translate-link">Translate</span>` : ''}
      </div>
    `).join('');
    body.querySelectorAll('.translate-link').forEach(link => {
      link.addEventListener('click', () => translateBubble(link));
    });
    body.scrollTop = body.scrollHeight;
  }

  // ---------- AI: translate an incoming message (Plus/Pro/Ultra) ----------
  async function translateBubble(link) {
    const bubble = link.closest('.bubble');
    const text = bubble.dataset.text;
    const targetLang = (navigator.language || 'en').split('-')[0] === 'en' ? 'Hindi' : navigator.language;
    link.textContent = 'Translating...';
    try {
      const data = await api('/ai/translate', { method: 'POST', body: JSON.stringify({ text, targetLang }) });
      if (data.source === 'unavailable') {
        toast(data.note || 'Translation not available yet');
        link.textContent = 'Translate';
        return;
      }
      let out = bubble.querySelector('.translated-text');
      if (!out) {
        out = document.createElement('span');
        out.className = 'translated-text';
        bubble.insertBefore(out, bubble.querySelector('.t'));
      }
      out.textContent = data.translated;
      link.remove();
    } catch (err) {
      link.textContent = 'Translate';
      toast(err.status === 402 ? err.message : 'Could not translate that message');
    }
  }

  async function sendMessage() {
    const input = $('#chatInputField');
    const text = input.value.trim();
    if (!text || !activeMatchId) return;
    input.value = '';
    $('#icebreakersRow').style.display = 'none';
    try {
      await api(`/matches/${activeMatchId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      const data = await api(`/matches/${activeMatchId}/messages`);
      renderMessages(data.messages);
    } catch (err) {
      toast(err.message);
    }
  }
  $('#chatSendBtn').addEventListener('click', sendMessage);
  $('#chatInputField').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

  // ---------- Safety: block / report / unmatch ----------
  $('#chatMoreBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#chatMoreMenu').classList.toggle('open');
  });
  document.addEventListener('click', () => $('#chatMoreMenu').classList.remove('open'));

  $('#chatUnmatchBtn').addEventListener('click', async () => {
    if (!activeMatchId) return;
    if (!confirm('Unmatch with this person? This cannot be undone.')) return;
    try {
      await api(`/matches/${activeMatchId}`, { method: 'DELETE' });
      toast('Unmatched');
      $('#chatConv').style.display = 'none';
      $('#chatEmpty').style.display = 'flex';
      activeMatchId = null;
      loadChatList();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#chatBlockBtn').addEventListener('click', async () => {
    if (!activeOtherUserId) return;
    if (!confirm('Block this person? They will be removed from your matches and won\'t be able to contact you.')) return;
    try {
      await api(`/safety/block/${activeOtherUserId}`, { method: 'POST' });
      toast('User blocked');
      $('#chatConv').style.display = 'none';
      $('#chatEmpty').style.display = 'flex';
      activeMatchId = null;
      loadChatList();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#chatReportBtn').addEventListener('click', () => {
    if (!activeOtherUserId) return;
    $('#reportModal').classList.add('open');
  });
  $('#reportCancelBtn').addEventListener('click', () => $('#reportModal').classList.remove('open'));
  $('#reportConfirmBtn').addEventListener('click', async () => {
    if (!activeOtherUserId) return;
    try {
      await api('/safety/report', {
        method: 'POST',
        body: JSON.stringify({
          userId: activeOtherUserId,
          reason: $('#reportReason').value,
          details: $('#reportDetails').value.trim(),
          matchId: activeMatchId,
        }),
      });
      $('#reportModal').classList.remove('open');
      $('#reportDetails').value = '';
      toast('Report submitted — thank you for keeping Matchify safe.');
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Notifications ----------
  async function loadNotifications() {
    try {
      const data = await api('/notifications');
      const badge = $('#notifBadge');
      badge.textContent = data.unreadCount;
      badge.style.display = data.unreadCount ? 'block' : 'none';
      const panel = $('#notifPanel');
      panel.innerHTML = data.notifications.length
        ? data.notifications.map(n => `<div class="notif-item">${escapeHtml(n.text)}</div>`).join('')
        : '<div class="notif-item">No notifications yet.</div>';
    } catch (e) { /* non-critical */ }
  }
  $('#notifBell').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#notifPanel').classList.toggle('open');
  });
  document.addEventListener('click', () => $('#notifPanel').classList.remove('open'));


  // ---------- Profile ----------
  const MAX_PROFILE_PHOTOS = 9; // mirrors server/config.js MAX_PROFILE_PHOTOS
  let profilePhotos = [];

  function renderPhotoGrid() {
    const grid = $('#photoGrid');
    grid.innerHTML = profilePhotos.map((url, i) => `
      <div class="photo-slot" style="background-image:url('${url}')" data-i="${i}">
        ${i === 0 ? '<span class="primary-tag">PRIMARY</span>' : ''}
        <button class="rm" data-i="${i}" title="Remove">✕</button>
      </div>
    `).join('');
    grid.querySelectorAll('.rm').forEach(btn => {
      btn.addEventListener('click', () => {
        profilePhotos.splice(parseInt(btn.dataset.i, 10), 1);
        renderPhotoGrid();
        updateProfilePreview();
      });
    });
    $('#pfPhotoAddBtn').disabled = profilePhotos.length >= MAX_PROFILE_PHOTOS;
  }
  function updateProfilePreview() {
    const preview = $('#profilePhotoPreview');
    if (profilePhotos[0]) {
      preview.style.backgroundImage = `url('${profilePhotos[0]}')`;
      preview.textContent = '';
    } else {
      preview.style.backgroundImage = '';
      preview.textContent = '👤';
    }
  }
  $('#maxPhotosLabel').textContent = MAX_PROFILE_PHOTOS;
  $('#pfPhotoAddBtn').addEventListener('click', () => {
    const input = $('#pfPhotoInput');
    const url = input.value.trim();
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url)) { toast('Enter a valid image URL (starting with http:// or https://)'); return; }
    if (profilePhotos.length >= MAX_PROFILE_PHOTOS) { toast(`You can have at most ${MAX_PROFILE_PHOTOS} photos`); return; }
    profilePhotos.push(url);
    input.value = '';
    renderPhotoGrid();
    updateProfilePreview();
  });

  function loadProfileForm() {
    if (!ME) return;
    $('#pfName').value = ME.name || '';
    $('#pfAge').value = ME.age || '';
    $('#pfJob').value = ME.job || '';
    $('#pfLocation').value = ME.location || '';
    $('#pfCountry').value = ME.country || '';
    $('#pfBio').value = ME.bio || '';
    $('#pfInterests').value = (ME.interests || []).join(', ');
    profilePhotos = (ME.photos || []).slice(0, MAX_PROFILE_PHOTOS);
    renderPhotoGrid();
    updateProfilePreview();
  }

  // ---------- AI: bio generator ----------
  $('#aiBioGenBtn').addEventListener('click', async () => {
    const btn = $('#aiBioGenBtn');
    const keywords = $('#aiBioKeywords').value.trim();
    if (!keywords) { toast('Type a few words about yourself first'); return; }
    const tone = $('#aiBioTone').value;
    const original = btn.textContent;
    btn.textContent = 'Generating...';
    btn.disabled = true;
    try {
      const data = await api('/ai/bio', { method: 'POST', body: JSON.stringify({ keywords, tone }) });
      $('#pfBio').value = data.bio;
      toast('Bio generated ✓ — edit it or hit Save changes');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });

  $('#pfSaveBtn').addEventListener('click', async () => {
    const body = {
      name: $('#pfName').value.trim(),
      age: parseInt($('#pfAge').value, 10) || null,
      job: $('#pfJob').value.trim(),
      location: $('#pfLocation').value.trim(),
      country: $('#pfCountry').value,
      bio: $('#pfBio').value.trim(),
      interests: $('#pfInterests').value.split(',').map(s => s.trim()).filter(Boolean),
      photos: profilePhotos,
    };
    try {
      const data = await api('/users/me', { method: 'PUT', body: JSON.stringify(body) });
      ME = data.user;
      profilePhotos = (ME.photos || []).slice(0, MAX_PROFILE_PHOTOS);
      renderPhotoGrid();
      updateProfilePreview();
      toast('Profile updated ✓');
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Premium / subscription (mock payment) ----------
  let billingCycle = 'monthly';

  function applyCycleToCards() {
    $all('.cycle-price').forEach(el => {
      el.innerHTML = el.dataset[billingCycle];
    });
    $all('[data-yearly-only]').forEach(el => {
      el.style.display = billingCycle === 'yearly' ? '' : 'none';
    });
    $('#autopayNote').style.display = billingCycle === 'yearly' ? 'block' : 'none';
  }
  $all('.auth-tabs .auth-tab[data-cycle]').forEach(tab => {
    tab.addEventListener('click', () => {
      $all('.auth-tabs .auth-tab[data-cycle]').forEach(t => t.classList.toggle('active', t === tab));
      billingCycle = tab.dataset.cycle;
      applyCycleToCards();
    });
  });

  function loadPremiumView() {
    applyCycleToCards();
    const currentPlan = (ME && ME.plan) || 'free';
    $all('.plan-btn').forEach(btn => {
      const plan = btn.dataset.plan;
      if (plan === currentPlan && plan !== 'day_pass') {
        btn.textContent = 'Current plan';
        btn.classList.add('ghost');
        btn.disabled = true;
      } else {
        btn.textContent = plan === 'free' ? 'Downgrade' : plan === 'day_pass' ? 'Buy day pass' : 'Subscribe';
        btn.classList.remove('ghost');
        btn.disabled = false;
      }
    });
  }
  $all('.plan-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const plan = btn.dataset.plan;
      const body = { plan };
      if (plan === 'plus' || plan === 'pro') body.billingCycle = billingCycle;
      try {
        const data = await api('/users/subscribe', { method: 'POST', body: JSON.stringify(body) });
        ME = data.user;
        const label = plan === 'free' ? 'Back on the Free plan'
          : plan === 'day_pass' ? "Day pass active for 24 hours (mock payment) ✓"
          : `You're on the ${plan} plan now, billed ${billingCycle} (mock payment) ✓`;
        toast(label);
        loadPremiumView();
      } catch (err) {
        toast(err.message);
      }
    });
  });

  // ---------- Realtime: Socket.io connection for call signaling ----------
  function connectSocket() {
    if (!window.io || !TOKEN) return;
    if (socket) socket.disconnect();
    socket = window.io({ auth: { token: TOKEN } });

    socket.on('call:incoming', (payload) => {
      if (call.active || call.incoming) {
        // Busy on another call — auto-reject
        socket.emit('call:reject', { toUserId: payload.fromUserId, matchId: payload.matchId, reason: 'busy' });
        return;
      }
      call.incoming = payload;
      showIncomingCallModal(payload);
    });

    socket.on('call:accepted', async ({ fromUserId }) => {
      if (!call.active || call.remoteUserId !== fromUserId) return;
      $('#audioCallStatus').textContent = 'Connecting...';
      await startWebRTCOffer();
    });

    socket.on('call:rejected', ({ fromUserId, reason }) => {
      if (call.remoteUserId !== fromUserId) return;
      toast(reason === 'busy' ? 'They are on another call' : 'Call declined');
      endCallLocal('rejected');
    });

    socket.on('call:cancelled', ({ fromUserId }) => {
      if (call.incoming && call.incoming.fromUserId === fromUserId) {
        hideIncomingCallModal();
        call.incoming = null;
      }
    });

    socket.on('call:ended', ({ fromUserId }) => {
      if (call.remoteUserId === fromUserId) {
        toast('Call ended');
        endCallLocal('completed');
      }
    });

    socket.on('call:signal', async ({ fromUserId, data }) => {
      if (call.remoteUserId !== fromUserId) return;
      if (!call.peer) {
        // Peer connection isn't set up yet (e.g. ICE candidates arriving before
        // local media/offer negotiation finishes) — queue and flush later.
        call.pendingCandidates.push(data);
        return;
      }
      await handleSignalData(fromUserId, data);
    });
  }

  // ---------- Outgoing call ----------
  $('#chatCallAudioBtn').addEventListener('click', () => initiateCall('audio'));
  $('#chatCallVideoBtn').addEventListener('click', () => initiateCall('video'));

  function initiateCall(callType) {
    if (!activeMatchId || !socket) return toast('Open a conversation first');
    const match = matchesCache.find(m => String(m.id) === String(activeMatchId));
    if (!match) return;
    if (call.active || call.incoming) return toast('You are already on a call');

    call.matchId = activeMatchId;
    call.remoteUserId = match.user.id;
    call.callType = callType;
    call.active = true;

    openCallOverlay(match.user, callType, 'Calling...');
    socket.emit('call:invite', { toUserId: match.user.id, matchId: activeMatchId, callType, fromName: ME.name });
  }

  $('#endCallBtn').addEventListener('click', () => {
    if (call.remoteUserId && socket) socket.emit('call:end', { toUserId: call.remoteUserId, matchId: call.matchId });
    endCallLocal('completed');
  });

  // ---------- Incoming call UI ----------
  function showIncomingCallModal(payload) {
    const match = matchesCache.find(m => String(m.id) === String(payload.matchId));
    const user = match ? match.user : { name: payload.fromName, photos: [] };
    $('#incomingCallAvatar').style.backgroundImage = user.photos && user.photos[0] ? `url('${photoOf(user)}')` : '';
    $('#incomingCallAvatar').textContent = user.photos && user.photos[0] ? '' : '👤';
    $('#incomingCallName').textContent = payload.fromName || user.name || 'Someone';
    $('#incomingCallSub').textContent = `Incoming ${payload.callType === 'video' ? 'video' : 'voice'} call...`;
    $('#incomingCallModal').classList.add('open');
  }
  function hideIncomingCallModal() {
    $('#incomingCallModal').classList.remove('open');
  }
  $('#incomingCallReject').addEventListener('click', () => {
    if (!call.incoming) return;
    socket.emit('call:reject', { toUserId: call.incoming.fromUserId, matchId: call.incoming.matchId });
    hideIncomingCallModal();
    call.incoming = null;
  });
  $('#incomingCallAccept').addEventListener('click', async () => {
    if (!call.incoming) return;
    const payload = call.incoming;
    hideIncomingCallModal();
    call.incoming = null;
    call.matchId = payload.matchId;
    call.remoteUserId = payload.fromUserId;
    call.callType = payload.callType;
    call.active = true;

    const match = matchesCache.find(m => String(m.id) === String(payload.matchId));
    openCallOverlay(match ? match.user : { name: payload.fromName }, payload.callType, 'Connecting...');
    await setupLocalMedia(payload.callType);
    socket.emit('call:accept', { toUserId: payload.fromUserId, matchId: payload.matchId });
  });

  // ---------- WebRTC plumbing ----------
  async function handleSignalData(fromUserId, data) {
    if (!call.peer) return;
    try {
      if (data.type === 'offer') {
        await call.peer.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await call.peer.createAnswer();
        await call.peer.setLocalDescription(answer);
        socket.emit('call:signal', { toUserId: fromUserId, data: call.peer.localDescription });
      } else if (data.type === 'answer') {
        await call.peer.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        await call.peer.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (e) { console.error('signal error', e); }
  }

  async function flushPendingCandidates() {
    if (!call.remoteUserId) return;
    const queued = call.pendingCandidates.splice(0, call.pendingCandidates.length);
    for (const data of queued) {
      await handleSignalData(call.remoteUserId, data);
    }
  }

  async function setupLocalMedia(callType) {
    try {
      const constraints = callType === 'video' ? { audio: true, video: { width: 480, height: 640 } } : { audio: true, video: false };
      call.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (callType === 'video') {
        const lv = $('#localVideo');
        lv.srcObject = call.localStream;
        lv.style.display = 'block';
      }
    } catch (err) {
      toast('Could not access microphone/camera: ' + err.message);
      endCallLocal('failed');
      throw err;
    }
    createPeerConnection();
  }

  function createPeerConnection() {
    call.peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    call.localStream.getTracks().forEach(track => call.peer.addTrack(track, call.localStream));

    call.peer.onicecandidate = (e) => {
      if (e.candidate && socket && call.remoteUserId) {
        socket.emit('call:signal', { toUserId: call.remoteUserId, data: e.candidate });
      }
    };
    call.peer.ontrack = (e) => {
      if (call.callType === 'video') {
        const rv = $('#remoteVideo');
        rv.srcObject = e.streams[0];
        rv.style.display = 'block';
      } else {
        // Audio-only: play remote audio via a hidden element on the audio view
        let audioEl = document.getElementById('remoteAudioEl');
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'remoteAudioEl';
          audioEl.autoplay = true;
          document.body.appendChild(audioEl);
        }
        audioEl.srcObject = e.streams[0];
      }
      $('#audioCallStatus').textContent = 'Connected';
      startCallTimer();
    };
    call.peer.onconnectionstatechange = () => {
      if (call.peer && ['disconnected', 'failed', 'closed'].includes(call.peer.connectionState)) {
        // Let the explicit call:end/call:ended events drive teardown to avoid double-cleanup
      }
    };
    flushPendingCandidates();
  }

  async function startWebRTCOffer() {
    await setupLocalMedia(call.callType);
    const offer = await call.peer.createOffer();
    await call.peer.setLocalDescription(offer);
    socket.emit('call:signal', { toUserId: call.remoteUserId, data: call.peer.localDescription });
  }

  function openCallOverlay(user, callType, statusText) {
    $('#inCallOverlay').classList.add('open');
    $('#audioCallName').textContent = user.name || '';
    const av = $('#audioCallAvatar');
    av.style.backgroundImage = user.photos && user.photos[0] ? `url('${photoOf(user)}')` : '';
    $('#audioCallStatus').textContent = statusText;
    $('#inCallTimer').textContent = '00:00';

    if (callType === 'video') {
      $('#audioCallView').style.display = 'none';
      $('#remoteVideo').style.display = 'block';
      $('#toggleCamBtn').style.display = 'flex';
    } else {
      $('#audioCallView').style.display = 'flex';
      $('#remoteVideo').style.display = 'none';
      $('#localVideo').style.display = 'none';
      $('#toggleCamBtn').style.display = 'none';
    }
    call.micOn = true;
    call.camOn = true;
    $('#toggleMuteBtn').classList.remove('off');
    $('#toggleCamBtn').classList.remove('off');
  }

  function startCallTimer() {
    call.startedAt = Date.now();
    clearInterval(call.timerInterval);
    call.timerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - call.startedAt) / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      $('#inCallTimer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);
  }

  function endCallLocal(status) {
    const duration = call.startedAt ? Math.floor((Date.now() - call.startedAt) / 1000) : 0;
    const matchId = call.matchId, calleeId = call.remoteUserId, callType = call.callType;

    clearInterval(call.timerInterval);
    if (call.peer) { try { call.peer.close(); } catch (e) {} }
    if (call.localStream) { call.localStream.getTracks().forEach(t => t.stop()); }
    const remoteAudioEl = document.getElementById('remoteAudioEl');
    if (remoteAudioEl) remoteAudioEl.remove();
    $('#localVideo').srcObject = null;
    $('#remoteVideo').srcObject = null;
    $('#inCallOverlay').classList.remove('open');

    call.active = false;
    call.peer = null;
    call.localStream = null;
    call.remoteUserId = null;
    call.matchId = null;
    call.callType = null;
    call.startedAt = null;

    // Log the call so it appears in the chat history (persisted in the DB)
    if (matchId && calleeId && callType && (status === 'completed' || status === 'rejected')) {
      api(`/matches/${matchId}/calls`, {
        method: 'POST',
        body: JSON.stringify({ calleeId, callType, status: status === 'rejected' ? 'missed' : 'completed', durationSeconds: duration }),
      }).then(() => {
        if (activeMatchId === String(matchId)) openConversation(matchId, true);
      }).catch(() => {});
    }
  }

  $('#toggleMuteBtn').addEventListener('click', () => {
    if (!call.localStream) return;
    call.micOn = !call.micOn;
    call.localStream.getAudioTracks().forEach(t => (t.enabled = call.micOn));
    $('#toggleMuteBtn').classList.toggle('off', !call.micOn);
  });
  $('#toggleCamBtn').addEventListener('click', () => {
    if (!call.localStream) return;
    call.camOn = !call.camOn;
    call.localStream.getVideoTracks().forEach(t => (t.enabled = call.camOn));
    $('#toggleCamBtn').classList.toggle('off', !call.camOn);
  });

  // ---------- Auth gate (login / signup / guest demo) ----------
  let demoModeEnabled = false;
  let requireAgeVerification = false;

  function showAuthError(msg) {
    const el = $('#authError');
    el.textContent = msg;
    el.classList.add('show');
  }
  function clearAuthError() {
    $('#authError').classList.remove('show');
  }

  $all('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $all('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
      $('#panel-login').classList.toggle('active', tab.dataset.tab === 'login');
      $('#panel-signup').classList.toggle('active', tab.dataset.tab === 'signup');
      clearAuthError();
    });
  });

  $('#loginSubmitBtn').addEventListener('click', async () => {
    clearAuthError();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email || !password) return showAuthError('Enter your email and password.');
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setToken(data.token);
      ME = data.user;
      proceedAfterAuth();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $('#signupSubmitBtn').addEventListener('click', async () => {
    clearAuthError();
    const name = $('#signupName').value.trim();
    const email = $('#signupEmail').value.trim();
    const password = $('#signupPassword').value;
    const age = $('#signupAge').value;
    if (!name || !email || !password || !age) return showAuthError('Please fill in every field.');
    try {
      const data = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password, age }) });
      setToken(data.token);
      ME = data.user;
      proceedAfterAuth();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $('#authGuestBtn').addEventListener('click', async () => {
    clearAuthError();
    try {
      const data = await api('/auth/demo', { method: 'POST' });
      setToken(data.token);
      ME = data.user;
      proceedAfterAuth();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  // ---------- Age verification gate ----------
  let verifyPollTimer = null;

  function proceedAfterAuth() {
    document.body.classList.remove('auth-active');
    if (!requireAgeVerification || ME.isDemo || ME.verificationStatus === 'verified') {
      document.body.classList.remove('verify-active');
      enterApp();
      return;
    }
    showVerifyGate();
  }

  async function showVerifyGate() {
    document.body.classList.add('verify-active');
    try {
      const data = await api('/verification/status');
      renderVerifyStatus(data.status, data.rejectionReason);
    } catch (e) {
      renderVerifyStatus('unverified');
    }
  }

  function renderVerifyStatus(status, rejectionReason) {
    $('#verifyStatusPending').style.display = status === 'pending' ? 'block' : 'none';
    $('#verifyStatusRejected').style.display = status === 'rejected' ? 'block' : 'none';
    $('#verifyStartBtn').style.display = (status === 'unverified' || status === 'rejected') ? 'block' : 'none';
    $('#verifyStartBtn').textContent = status === 'rejected' ? 'Try again' : 'Start verification';
    if (status === 'rejected') {
      $('#verifyRejectReason').textContent = 'Verification was not approved' + (rejectionReason ? ` (${rejectionReason})` : '') + '.';
    }
    if (status === 'pending') {
      clearInterval(verifyPollTimer);
      verifyPollTimer = setInterval(async () => {
        try {
          const data = await api('/verification/status');
          if (data.status !== 'pending') {
            clearInterval(verifyPollTimer);
            renderVerifyStatus(data.status, data.rejectionReason);
            if (data.status === 'verified') {
              ME.verificationStatus = 'verified';
              proceedAfterAuth();
            }
          }
        } catch (e) {}
      }, 4000);
    } else {
      clearInterval(verifyPollTimer);
    }
  }

  $('#verifyStartBtn').addEventListener('click', async () => {
    try {
      const data = await api('/verification/start', { method: 'POST' });
      renderVerifyStatus(data.status);
      if (!data.providerConfigured) {
        toast('No verification provider is configured yet on the server (see VERIFICATION_PROVIDER in .env) — use the dev tools below to simulate a result locally.');
      }
    } catch (err) {
      toast(err.message);
    }
  });
  $('#verifyDevApproveBtn').addEventListener('click', async () => {
    try {
      await api('/verification/dev-simulate', { method: 'POST', body: JSON.stringify({ result: 'verified' }) });
      ME.verificationStatus = 'verified';
      toast('Simulated verification approved (dev only)');
      proceedAfterAuth();
    } catch (err) { toast(err.message); }
  });
  $('#verifyDevRejectBtn').addEventListener('click', async () => {
    try {
      await api('/verification/dev-simulate', { method: 'POST', body: JSON.stringify({ result: 'rejected' }) });
      renderVerifyStatus('rejected', 'dev_simulated_rejection');
    } catch (err) { toast(err.message); }
  });
  $('#verifyLogoutBtn').addEventListener('click', () => {
    clearInterval(verifyPollTimer);
    setToken(null);
    ME = null;
    document.body.classList.remove('verify-active');
    document.body.classList.add('auth-active');
  });

  // ---------- Boot ----------
  (async function boot() {
    try {
      const cfg = await api('/auth/config');
      demoModeEnabled = !!cfg.demoMode;
      requireAgeVerification = !!cfg.requireAgeVerification;
      // Only show the dev-simulate shortcut when no real provider is configured —
      // the server also hard-disables that endpoint outright when NODE_ENV=production.
      $('#verifyDevTools').style.display = cfg.verificationProviderConfigured ? 'none' : 'block';
    } catch (e) {
      demoModeEnabled = false;
    }
    $('#authGuestBtn').style.display = demoModeEnabled ? 'block' : 'none';

    if (TOKEN) {
      try {
        ME = (await api('/auth/me')).user;
        proceedAfterAuth();
        return;
      } catch (e) {
        setToken(null); // stale/invalid token — fall through to auth gate
      }
    }

    if (demoModeEnabled) {
      // Demo mode is on: skip the gate and drop straight into the shared demo account,
      // same as before, so the product still feels like a frictionless demo.
      try {
        const data = await api('/auth/demo', { method: 'POST' });
        setToken(data.token);
        ME = data.user;
        proceedAfterAuth();
        return;
      } catch (e) { /* fall through to the gate below */ }
    }
    // No valid session and (demo mode is off, or the demo call failed): show the auth gate.
    document.body.classList.add('auth-active');
  })();
})();
