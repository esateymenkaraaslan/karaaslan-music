const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const savedToken = localStorage.getItem('km_token') || sessionStorage.getItem('km_token') || '';
if (savedToken && !localStorage.getItem('km_token') && sessionStorage.getItem('km_remember') !== '0') localStorage.setItem('km_token', savedToken);
const state = { token: savedToken, user: null, socket: null, socketConfigured: false, socketConnectedBefore: false, room: null, rooms: [], source: 'youtube', queue: [], participants: [], youtube: null, ytReady: false, ytLoaded: false, localTrack: null, isDj: false, isHost: false, currentTab: 'queue', voiceStream: null, cameraStream: null, peers: new Map(), voiceOn: false, cameraOn: false, queueLocked: false, selectedTrack: null, repeat: 'off', shuffle: false, toastTimer: null };
const api = async (url, options = {}) => {
  const headers = { ...(options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `İstek tamamlanamadı (${response.status}).`); error.status = response.status; throw error; }
  return data;
};
function toast(message) { const box = $('#toast'); box.textContent = message; box.classList.add('show'); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => box.classList.remove('show'), 2700); }
function showModal(id) { $(`#${id}`).classList.remove('hidden'); }
function hideModals() { $$('.modal-backdrop').forEach(el => el.classList.add('hidden')); }
function escapeHtml(str = '') { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function initials(name = '?') { return [...name.trim()][0]?.toLocaleUpperCase('tr-TR') || '?'; }
function setTheme(theme) { const chosen = theme === 'light' ? 'light' : 'dark'; document.body.classList.toggle('light', chosen === 'light'); localStorage.setItem('km_theme', chosen); const label = chosen === 'dark' ? 'Açık görünüm' : 'Koyu görünüm'; $('.theme-toggle span:nth-child(2)').textContent = label; if (state.user && state.token) api('/api/me', { method: 'PATCH', body: JSON.stringify({ theme: chosen }) }).catch(() => {}); }
function setAuthHeader() {
  if (state.user) { $('#loginOpen').classList.add('hidden'); $('#registerOpen').classList.add('hidden'); $('#userMenu').classList.remove('hidden'); $('#headerUsername').textContent = state.user.username; $('#profileOpen').textContent = state.user.avatar ? '' : initials(state.user.username); if (state.user.avatar) $('#profileOpen').style.background = `center/cover url(${state.user.avatar})`; $('#adminOpen').classList.toggle('hidden', !state.user.isAdmin); }
  else { $('#loginOpen').classList.remove('hidden'); $('#registerOpen').classList.remove('hidden'); $('#userMenu').classList.add('hidden'); }
}
async function refreshRooms() {
  try { state.rooms = await api('/api/rooms'); } catch { state.rooms = []; }
  const open = state.rooms.filter(room => room.participants > 0);
  const grid = $('#roomsGrid');
  grid.innerHTML = `<article class="room-card create-card"><div class="create-plus">＋</div><h3>İlk odayı sen aç</h3><p>Arkadaşlarını davet et, dinleme sırasını birlikte oluşturun.</p><button class="button button-outline" id="cardCreate">Oda oluştur <span>↗</span></button></article>` + (open.length ? open.map((room, i) => `<article class="room-card sample-room"><div class="room-cover ${i % 2 ? 'cover-blue' : 'cover-sunset'}"><span class="cover-label">${escapeHtml(room.mood || 'BİRLİKTE DİNLE')}</span><span class="cover-disc">♫</span></div><div class="room-card-body"><div class="room-title-row"><div><span class="room-live"><i></i> CANLI</span><h3>${escapeHtml(room.name)}</h3></div><span class="room-lock">◉</span></div><div class="room-meta"><span>${room.participants} dinleyici</span><span class="meta-sep">·</span><span>${room.queueCount} parça sırada</span></div><button class="button button-join" data-join="${escapeHtml(room.roomId)}">Odaya katıl <span>→</span></button></div></article>`).join('') : `<div class="room-empty-message">Şu anda açık oda yok. İlk odayı sen aç.</div>`);
  $('#cardCreate')?.addEventListener('click', () => showModal('createModal'));
  $$('[data-join]').forEach(button => button.addEventListener('click', () => enterRoom(button.dataset.join)));
  renderRoomDirectory();
  const myRooms = state.room ? `<button class="side-room" data-side-room="${escapeHtml(state.room.roomId)}"><span class="room-side-dot">♫</span>${escapeHtml(state.room.name)}</button>` : '<p class="side-empty">Henüz bir odaya katılmadın.</p>';
  $('#myRooms').innerHTML = myRooms;
  $$('[data-side-room]').forEach(button => button.addEventListener('click', () => enterRoom(button.dataset.sideRoom)));
}
function modalAuth(mode) {
  const next = state.pendingRoom ? `/?room=${encodeURIComponent(state.pendingRoom)}` : `${location.pathname}${location.search}${location.hash}`;
  const target = new URL('/auth.html', location.origin); target.searchParams.set('mode', mode === 'register' ? 'register' : 'login'); target.searchParams.set('next', next); location.assign(target);
}
async function bootstrap() {
  setTheme(localStorage.getItem('km_theme') || 'dark');
  let retryAuth = false;
  if (state.token) { try { state.user = (await api('/api/me')).user; setTheme(state.user.theme || localStorage.getItem('km_theme')); } catch (error) { if (error.status === 401) { state.token = ''; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); } else { retryAuth = true; toast('Sunucu uyandırılıyor; hesabın yeniden bağlanacak.'); } } }
  setAuthHeader(); await refreshRooms(); if (state.user) { try { state.iceServers = (await api('/api/rtc/config')).iceServers; } catch {} connectSocket(); }
  if (retryAuth) setTimeout(bootstrap, 3500);
}
function requireUser(action) { if (!state.user) { modalAuth('login'); return false; } return true; }
function connectSocket() {
  if (!state.token) throw new Error('Odaya katılmak için önce giriş yap.');
  if (!state.socket) { state.socket = io({ auth: { token: state.token } }); state.socketConfigured = false; state.socket.on('connect_error', err => { if (state.token) toast(err.message || 'Canlı bağlantı kurulamadı.'); }); state.socket.on('auth:revoked', () => { leaveRoom(); state.socket?.disconnect(); state.socket = null; state.socketConfigured = false; state.token = ''; state.user = null; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); setAuthHeader(); toast('Hesap oturumu sona erdi. Yeniden giriş yap.'); }); }
  if (!state.socketConfigured) {
    state.socket.on('rooms:update', () => refreshRooms());
    state.socket.on('connect', () => { refreshRooms(); if (state.socketConnectedBefore && state.room) enterRoom(state.room.roomId); state.socketConnectedBefore = true; });
    state.socketConfigured = true;
  }
  return state.socket;
}
function renderRoomDirectory() {
  const open = state.rooms.filter(room => room.participants > 0);
  const grid = $('#directoryRoomsGrid'); if (!grid) return;
  grid.innerHTML = `<article class="room-card create-card"><div class="create-plus">＋</div><h3>Yeni oda oluştur</h3><p>Arkadaşlarını davet et, birlikte dinlemeye başlayın.</p><button class="button button-outline" data-directory-create>Oda oluştur <span>↗</span></button></article>` + (open.length ? open.map((room, i) => `<article class="room-card sample-room"><div class="room-cover ${i % 2 ? 'cover-blue' : 'cover-sunset'}"><span class="cover-label">${escapeHtml(room.mood || 'BİRLİKTE DİNLE')}</span><span class="cover-disc">♫</span></div><div class="room-card-body"><div class="room-title-row"><div><span class="room-live"><i></i> CANLI</span><h3>${escapeHtml(room.name)}</h3></div><span class="room-lock">◉</span></div><div class="room-meta"><span>${room.participants} dinleyici</span><span class="meta-sep">·</span><span>${room.queueCount} parça sırada</span></div><button class="button button-join" data-directory-join="${escapeHtml(room.roomId)}">Odaya katıl <span>→</span></button></div></article>`).join('') : '<div class="directory-empty">Şu anda açık oda yok. İlk odayı sen aç.</div>');
  $('[data-directory-create]')?.addEventListener('click', () => showModal('createModal'));
  $$('[data-directory-join]').forEach(button => button.addEventListener('click', () => enterRoom(button.dataset.directoryJoin)));
}
function activeView(name) { $('#homeView').classList.toggle('hidden', name !== 'home'); $('#roomsDirectoryView').classList.toggle('hidden', name !== 'rooms'); $('#roomView').classList.toggle('hidden', name !== 'room'); $('#profileView').classList.toggle('hidden', name !== 'profile'); $('#pageCrumb').textContent = name === 'room' ? 'Dinleme odası' : name === 'rooms' ? 'Dinleme odaları' : name === 'profile' ? 'Profilim' : 'Senin için'; $$('.main-nav .nav-item').forEach(item => item.classList.toggle('active', item.hash === (name === 'profile' ? '#profile' : name === 'rooms' || name === 'room' ? '#room' : '#home'))); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function enterRoom(roomId) {
  if (!requireUser()) return;
  try { connectSocket(); } catch (e) { toast(e.message); return; }
  state.socket.emit('room:join', { roomId }, response => {
    if (response?.error) { toast(response.error); return; }
    state.room = response.room; state.queue = response.room.queue || []; state.participants = response.room.participants || []; state.isHost = response.room.hostId === state.user.id; state.isDj = state.isHost || !!state.user.isAdmin; state.queueLocked = false; $('#chatMessages').innerHTML = '<div class="chat-welcome">Odaya hoş geldin. Sohbeti başlat!</div>'; $('#chatBadge').textContent = '0'; $('#searchResults').innerHTML = '<div class="search-hint">Şarkı adını yazıp sonuçları ara.</div>';
    $('#roomTitle').textContent = response.room.name || 'Arkadaşlarla dinleme'; $('#hostName').textContent = response.room.hostName || (state.isHost ? state.user.username : 'Oda sahibi'); $('#roomVisibility').textContent = response.room.visibility === 'private' ? 'Özel oda · davetli' : 'Herkese açık'; $('#roomCode').textContent = roomId; $('#participantList').dataset.owner = response.room.hostId; $('#queueCount').textContent = state.queue.length; $('#queueSubCount').textContent = `${state.queue.length} parça`; activeView('room'); renderQueue(); renderParticipants(); refreshRooms();
    state.socket.off('room:queue').on('room:queue', queue => { const currentId = state.queue[state.selectedTrack]?.id; state.queue = queue; state.selectedTrack = currentId ? queue.findIndex(t => t.id === currentId) : null; if (state.selectedTrack < 0) state.selectedTrack = null; renderQueue(); });
    state.socket.off('room:participants').on('room:participants', people => { state.participants = people; renderParticipants(); syncPeers(people); });
    state.socket.off('room:playback').on('room:playback', playback => applyPlayback(playback));
    state.socket.off('room:role').on('room:role', role => { state.isDj = !!role.isDj; renderParticipants(); });
    state.socket.off('room:chat').on('room:chat', msg => appendChat(msg));
    state.socket.off('room:details').on('room:details', details => { Object.assign(state.room, details); $('#roomTitle').textContent = state.room.name; $('#roomVisibility').textContent = state.room.visibility === 'private' ? 'Özel oda · davetli' : 'Herkese açık'; refreshRooms(); });
    state.socket.off('room:closed').on('room:closed', () => { toast('Oda sahibi odayı kapattı.'); leaveRoom(); });
    state.socket.off('room:kicked').on('room:kicked', () => { toast('Oda sahibi seni odadan çıkardı.'); leaveRoom(); });
    state.socket.off('room:host').on('room:host', host => { state.room.hostId = host.hostId; state.room.hostName = host.hostName; state.isHost = !!host.isHost; state.isDj = !!host.isDj || !!state.user?.isAdmin; $('#hostName').textContent = host.hostName; $('#participantList').dataset.owner = host.hostId; $('#deleteRoom').classList.toggle('hidden', !state.isHost && !state.user?.isAdmin); renderParticipants(); });
    state.socket.off('rtc:signal').on('rtc:signal', message => onSignal(message));
    state.socket.off('disconnect').on('disconnect', () => { if (state.room) toast('Bağlantı koptu, yeniden bağlanılıyor…'); });
    $('#deleteRoom').classList.toggle('hidden', !state.isHost && !state.user?.isAdmin);
    state.repeat = response.room.playback?.repeat || 'off'; state.shuffle = !!response.room.playback?.shuffle; updateRepeatButton(); $('#shuffleBtn').classList.toggle('active', state.shuffle);
    if (response.room.playback?.track && Number.isInteger(response.room.playback.index)) { state.selectedTrack = response.room.playback.index; const elapsed = response.room.playback.playing ? Math.max(0, (Date.now() - (response.room.playback.serverTime || Date.now())) / 1000) : 0; loadTrackMedia(response.room.playback.track, (response.room.playback.position || 0) + elapsed, response.room.playback.playing); }
  });
}
function renderParticipants() {
  const ownerId = $('#participantList').dataset.owner;
  $('#participantCount').textContent = `${state.participants.length} kişi`;
  $('#participantList').innerHTML = state.participants.map(p => `<div class="participant" data-person="${escapeHtml(p.id)}"><span class="participant-avatar">${p.avatar ? `<img src="${escapeHtml(p.avatar)}" alt="" />` : escapeHtml(initials(p.username))}</span><span>${escapeHtml(p.username)}${p.userId === state.user?.id ? ' (sen)' : ''}</span>${p.micOn ? '<span class="media-indicator">MIC</span>' : ''}${p.cameraOn ? '<span class="media-indicator">CAM</span>' : ''}${p.userId === ownerId ? '<span class="participant-role">SAHİP</span>' : p.isDj ? '<span class="participant-role">DJ</span>' : ''}${p.userId !== state.user?.id && (state.isHost || state.user?.isAdmin) ? `<button class="participant-more" data-person-menu="${escapeHtml(p.userId)}" title="Üye işlemleri">···</button>` : ''}</div>`).join('') || '<div class="side-empty">Katılımcılar yükleniyor.</div>';
  $$('[data-person-menu]').forEach(button => button.addEventListener('click', e => { e.stopPropagation(); document.querySelectorAll('.participant-menu').forEach(menu => menu.remove()); const person = state.participants.find(p => p.userId === button.dataset.personMenu); if (!person) return; const menu = document.createElement('div'); menu.className = 'participant-menu'; menu.innerHTML = `${person.isDj ? '<button data-action="revoke">DJ yetkisini kaldır</button>' : '<button data-action="dj">DJ yap</button>'}${state.isHost ? '<button data-action="host">Oda sahipliğini devret</button>' : ''}<button data-action="kick" class="danger-action">Üyeyi odadan çıkar</button>`; button.parentElement.append(menu); menu.onclick = event => { const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return; if (action === 'kick') { if (!confirm(`${person.username} odadan çıkarılsın mı?`)) return; state.socket.emit('room:kick', person.userId); } if (action === 'dj') state.socket.emit('room:dj:assign', person.userId); if (action === 'revoke') state.socket.emit('room:dj:revoke', person.userId); if (action === 'host') { if (!confirm(`Oda sahipliği ${person.username} kullanıcısına devredilsin mi?`)) return; state.socket.emit('room:host:transfer', person.userId); } menu.remove(); }; document.addEventListener('click', () => menu.remove(), { once: true }); }));
  $('#voiceParticipants').innerHTML = state.participants.map(p => `<span class="voice-person">${escapeHtml(p.username)}${p.micOn ? ' · MIC' : ''}${p.cameraOn ? ' · CAM' : ''}</span>`).join('');
}
function renderQueue() {
  $('#queueCount').textContent = state.queue.length; $('#queueSubCount').textContent = `${state.queue.length} parça`;
  if (!state.queue.length) { $('#queueList').innerHTML = '<div class="queue-empty"><span>♫</span><b>Sıra henüz boş</b><small>Yukarıdan şarkı ara veya bağlantı ekle.</small></div>'; return; }
  $('#queueList').innerHTML = state.queue.map((track, i) => `<div class="queue-item" data-index="${i}"><span class="queue-index">${String(i + 1).padStart(2, '0')}</span>${track.thumbnail ? `<img class="queue-thumb" src="${escapeHtml(track.thumbnail)}" alt="" />` : '<span class="queue-thumb" style="display:grid;place-items:center;color:#c6ec82">♫</span>'}<span class="queue-track"><b>${escapeHtml(track.title)}</b><span>${escapeHtml(track.artist || track.addedBy || '—')}</span></span><span class="queue-source">${track.source === 'youtube' ? 'YT' : 'LOCAL'}</span><button class="queue-remove" data-play-index="${i}" title="Çal">▶</button>${state.isDj ? `<button class="queue-remove" data-remove-track="${escapeHtml(track.id)}" title="Kuyruktan kaldır">×</button>` : ''}</div>`).join('');
  $$('[data-play-index]').forEach(button => button.addEventListener('click', () => playAt(Number(button.dataset.playIndex))));
  $$('[data-remove-track]').forEach(button => button.addEventListener('click', () => state.socket.emit('room:queue:remove', button.dataset.removeTrack)));
}
function addTrack(track) { if (!state.room || !state.socket) return toast('Önce bir odaya katıl.'); if (!state.isDj) return toast('Kuyruğa parça ekleme yetkin yok.'); state.socket.emit('room:queue:add', { ...track, videoId: track.id || track.videoId }); toast('Şarkı sıraya eklendi.'); }
async function searchTracks() {
  const q = $('#trackSearch').value.trim(); if (!q) return;
  $('#searchResults').innerHTML = '<div class="search-hint">Aranıyor…</div>';
  try {
    let items;
    if (state.source === 'youtube') items = (await api(`/api/youtube/search?q=${encodeURIComponent(q)}`)).items;
    else { const catalog = await api('/api/catalog'); items = catalog.filter(t => `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase())).map(t => ({ ...t, id: t._id, thumbnail: '' })); }
    $('#searchResults').innerHTML = items?.length ? items.map(item => `<div class="search-result"><img src="${escapeHtml(item.thumbnail || '')}" alt="" /><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.artist)}</span></div><button data-add-track="${escapeHtml(item.id)}" title="Kuyruğa ekle">＋</button></div>`).join('') : '<div class="search-hint">Sonuç bulunamadı.</div>';
    $$('[data-add-track]').forEach(button => button.addEventListener('click', () => { const item = items.find(x => x.id === button.dataset.addTrack); addTrack(state.source === 'youtube' ? { title: item.title, artist: item.artist, source: 'youtube', videoId: item.id, thumbnail: item.thumbnail } : { title: item.title, artist: item.artist, source: 'library', url: item.url }); }));
  } catch (e) { $('#searchResults').innerHTML = `<div class="search-hint">${escapeHtml(e.message)}</div>`; }
}
function parseYouTube(value) { try { const u = new URL(value); const host = u.hostname.replace(/^www\./, '').toLowerCase(); if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return ''; let id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v'); if (host !== 'youtu.be' && u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2]; return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : ''; } catch { return ''; } }
async function ytSearchId(videoId) {
  if (!state.ytReady) await new Promise(resolve => { const timeout = setTimeout(resolve, 5000); window.onYouTubeIframeAPIReady = () => { state.ytReady = true; clearTimeout(timeout); resolve(); }; const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; document.head.append(script); });
  return videoId;
}
async function playAt(index) {
  if (!state.isDj) return toast('Yalnızca oda sahibi veya DJ müziği yönetebilir.');
  if (index < 0 || index >= state.queue.length) return;
  const item = state.queue[index]; state.selectedTrack = index; state.localTrack = null; $('#playerPlaceholder').classList.add('hidden'); $('#localStage').classList.add('hidden'); $('#ytPlayer').classList.remove('hidden'); $('#nowTitle').textContent = item.title; $('#nowArtist').textContent = item.artist || '';
  await loadTrackMedia(item, 0, true);
  state.queueLocked = true; syncPlayback(); renderQueue();
}
async function loadTrackMedia(item, position = 0, shouldPlay = true) {
  state.activeTrackId = item.id;
  $('#playerPlaceholder').classList.add('hidden'); $('#localStage').classList.add('hidden'); $('#nowTitle').textContent = item.title || 'Şarkı'; $('#nowArtist').textContent = item.artist || '';
  if (item.source === 'youtube') {
    $('#ytPlayer').classList.remove('hidden'); await ytSearchId(item.videoId);
    if (!state.youtube) state.youtube = new YT.Player('ytPlayer', { height: '240', width: '100%', videoId: item.videoId, playerVars: { playsinline: 1, origin: location.origin, controls: 0, disablekb: 1, rel: 0 }, events: { onReady: () => { state.youtube.setVolume(Number($('#volumeRange').value)); state.youtube.seekTo(position, true); if (shouldPlay) state.youtube.playVideo(); }, onStateChange: e => { if (e.data === YT.PlayerState.ENDED) nextTrack(); }, onError: () => toast('Bu YouTube videosu oynatılamıyor.'), onAutoplayBlocked: () => toast('Tarayıcı oynatmayı engelledi; oynat düğmesine dokun.') } });
    else { state.youtube.loadVideoById(item.videoId, position); state.youtube.setVolume(Number($('#volumeRange').value)); if (!shouldPlay) state.youtube.pauseVideo(); }
  } else {
    state.youtube?.stopVideo?.(); $('#ytPlayer').classList.add('hidden'); $('#localStage').classList.remove('hidden'); $('#localNowTitle').textContent = item.title; $('#localNowArtist').textContent = item.artist || ''; const audio = $('#localAudio'); if (audio.src !== new URL(item.url, location.href).href) audio.src = item.url; audio.currentTime = position || 0; if (shouldPlay) await audio.play().catch(() => {}); else audio.pause();
  }
  $('#playBtn').textContent = shouldPlay ? 'Ⅱ' : '▶';
}
function playerPosition() { if (state.selectedTrack == null) return 0; const track = state.queue[state.selectedTrack]; return track?.source === 'youtube' ? (state.youtube?.getCurrentTime?.() || 0) : ($('#localAudio').currentTime || 0); }
function syncPlayback(playing = true) { if (!state.socket || !state.room || !state.isDj) return; state.socket.emit('room:playback', { playing, position: playerPosition(), index: state.selectedTrack, track: state.queue[state.selectedTrack], repeat: state.repeat, shuffle: state.shuffle }); $('#playBtn').textContent = playing ? 'Ⅱ' : '▶'; }
function togglePlayback() {
  if (!state.isDj) return toast('Oynatmayı oda DJ’i yönetiyor. Ses düzeyini kendin ayarlayabilirsin.');
  if (state.selectedTrack == null) return state.queue.length ? playAt(0) : toast('Önce kuyruğa bir şarkı ekle.');
  const track = state.queue[state.selectedTrack]; let playing;
  if (track.source === 'youtube') { const stateCode = state.youtube?.getPlayerState?.(); playing = stateCode !== YT.PlayerState.PLAYING; if (playing) state.youtube.playVideo(); else state.youtube.pauseVideo(); }
  else { playing = $('#localAudio').paused; if (playing) $('#localAudio').play(); else $('#localAudio').pause(); }
  $('#playBtn').textContent = playing ? 'Ⅱ' : '▶'; state.socket.emit('room:playback', { playing, position: playerPosition(), index: state.selectedTrack, track });
}
function applyPlayback(playback) {
  if (!playback || state.isDj) return;
  if (!playback.track && playback.index == null) { state.selectedTrack = null; $('#localAudio').pause(); state.youtube?.pauseVideo?.(); $('#playerPlaceholder').classList.remove('hidden'); $('#ytPlayer').classList.add('hidden'); $('#localStage').classList.add('hidden'); $('#playBtn').textContent = '▶'; $('#nowTitle').textContent = 'Henüz şarkı seçilmedi'; $('#nowArtist').textContent = 'Sıradan bir parça seçerek başlayın'; return; }
  const track = playback.track || state.queue[playback.index ?? state.selectedTrack]; if (!track) return;
  state.repeat = playback.repeat || state.repeat; state.shuffle = !!playback.shuffle; updateRepeatButton(); $('#shuffleBtn').classList.toggle('active', state.shuffle);
  const index = state.queue.findIndex(t => t.id === track.id); state.selectedTrack = index >= 0 ? index : (Number.isInteger(playback.index) ? playback.index : 0);
  if (!state.queue[state.selectedTrack] || state.queue[state.selectedTrack].id !== track.id) state.queue[state.selectedTrack] = track;
  const target = Math.max(0, Number(playback.position) || 0) + (playback.playing ? Math.max(0, (Date.now() - (playback.serverTime || Date.now())) / 1000) : 0);
  const current = state.queue[state.selectedTrack];
  const mediaMismatch = current.source === 'youtube' ? !state.youtube || state.activeTrackId !== current.id : $('#localAudio').src !== new URL(current.url || '/', location.href).href;
  if (mediaMismatch) { state.activeTrackId = current.id; loadTrackMedia(current, target, !!playback.playing); return; }
  if (current.source === 'youtube' && state.youtube) { if (Math.abs((state.youtube.getCurrentTime?.() || 0) - target) > 1.5) state.youtube.seekTo(target, true); playback.playing ? state.youtube.playVideo() : state.youtube.pauseVideo(); }
  else if (current.source === 'library') { const audio = $('#localAudio'); if (Math.abs(audio.currentTime - target) > 1.5) audio.currentTime = target; playback.playing ? audio.play().catch(() => {}) : audio.pause(); }
  $('#playBtn').textContent = playback.playing ? 'Ⅱ' : '▶'; renderQueue();
}
function updateRepeatButton() { const button = $('#repeatBtn'); if (!button) return; button.dataset.mode = state.repeat; button.title = `Tekrar: ${{ off: 'Kapalı', all: 'Tüm sıra', one: 'Tek şarkı' }[state.repeat]}`; button.classList.toggle('active', state.repeat !== 'off'); }
function nextTrack(manual = false) { if (!state.queue.length || !state.isDj) return; if (!manual && state.repeat === 'one') return playAt(state.selectedTrack ?? 0); if (!manual && state.repeat === 'off' && state.selectedTrack === state.queue.length - 1) { syncPlayback(false); return; } let next = ((state.selectedTrack ?? -1) + 1) % state.queue.length; if (state.shuffle && state.queue.length > 1) { const choices = state.queue.map((_, i) => i).filter(i => i !== state.selectedTrack); next = choices[Math.floor(Math.random() * choices.length)]; } playAt(next); }
function prevTrack() { if (!state.isDj) return; if (playerPosition() > 3) { if (state.queue[state.selectedTrack]?.source === 'youtube') state.youtube?.seekTo(0, true); else $('#localAudio').currentTime = 0; syncPlayback(true); return; } if (state.queue.length) playAt((state.selectedTrack - 1 + state.queue.length) % state.queue.length); }
function appendChat(msg) { const line = document.createElement('div'); line.className = 'chat-message'; line.innerHTML = `<span class="chat-avatar">${escapeHtml(initials(msg.username))}</span><div><b>${escapeHtml(msg.username)}</b><p>${escapeHtml(msg.text)}</p></div>`; $('#chatMessages').append(line); $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight; $('#chatBadge').textContent = Number($('#chatBadge').textContent || 0) + 1; }
function selectTab(name) { state.currentTab = name; $$('.room-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name)); $('#queuePanel').classList.toggle('hidden', name !== 'queue'); $('#chatPanel').classList.toggle('hidden', name !== 'chat'); $('#voicePanel').classList.toggle('hidden', name !== 'voice'); if (name === 'chat') $('#chatBadge').textContent = '0'; }
function createPeer(remoteId) {
  if (state.peers.has(remoteId) || !state.socket) return;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] }); state.peers.set(remoteId, pc);
  pc.pendingCandidates = [];
  pc.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender; pc.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
  if (state.voiceStream) pc.audioSender.replaceTrack(state.voiceStream.getAudioTracks()[0] || null).catch(() => {});
  if (state.cameraStream) pc.videoSender.replaceTrack(state.cameraStream.getVideoTracks()[0] || null).catch(() => {});
  pc.onicecandidate = e => { if (e.candidate) state.socket.emit('rtc:signal', { to: remoteId, signal: { candidate: e.candidate } }); };
  pc.ontrack = e => {
    if (e.track.kind === 'audio') { let audio = document.querySelector(`[data-remote-audio="${remoteId}"]`); if (!audio) { audio = document.createElement('audio'); audio.autoplay = true; audio.dataset.remoteAudio = remoteId; document.body.append(audio); } audio.srcObject = e.streams[0]; }
    if (e.track.kind === 'video') { let tile = document.querySelector(`[data-remote-tile="${remoteId}"]`); if (!tile) { tile = document.createElement('div'); tile.className = 'video-tile'; tile.dataset.remoteTile = remoteId; const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; const label = document.createElement('span'); label.textContent = state.participants.find(p => p.id === remoteId)?.username || 'Katılımcı'; tile.append(video, label); $('#videoGrid').append(tile); } tile.querySelector('video').srcObject = e.streams[0]; tile.classList.add('has-video'); e.track.onmute = () => tile.classList.remove('has-video'); e.track.onunmute = () => tile.classList.add('has-video'); }
  };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) { pc.close(); state.peers.delete(remoteId); document.querySelector(`[data-remote-tile="${remoteId}"]`)?.remove(); document.querySelector(`[data-remote-audio="${remoteId}"]`)?.remove(); } };
  if (state.socket.id < remoteId) pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => state.socket.emit('rtc:signal', { to: remoteId, signal: { description: pc.localDescription } })).catch(() => {});
}
function syncPeers(people) { if (!state.room) return; const otherIds = people.filter(p => p.id !== state.socket.id).map(p => p.id); otherIds.forEach(createPeer); for (const [id, peer] of state.peers) if (!otherIds.includes(id)) { peer.close(); state.peers.delete(id); document.querySelector(`[data-remote-audio="${id}"]`)?.remove(); document.querySelector(`[data-remote-tile="${id}"]`)?.remove(); } }
async function onSignal({ from, signal }) {
  if (!from || !signal) return; if (!state.peers.has(from)) createPeer(from); const pc = state.peers.get(from); if (!pc) return;
  try { if (signal.description) { await pc.setRemoteDescription(signal.description); for (const candidate of pc.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate); if (signal.description.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); state.socket.emit('rtc:signal', { to: from, signal: { description: pc.localDescription } }); } } else if (signal.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate); else pc.pendingCandidates.push(signal.candidate); } } catch (e) { console.warn('Medya bağlantısı kurulamadı', e); }
}
async function toggleMic() {
  if (!state.room) return toast('Önce odaya katıl.');
  try {
    if (state.voiceStream) { for (const pc of state.peers.values()) pc.audioSender?.replaceTrack(null).catch(() => {}); state.voiceStream.getTracks().forEach(t => t.stop()); state.voiceStream = null; state.voiceOn = false; $('#micToggle').textContent = 'Mikrofonu aç'; toast('Mikrofon kapatıldı.'); }
    else { state.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); state.voiceOn = true; const track = state.voiceStream.getAudioTracks()[0]; for (const pc of state.peers.values()) pc.audioSender?.replaceTrack(track).catch(() => {}); $('#micToggle').textContent = 'Mikrofonu kapat'; toast('Mikrofon açıldı.'); }
    state.socket.emit('room:media', { micOn: state.voiceOn, cameraOn: state.cameraOn }); renderParticipants();
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Mikrofon izni verilmedi.' : 'Mikrofona erişilemedi.'); }
}
async function toggleCamera() {
  if (!state.room) return toast('Önce odaya katıl.');
  try {
    if (state.cameraStream) { for (const pc of state.peers.values()) pc.videoSender?.replaceTrack(null).catch(() => {}); state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; state.cameraOn = false; $('#localVideo').srcObject = null; $('#localVideoTile').classList.remove('has-video'); $('#localVideoLabel').textContent = 'Kameranı açınca burada görünürsün'; $('#cameraToggle').textContent = 'Kamerayı aç'; toast('Kamera kapatıldı.'); }
    else { state.cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' } }); state.cameraOn = true; const track = state.cameraStream.getVideoTracks()[0]; for (const pc of state.peers.values()) pc.videoSender?.replaceTrack(track).catch(() => {}); $('#localVideo').srcObject = state.cameraStream; $('#localVideoTile').classList.add('has-video'); $('#localVideoLabel').textContent = state.user.username; $('#cameraToggle').textContent = 'Kamerayı kapat'; toast('Kamera açıldı.'); }
    state.socket.emit('room:media', { micOn: state.voiceOn, cameraOn: state.cameraOn }); renderParticipants();
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Kamera izni verilmedi.' : 'Kameraya erişilemedi.'); }
}
function leaveRoom() { state.voiceStream?.getTracks().forEach(t => t.stop()); state.cameraStream?.getTracks().forEach(t => t.stop()); for (const pc of state.peers.values()) pc.close(); state.peers.clear(); document.querySelectorAll('[data-remote-audio],[data-remote-tile]').forEach(x => x.remove()); $('#localVideo').srcObject = null; $('#localVideoTile').classList.remove('has-video'); state.voiceStream = null; state.cameraStream = null; state.voiceOn = false; state.cameraOn = false; if (state.socket && state.room) state.socket.emit('room:leave'); state.room = null; state.queue = []; state.participants = []; state.selectedTrack = null; $('#localAudio').pause(); state.youtube?.stopVideo?.(); activeView('home'); refreshRooms(); }

$('#loginOpen').onclick = () => modalAuth('login'); $('#registerOpen').onclick = () => modalAuth('register');
$('#logoutBtn').onclick = () => { leaveRoom(); state.socket?.disconnect(); state.socket = null; state.socketConfigured = false; state.token = ''; state.user = null; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); setAuthHeader(); toast('Oturum kapatıldı.'); };
$('#heroCreate').onclick = $('#cardCreate')?.onclick || (() => showModal('createModal')); $('#newRoomSide').onclick = $('#heroCreate').onclick; $('#bottomCreate').onclick = $('#heroCreate').onclick;
$('#heroJoin').onclick = () => showModal('joinModal'); $('#allRooms').onclick = () => { activeView('rooms'); refreshRooms(); }; $('#directoryRefresh').onclick = () => refreshRooms().then(() => toast('Odalar yenilendi.')); $('#directoryCreate').onclick = () => showModal('createModal');
$('#createRoomForm').onsubmit = async e => { e.preventDefault(); if (!requireUser()) return; const data = new FormData(e.currentTarget); try { const room = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: data.get('name'), mood: data.get('mood'), visibility: data.get('visibility') }) }); hideModals(); enterRoom(room.roomId); } catch (error) { $('#createError').textContent = error.message; } };
$('#joinForm').onsubmit = e => { e.preventDefault(); let roomId = new FormData(e.currentTarget).get('code').trim(); try { const parsed = new URL(roomId, location.href); roomId = parsed.searchParams.get('room') || parsed.pathname.split('/').filter(Boolean).at(-1) || roomId; } catch {} hideModals(); if (!state.user) { state.pendingRoom = roomId; return modalAuth('login'); } enterRoom(roomId); };
$('#backHome').onclick = () => { leaveRoom(); location.hash = '#home'; }; $('#profileBack').onclick = () => { activeView('home'); location.hash = '#home'; };
async function editCurrentRoom() { if (!state.room || (!state.isHost && !state.user?.isAdmin)) return toast('Odayı yalnızca sahibi düzenleyebilir.'); const name = prompt('Oda adı:', state.room.name || ''); if (name === null) return; const mood = prompt('Oda türü:', state.room.mood || 'Serbest dinleme'); if (mood === null) return; const visibility = confirm('Tamam: herkese açık yap. İptal: özel oda yap.') ? 'public' : 'private'; try { const updated = await api(`/api/rooms/${encodeURIComponent(state.room.roomId)}`, { method: 'PATCH', body: JSON.stringify({ name, mood, visibility }) }); Object.assign(state.room, updated); $('#roomTitle').textContent = state.room.name; $('#roomVisibility').textContent = visibility === 'private' ? 'Özel oda · davetli' : 'Herkese açık'; toast('Oda bilgileri güncellendi.'); } catch (e) { toast(e.message); } }
async function deleteRoom(roomId = state.room?.roomId) { if (!roomId || !confirm('Bu oda ve kuyruğu kalıcı olarak silinsin mi?')) return; try { await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' }); toast('Oda silindi.'); if (state.room?.roomId === roomId) leaveRoom(); refreshRooms(); } catch (e) { toast(e.message); } }
$('#roomMore').onclick = editCurrentRoom; $('#editRoom').onclick = editCurrentRoom; $('#deleteRoom').onclick = () => deleteRoom(); $('#inviteBtn').onclick = $('#roomInviteIcon').onclick = async () => { const url = `${location.origin}/?room=${state.room?.roomId || ''}`; try { await navigator.clipboard.writeText(url); toast('Davet bağlantısı kopyalandı.'); } catch { toast(`Oda kodu: ${state.room?.roomId}`); } }; $('#copyCode').onclick = () => navigator.clipboard.writeText(state.room?.roomId || '').then(() => toast('Oda kodu kopyalandı.')).catch(() => {});
$$('.room-tab').forEach(tab => tab.onclick = () => selectTab(tab.dataset.tab)); $('#chatForm').onsubmit = e => { e.preventDefault(); const text = $('#chatInput').value.trim(); if (text) { state.socket.emit('room:chat', { text }); $('#chatInput').value = ''; } };
$$('.source-option').forEach(button => button.onclick = () => { state.source = button.dataset.source; $$('.source-option').forEach(b => b.classList.toggle('active', b === button)); $('#trackSearch').placeholder = state.source === 'youtube' ? 'Şarkı veya sanatçı...' : 'Katalogda ara...'; $('#searchResults').innerHTML = '<div class="search-hint">Şarkı adını yazıp sonuçları ara.</div>'; });
$('#searchBtn').onclick = searchTracks; $('#trackSearch').onkeydown = e => { if (e.key === 'Enter') searchTracks(); };
$('#pasteLink').onclick = () => { const value = prompt('YouTube şarkı veya video bağlantısını yapıştır:'); if (!value) return; const id = parseYouTube(value); if (!id) return toast('Geçerli bir YouTube bağlantısı değil.'); const title = prompt('Şarkı adı (isteğe bağlı):') || 'YouTube parçası'; addTrack({ title, artist: 'YouTube', source: 'youtube', videoId: id }); };
$('#playBtn').onclick = togglePlayback; $('#nextBtn').onclick = () => nextTrack(true); $('#prevBtn').onclick = prevTrack; $('#shuffleBtn').onclick = () => { if (!state.isDj) return toast('Yalnızca DJ kuyruğu yönetebilir.'); state.shuffle = !state.shuffle; $('#shuffleBtn').classList.toggle('active', state.shuffle); syncPlayback(!!(state.queue[state.selectedTrack] && (state.queue[state.selectedTrack].source === 'youtube' ? state.youtube?.getPlayerState?.() === 1 : !$('#localAudio').paused))); toast(state.shuffle ? 'Karıştırma açıldı.' : 'Karıştırma kapatıldı.'); }; $('#repeatBtn').onclick = () => { if (!state.isDj) return toast('Yalnızca DJ tekrar ayarını değiştirebilir.'); state.repeat = ({ off: 'all', all: 'one', one: 'off' })[state.repeat]; updateRepeatButton(); syncPlayback(!!(state.queue[state.selectedTrack] && (state.queue[state.selectedTrack].source === 'youtube' ? state.youtube?.getPlayerState?.() === 1 : !$('#localAudio').paused))); }; $('#clearQueue').onclick = () => { if (!state.isDj) return toast('Yalnızca DJ kuyruğu yönetebilir.'); state.socket.emit('room:queue:replace', []); state.queue = []; state.selectedTrack = null; $('#playerPlaceholder').classList.remove('hidden'); $('#ytPlayer').classList.add('hidden'); $('#localStage').classList.add('hidden'); $('#localAudio').pause(); state.youtube?.stopVideo?.(); state.socket.emit('room:playback', { playing: false, position: 0, index: null, track: null }); renderQueue(); toast('Kuyruk temizlendi.'); }; $('#micToggle').onclick = toggleMic; $('#cameraToggle').onclick = toggleCamera;
$('#localAudio').ontimeupdate = () => { if (state.localTrack || state.queue[state.selectedTrack]?.source === 'library') { const a = $('#localAudio'); $('#currentTime').textContent = fmt(a.currentTime); $('#duration').textContent = fmt(a.duration); $('#seekBar').value = a.duration ? a.currentTime / a.duration * 100 : 0; } };
$('#localAudio').onended = () => nextTrack();
function fmt(value) { if (!Number.isFinite(value)) return '0:00'; return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
setInterval(() => {
  const track = state.queue[state.selectedTrack]; if (!track) return;
  const playing = track.source === 'youtube' ? state.youtube?.getPlayerState?.() === 1 : !$('#localAudio').paused;
  const position = playerPosition(); const duration = track.source === 'youtube' ? state.youtube?.getDuration?.() || 0 : $('#localAudio').duration || 0;
  $('#currentTime').textContent = fmt(position); $('#duration').textContent = fmt(duration); $('#seekBar').value = duration ? position / duration * 100 : 0;
  if (state.isDj && state.socket?.connected && Date.now() - (state.lastSync || 0) >= 3000) { state.lastSync = Date.now(); state.socket.emit('room:playback', { playing, position, index: state.selectedTrack, track, repeat: state.repeat, shuffle: state.shuffle }); }
}, 800);
$('#seekBar').onchange = e => { const track = state.queue[state.selectedTrack]; if (!state.isDj || !track) return; const value = Number(e.target.value) / 100; if (track.source === 'youtube') state.youtube?.seekTo(value * (state.youtube.getDuration() || 0), true); else $('#localAudio').currentTime = value * ($('#localAudio').duration || 0); const playing = track.source === 'youtube' ? state.youtube?.getPlayerState?.() === 1 : !$('#localAudio').paused; syncPlayback(playing); };
$('#volumeRange').oninput = e => { const volume = Number(e.target.value) / 100; $('#localAudio').volume = volume; state.youtube?.setVolume?.(volume * 100); };
$('#volumeRange').value = localStorage.getItem('km_volume') || '75'; $('#localAudio').volume = Number($('#volumeRange').value) / 100; $('#volumeRange').addEventListener('change', e => localStorage.setItem('km_volume', e.target.value)); $('#volumeBtn').onclick = () => { if (matchMedia('(max-width: 570px)').matches) { document.body.classList.toggle('volume-open'); $('#volumeBtn').setAttribute('aria-pressed', document.body.classList.contains('volume-open')); } else { const range = $('#volumeRange'); range.value = Number(range.value) > 0 ? '0' : (localStorage.getItem('km_volume') || '75'); range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change')); } };
$('#themeToggle').onclick = $('#headerTheme').onclick = () => setTheme(document.body.classList.contains('light') ? 'dark' : 'light');
$('#profileOpen').onclick = () => { if (!state.user) return; $('#profileName').textContent = state.user.username; $('#profileUsername').textContent = state.user.username; $('#profileEmail').textContent = state.user.email; $('#profileBio').value = state.user.bio || ''; $('#profileAvatar').textContent = initials(state.user.username); $('.profile-details > div:last-child b').textContent = state.user.isAdmin ? 'Yönetici' : 'Dinleyici'; activeView('profile'); };
$('#profileTheme').onclick = () => setTheme(document.body.classList.contains('light') ? 'dark' : 'light'); $('#saveProfile').onclick = async () => { try { const data = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ bio: $('#profileBio').value, theme: document.body.classList.contains('light') ? 'light' : 'dark' }) }); state.user = data.user; toast('Profil kaydedildi.'); } catch (e) { toast(e.message); } };
$('#avatarUpload').onchange = async e => { const file = e.target.files[0]; if (!file) return; if (file.size > 2e6) return toast('Profil resmi en fazla 2 MB olabilir.'); try { const result = await api('/api/me/avatar', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); state.user.avatar = result.avatar; $('#profileAvatar').style.background = `center/cover url(${result.avatar})`; $('#profileOpen').style.background = `center/cover url(${result.avatar})`; $('#profileAvatar').textContent = ''; toast('Profil resmi kaydedildi.'); } catch (error) { toast(error.message); } };
$('#trackUpload').onchange = e => { const file = e.target.files[0]; if (file) $('#uploadTitle').value = file.name.replace(/\.[^.]+$/, ''); };
$('#uploadTrack').onclick = async () => { const file = $('#trackUpload').files[0]; if (!file) return $('#adminMessage').textContent = 'Önce ses dosyası seçin.'; try { await api(`/api/admin/tracks?title=${encodeURIComponent($('#uploadTitle').value)}&artist=${encodeURIComponent($('#uploadArtist').value)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); $('#adminMessage').textContent = 'Şarkı kataloğa eklendi.'; $('#trackUpload').value = ''; toast('Şarkı yüklendi.'); loadAdminTracks(); } catch (e) { $('#adminMessage').textContent = e.message; } };
function selectAdminView(view) { ['rooms', 'users', 'catalog'].forEach(name => { $(`#admin${name[0].toUpperCase()}${name.slice(1)}Pane`).classList.toggle('hidden', name !== view); $(`[data-admin-view="${name}"]`).classList.toggle('active', name === view); }); if (view === 'users') loadAdminUsers(); if (view === 'catalog') loadAdminTracks(); }
async function loadAdminUsers() { try { const users = await api('/api/admin/users'); $('#adminUsers').innerHTML = users.length ? users.map(user => `<article class="admin-user-row"><span class="admin-user-avatar">${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" />` : escapeHtml(initials(user.username))}</span><div class="admin-user-info"><b>${escapeHtml(user.username)}${user.id === state.user.id ? ' · sen' : ''}</b><span>${escapeHtml(user.email || 'E-posta yok')}</span><small>${user.isAdmin ? 'Yönetici' : 'Üye'} · ${user.createdAt ? new Date(user.createdAt).toLocaleDateString('tr-TR') : 'Tarih yok'}</small></div><button class="button button-outline" data-edit-user="${escapeHtml(user.id)}">Düzenle</button>${user.id !== state.user.id ? `<button class="button button-danger" data-delete-user="${escapeHtml(user.id)}">Sil</button>` : ''}</article>`).join('') : '<p class="admin-empty">Henüz üye yok.</p>'; $$('[data-edit-user]').forEach(button => button.onclick = () => editAdminUser(users.find(user => user.id === button.dataset.editUser))); $$('[data-delete-user]').forEach(button => button.onclick = () => deleteAdminUser(button.dataset.deleteUser)); } catch (error) { $('#adminUsers').textContent = error.message; } }
function editAdminUser(user) { if (!user) return; const form = $('#adminUserForm'); form.elements.id.value = user.id; form.elements.username.value = user.username || ''; form.elements.email.value = user.email || ''; form.elements.bio.value = user.bio || ''; form.elements.password.value = ''; form.elements.isAdmin.checked = !!user.isAdmin; $('#adminUserError').textContent = ''; showModal('adminUserModal'); }
async function deleteAdminUser(id) { if (!confirm('Bu üye hesabı ve açık oturumları silinsin mi? Bu işlem geri alınamaz.')) return; try { await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Üye hesabı silindi.'); loadAdminUsers(); } catch (error) { toast(error.message); } }
async function loadAdminTracks() { try { const tracks = await api('/api/admin/tracks'); $('#adminTracks').innerHTML = tracks.length ? tracks.map(track => `<article class="admin-track-row"><span class="admin-track-icon">♫</span><div><b>${escapeHtml(track.title)}</b><small>${escapeHtml(track.artist || 'Bilinmeyen sanatçı')}</small></div><button class="button button-danger" data-delete-track="${escapeHtml(track.id)}">Sil</button></article>`).join('') : '<p class="admin-empty">Katalog henüz boş.</p>'; $$('[data-delete-track]').forEach(button => button.onclick = async () => { if (!confirm('Bu şarkıyı katalogdan ve kuyruklardan silmek istiyor musun?')) return; try { await api(`/api/admin/tracks/${encodeURIComponent(button.dataset.deleteTrack)}`, { method: 'DELETE' }); toast('Şarkı kaldırıldı.'); loadAdminTracks(); } catch (error) { toast(error.message); } }); } catch (error) { $('#adminTracks').textContent = error.message; } }
async function openAdminPanel() { showModal('adminModal'); selectAdminView('rooms'); try { const data = await api('/api/admin/overview'); $('#adminOverview').innerHTML = [['Üye', data.users], ['Katalog', data.tracks], ['Oda', data.activeRooms]].map(([label, value]) => `<div class="admin-stat"><span>${label}</span><b>${value}</b></div>`).join(''); $('#adminRooms').innerHTML = data.recentRooms?.length ? data.recentRooms.map(room => `<article class="admin-room"><div><b>${escapeHtml(room.name || room.roomId)}</b><span>${room.participants} kişi · ${room.queue.length} parça sırada · ${room.visibility === 'private' ? 'Özel' : 'Açık'}</span><small>${room.queue.slice(0, 3).map(t => escapeHtml(t.title)).join(' · ') || 'Kuyruk boş'}</small></div><button class="button button-outline" data-admin-room="${escapeHtml(room.roomId)}">Odayı aç</button><button class="button button-danger" data-admin-delete="${escapeHtml(room.roomId)}">Sil</button></article>`).join('') : '<div class="admin-empty">Henüz oda oluşturulmadı.</div>'; $$('[data-admin-room]').forEach(button => button.onclick = () => { hideModals(); enterRoom(button.dataset.adminRoom); }); $$('[data-admin-delete]').forEach(button => button.onclick = () => deleteRoom(button.dataset.adminDelete)); } catch (e) { $('#adminRooms').textContent = e.message; } }
$('#adminUserForm').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value; const isSelf = id === state.user?.id; const body = { username: form.elements.username.value, email: form.elements.email.value, bio: form.elements.bio.value, isAdmin: form.elements.isAdmin.checked, ...(form.elements.password.value ? { password: form.elements.password.value } : {}) }; $('#adminUserError').textContent = ''; try { const result = await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); if (isSelf && body.password) { leaveRoom(); state.socket?.disconnect(); state.socket = null; state.token = ''; state.user = null; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); setAuthHeader(); hideModals(); toast('Şifren değişti. Yeni şifreyle tekrar giriş yap.'); setTimeout(() => modalAuth('login'), 900); return; } if (isSelf) { state.user = result.user; setAuthHeader(); } hideModals(); if (state.user?.isAdmin) { showModal('adminModal'); await loadAdminUsers(); } toast('Hesap bilgileri güncellendi.'); } catch (error) { $('#adminUserError').textContent = error.message; } };
$$('[data-admin-view]').forEach(button => button.onclick = () => selectAdminView(button.dataset.adminView));
$('#userMenu').addEventListener('contextmenu', e => { if (!state.user?.isAdmin) return; e.preventDefault(); openAdminPanel(); });
$('#adminOpen').onclick = openAdminPanel;
$('#profileOpen').addEventListener('contextmenu', e => { if (state.user?.isAdmin) { e.preventDefault(); openAdminPanel(); } });
$$('[data-close]').forEach(button => button.onclick = hideModals); $$('.modal-backdrop').forEach(backdrop => backdrop.onclick = e => { if (e.target === backdrop) hideModals(); }); document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModals(); });
document.addEventListener('click', e => { const sample = e.target.closest('.sampleJoin'); if (sample) { const room = state.rooms.find(r => r.participants > 0); if (room) enterRoom(room.roomId); else toast('Açık oda bulunamadı. Yeni oda oluştur.'); } });
window.addEventListener('storage', async event => {
  if (event.key !== 'km_token') return;
  if (!event.newValue) { if (state.room) leaveRoom(); state.socket?.disconnect(); state.socket = null; state.socketConfigured = false; state.token = ''; state.user = null; setAuthHeader(); toast('Diğer sekmede oturum kapatıldı.'); return; }
  state.token = event.newValue;
  try { state.user = (await api('/api/me')).user; setAuthHeader(); try { state.iceServers = (await api('/api/rtc/config')).iceServers; } catch {} connectSocket(); toast('Oturum bu sekmede de açıldı.'); }
  catch { state.token = ''; state.user = null; localStorage.removeItem('km_token'); setAuthHeader(); }
});
function routeHash() {
  const route = location.hash.split('/')[0];
  if (route === '#room') { activeView('rooms'); refreshRooms(); }
  else if (route === '#profile') { if (state.user) $('#profileOpen').click(); else { state.pendingView = 'profile'; modalAuth('login'); } }
  else { activeView('home'); }
}
$$('.main-nav .nav-item').forEach(item => item.addEventListener('click', () => { if (location.hash === item.hash) routeHash(); }));
window.addEventListener('hashchange', routeHash);
const queryRoom = new URLSearchParams(location.search).get('room');
bootstrap().then(() => { if (queryRoom && state.user) enterRoom(queryRoom); else if (queryRoom) { state.pendingRoom = queryRoom; modalAuth('login'); } else routeHash(); });
