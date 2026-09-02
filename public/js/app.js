(() => {
  'use strict';

  const API = ''; // same-origin; e.g. set to 'https://yourdomain.com' if hosted separately
  let TOKEN = localStorage.getItem('matchify_token') || null;
  let ME = null;
  let profileQueue = [];
  let matchesCache = [];
  let activeMatchId = null;
  let chatPollTimer = null;
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
  }
  $all('.navitem[data-nav], .bn-item[data-nav]').forEach(item => {
    item.addEventListener('click', () => setActiveNav(item.dataset.nav));
  });

  // ---------- Enter app ----------
  async function enterApp() {
    document.body.classList.remove('auth-active');
    setActiveNav('discover');
    connectSocket();
  }

  // ---------- Countries dropdown ----------
  function populateCountrySelects() {
    const list = window.MATCHIFY_COUNTRIES || [];
    const opts = '<option value="">Select country</option>' + list.map(c => `<option value="${c}">${c}</option>`).join('');
    const regSel = document.getElementById('regCountry');
    const pfSel = document.getElementById('pfCountry');
    if (regSel) regSel.innerHTML = opts;
    if (pfSel) pfSel.innerHTML = opts;
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
      const data = await api('/users/discover?limit=20');
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
        const more = await api('/users/discover?limit=10');
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
            <div class="row1"><span class="nm">${escapeHtml(m.user.name)}</span></div>
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
            <div class="row1"><span class="nm">${escapeHtml(m.user.name)}</span></div>
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
    $('#chatEmpty').style.display = 'none';
    $('#chatConv').style.display = 'flex';
    $('#chatHeadAvatar').style.backgroundImage = `url('${photoOf(match.user)}')`;
    $('#chatHeadName').textContent = match.user.name;

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

  // ---------- Profile ----------
  function loadProfileForm() {
    if (!ME) return;
    $('#pfName').value = ME.name || '';
    $('#pfAge').value = ME.age || '';
    $('#pfJob').value = ME.job || '';
    $('#pfLocation').value = ME.location || '';
    $('#pfCountry').value = ME.country || '';
    $('#pfBio').value = ME.bio || '';
    $('#pfInterests').value = (ME.interests || []).join(', ');
    $('#pfPhoto').value = (ME.photos && ME.photos[0]) || '';
    const preview = $('#profilePhotoPreview');
    if (ME.photos && ME.photos[0]) {
      preview.style.backgroundImage = `url('${ME.photos[0]}')`;
      preview.textContent = '';
    } else {
      preview.style.backgroundImage = '';
      preview.textContent = '👤';
    }
  }
  $('#pfPhoto').addEventListener('input', () => {
    const url = $('#pfPhoto').value.trim();
    const preview = $('#profilePhotoPreview');
    preview.style.backgroundImage = url ? `url('${url}')` : '';
    preview.textContent = url ? '' : '👤';
  });

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
      photos: $('#pfPhoto').value.trim() ? [$('#pfPhoto').value.trim()] : [],
    };
    try {
      const data = await api('/users/me', { method: 'PUT', body: JSON.stringify(body) });
      ME = data.user;
      toast('Profile updated ✓');
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Premium / subscription (mock payment) ----------
  function loadPremiumView() {
    const currentPlan = (ME && ME.plan) || 'free';
    $all('.plan-btn').forEach(btn => {
      const plan = btn.dataset.plan;
      if (plan === currentPlan) {
        btn.textContent = 'Current plan';
        btn.classList.add('ghost');
        btn.disabled = true;
      } else {
        btn.textContent = plan === 'free' ? 'Downgrade' : 'Subscribe';
        btn.classList.remove('ghost');
        btn.disabled = false;
      }
    });
  }
  $all('.plan-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const plan = btn.dataset.plan;
      try {
        const data = await api('/users/subscribe', { method: 'POST', body: JSON.stringify({ plan }) });
        ME = data.user;
        toast(plan === 'free' ? 'Back on the Free plan' : `You're on the ${plan} plan now (mock payment) ✓`);
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

  // ---------- Boot ----------
  // No sign-in flow: every visitor gets the same shared demo account so the
  // rest of the app (matches, swipes, chat, calls) has a consistent user.
  (async function boot() {
    try {
      if (TOKEN) {
        ME = (await api('/auth/me')).user;
      } else {
        const data = await api('/auth/demo', { method: 'POST' });
        setToken(data.token);
        ME = data.user;
      }
      enterApp();
    } catch (e) {
      try {
        setToken(null);
        const data = await api('/auth/demo', { method: 'POST' });
        setToken(data.token);
        ME = data.user;
        enterApp();
      } catch (e2) {
        toast('Could not start session: ' + e2.message);
      }
    }
  })();
})();
