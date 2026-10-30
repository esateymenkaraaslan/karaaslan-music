const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const savedToken = localStorage.getItem('km_token') || sessionStorage.getItem('km_token') || '';
if (savedToken && !localStorage.getItem('km_token') && sessionStorage.getItem('km_remember') !== '0') localStorage.setItem('km_token', savedToken);
const ACTIVE_ROOM_KEY = 'km_active_room';
const state = { token: savedToken, user: null, myRooms: [], notifications: [], playlists: [], friends: { friends: [], incoming: [], outgoing: [] }, communityMembers: [], communityTotal: 0, communityPage: 0, communityPages: 1, communityMessages: [], dmMessages: [], activeDmFriend: null, communityTab: 'members', chatMessages: [], playlistRequest: 0, roomRefreshRequest: 0, room: null, roomEpoch: 0, socket: null, socketConfigured: false, socketConnectedBefore: false, source: 'youtube', queue: [], participants: [], catalogSearchRequest: 0, currentTab: 'queue', voiceStream: null, cameraStream: null, peers: new Map(), remoteStreams: new Map(), voiceOn: false, cameraOn: false, playbackNeedsGesture: false, lastPlayback: null, selectedTrack: null, repeat: 'off', shuffle: false, localMusicMuted: localStorage.getItem('km_music_muted') === '1', toastTimer: null };
const roomPlayer = new RoomPlayer({
  getRoom: () => state.room,
  getQueue: () => state.queue,
  getIndex: () => state.selectedTrack,
  getRepeat: () => state.repeat,
  getShuffle: () => state.shuffle,
  canControl: () => state.isDj,
  onSnapshot: playback => {
    state.lastPlayback = playback;
    state.repeat = playback.repeat || 'off';
    state.shuffle = !!playback.shuffle;
    const track = playback.track;
    if (track) {
      let index = state.queue.findIndex(item => item.id === track.id);
      if (index < 0 && Number.isInteger(playback.index)) { index = Math.min(playback.index, state.queue.length); state.queue.splice(index, 0, track); }
      state.selectedTrack = index < 0 ? null : index;
      $('#nowTitle').textContent = track.title || 'Şarkı';
      $('#nowArtist').textContent = track.artist || '';
    } else {
      state.selectedTrack = null;
    }
    updateRepeatButton();
    $('#shuffleBtn').classList.toggle('active', state.shuffle);
    renderQueue();
  },
  onGesture: required => {
    state.playbackNeedsGesture = required;
    $('#playbackGestureNotice')?.classList.toggle('hidden', !required);
    renderPlaybackPermissions();
    if (required) toast('Tarayıcı otomatik oynatmayı durdurdu. Bu cihazda dinlemek için düğmeye dokun.');
  },
  onError: message => toast(message),
  onEnded: () => nextTrack()
});
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
function communityAvatarMarkup(name, avatar = '') { return `<span class="community-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" data-avatar-name="${escapeHtml(name)}" alt="" />` : escapeHtml(initials(name))}</span>`; }
function bindCommunityAvatarFallbacks(root) { $$('img[data-avatar-name]', root).forEach(image => { image.onerror = () => { image.parentElement.textContent = initials(image.dataset.avatarName); }; }); }
function setAvatar(element, avatar, name) { if (!element) return; element.textContent = avatar ? '' : initials(name); element.style.background = ''; if (avatar) { element.style.backgroundImage = `url("${avatar}")`; element.style.backgroundSize = 'cover'; element.style.backgroundPosition = 'center'; } element.classList.toggle('has-avatar', !!avatar); }
function setAuthHeader() {
  if (state.user) { $('#loginOpen').classList.add('hidden'); $('#registerOpen').classList.add('hidden'); $('#userMenu').classList.remove('hidden'); $('#headerUsername').textContent = state.user.username; setAvatar($('#profileOpen'), state.user.avatar, state.user.username); $('#adminOpen').classList.toggle('hidden', !state.user.isAdmin); }
  else { $('#loginOpen').classList.remove('hidden'); $('#registerOpen').classList.remove('hidden'); $('#userMenu').classList.add('hidden'); }
}
function renderRoomsSnapshot(rooms) {
  const favoriteRooms = state.user?.favoriteRooms || [];
  state.rooms = (rooms || []).map(room => ({ ...room, favorite: favoriteRooms.includes(room.roomId) }));
  const visibleRooms = state.rooms;
  if (!$('#homeView').classList.contains('hidden')) {
    const open = visibleRooms.filter(room => room.participants > 0).slice(0, 6);
    const grid = $('#roomsGrid');
    grid.innerHTML = `<article class="room-card create-card"><div class="create-plus">＋</div><h3>İlk odayı sen aç</h3><p>Arkadaşlarını davet et, dinleme sırasını birlikte oluşturun.</p><button class="button button-outline" id="cardCreate">Oda oluştur <span>↗</span></button></article>` + (open.length ? open.map((room, i) => `<article class="room-card sample-room"><div class="room-cover ${i % 2 ? 'cover-blue' : 'cover-sunset'}"><span class="cover-label">${escapeHtml(room.mood || 'BİRLİKTE DİNLE')}</span><span class="cover-disc">♫</span></div><div class="room-card-body"><div class="room-title-row"><div><span class="room-live"><i></i> CANLI</span><h3>${escapeHtml(room.name)}</h3></div><span class="room-lock">◉</span></div><div class="room-meta"><span>${room.participants} dinleyici</span><span class="meta-sep">·</span><span>${room.queueCount} parça sırada</span></div><button class="button button-join" data-join="${escapeHtml(room.roomId)}">Odaya katıl <span>→</span></button></div></article>`).join('') : `<div class="room-empty-message">Şu anda açık oda yok. İlk odayı sen aç.</div>`);
    $('#cardCreate')?.addEventListener('click', () => showModal('createModal'));
    $$('[data-join]').forEach(button => button.addEventListener('click', () => enterRoom(button.dataset.join)));
  }
  if (!$('#roomsDirectoryView').classList.contains('hidden')) renderRoomDirectory();
}
function renderMyRooms() {
  const myRooms = state.myRooms.length ? state.myRooms.slice(0, 8).map(room => `<button class="side-room" data-side-room="${escapeHtml(room.roomId)}"><span class="room-side-dot">♫</span>${escapeHtml(room.name)}${room.favorite ? ' ★' : ''}</button>`).join('') : '<p class="side-empty">Son odaların burada görünür.</p>';
  $('#myRooms').innerHTML = myRooms;
  $$('[data-side-room]').forEach(button => button.addEventListener('click', () => enterRoom(button.dataset.sideRoom)));
}
function applyRoomsSnapshot(rooms) {
  ++state.roomRefreshRequest;
  renderRoomsSnapshot(rooms);
}
async function refreshRooms({ includeMine = true } = {}) {
  const requestId = ++state.roomRefreshRequest;
  let rooms = [];
  try { rooms = await api('/api/rooms'); } catch {}
  if (requestId !== state.roomRefreshRequest) return;
  renderRoomsSnapshot(rooms);
  if (!includeMine) return;
  if (state.user) { try { state.myRooms = await api('/api/me/rooms'); } catch { state.myRooms = []; } } else state.myRooms = [];
  if (requestId !== state.roomRefreshRequest) return;
  renderMyRooms();
}
let roomsRefreshTimer;
function scheduleRoomsRefresh() { clearTimeout(roomsRefreshTimer); roomsRefreshTimer = setTimeout(() => refreshRooms(), 450); }
let profileActivityRefreshTimer;
function scheduleProfileActivityRefresh() {
  if ($('#profileView').classList.contains('hidden')) return;
  clearTimeout(profileActivityRefreshTimer);
  profileActivityRefreshTimer = setTimeout(() => loadProfileActivity(), 250);
}
function modalAuth(mode) {
  const next = state.pendingRoom ? `/?room=${encodeURIComponent(state.pendingRoom)}` : `${location.pathname}${location.search}${location.hash}`;
  const target = new URL('/auth.html', location.origin); target.searchParams.set('mode', mode === 'register' ? 'register' : 'login'); target.searchParams.set('next', next); location.assign(target);
}
async function bootstrap() {
  let retryAuth = false;
  if (state.token) { try { state.user = (await api('/api/me')).user; } catch (error) { if (error.status === 401) { state.token = ''; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); } else { retryAuth = true; toast('Sunucu uyandırılıyor; hesabın yeniden bağlanacak.'); } } }
  setAuthHeader(); if (state.user) { connectSocket(); loadNotifications(); api('/api/rtc/config').then(rtc => { state.iceServers = rtc.iceServers; state.turnConfigured = !!rtc.turnConfigured; }).catch(() => {}); } refreshRooms();
  if (retryAuth) setTimeout(bootstrap, 3500);
}
function requireUser(action) { if (!state.user) { modalAuth('login'); return false; } return true; }
function connectSocket() {
  if (!state.token) throw new Error('Odaya katılmak için önce giriş yap.');
  if (!state.socket) { state.socket = io({ auth: { token: state.token } }); state.socketConfigured = false; state.socket.on('connect_error', err => { if (state.token) toast(err.message || 'Canlı bağlantı kurulamadı.'); }); state.socket.on('auth:revoked', () => { leaveRoom(); state.socket?.disconnect(); state.socket = null; state.socketConfigured = false; state.token = ''; state.user = null; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); setAuthHeader(); toast('Hesap oturumu sona erdi. Yeniden giriş yap.'); }); }
  roomPlayer.bind(state.socket);
  if (!state.socketConfigured) {
    state.socket.on('rooms:update', rooms => Array.isArray(rooms) ? applyRoomsSnapshot(rooms) : scheduleRoomsRefresh());
    state.socket.on('catalog:update', () => {
      if (state.source === 'library' && $('#trackSearch').value.trim()) searchTracks();
      if (state.user?.isAdmin && !$('#adminCatalogPane').classList.contains('hidden')) loadAdminTracks();
    });
    state.socket.on('notification:new', notification => { if (!notification?.id || !state.notifications.some(item => item.id === notification.id)) state.notifications.unshift(notification); renderNotifications(); if (notification?.type?.startsWith('friend-')) { if (!$('#profileView').classList.contains('hidden')) loadFriends(); if (!$('#communityView').classList.contains('hidden')) { loadFriends(); loadCommunityMembers(); } } toast(notification.title); });
    state.socket.on('community:presence', () => { if (!$('#communityView').classList.contains('hidden')) scheduleCommunityMembers(); });
    state.socket.on('community:chat:message', message => appendCommunityMessage(message));
    state.socket.on('dm:message', event => { if (event?.friendId !== state.activeDmFriend?.id) return; appendDirectMessage(event.message); });
    state.socket.on('user:history', scheduleProfileActivityRefresh);
    state.socket.on('user:stats', scheduleProfileActivityRefresh);
    state.socket.on('room:session:replaced', event => {
      if (event?.roomId !== state.room?.roomId) return;
      leaveRoom({ notifyServer: false });
      toast('Bu hesap odada başka bir sekmede açıldığı için bu oturum odadan çıkarıldı.');
    });
    state.socket.on('connect', () => {
      refreshRooms({ includeMine: false });
      if (state.socketConnectedBefore) {
        loadNotifications();
        if (state.room) enterRoom(state.room.roomId, { forceRejoin: true });
        if (!$('#profileView').classList.contains('hidden')) scheduleProfileActivityRefresh();
        if (state.communityTab === 'general' && !$('#communityView').classList.contains('hidden')) joinCommunityChat();
        if (state.activeDmFriend && !$('#communityView').classList.contains('hidden')) joinDirectChat(state.activeDmFriend);
      }
      state.socketConnectedBefore = true;
    });
    state.socketConfigured = true;
  }
  return state.socket;
}
function renderRoomDirectory() {
  const open = state.rooms;
  const grid = $('#directoryRoomsGrid'); if (!grid) return;
  const q = ($('#roomFilterQuery')?.value || '').trim().toLocaleLowerCase('tr-TR'); const mood = $('#roomFilterMood')?.value || ''; const minListeners = Number($('#roomMinListeners')?.value || 0); const sort = $('#roomSort')?.value || 'recent';
  let filtered = open.filter(room => (!q || `${room.name} ${room.hostName} ${room.mood} ${room.nowPlaying || ''}`.toLocaleLowerCase('tr-TR').includes(q)) && (!mood || room.mood === mood) && room.participants >= minListeners);
  if (sort === 'listeners') filtered.sort((a, b) => b.participants - a.participants); else if (sort === 'tracks') filtered.sort((a, b) => b.queueCount - a.queueCount);
  grid.innerHTML = `<article class="room-card create-card"><div class="create-plus">＋</div><h3>Yeni oda oluştur</h3><p>Arkadaşlarını davet et, birlikte dinlemeye başlayın.</p><button class="button button-outline" data-directory-create>Oda oluştur <span>↗</span></button></article>` + (filtered.length ? filtered.map((room, i) => `<article class="room-card sample-room"><div class="room-cover ${i % 2 ? 'cover-blue' : 'cover-sunset'}"><span class="cover-label">${escapeHtml(room.mood || 'BİRLİKTE DİNLE')}</span><span class="cover-disc">♫</span><button class="room-favorite ${room.favorite ? 'active' : ''}" data-favorite-room="${escapeHtml(room.roomId)}" aria-label="Favori oda">${room.favorite ? '★' : '☆'}</button></div><div class="room-card-body"><div class="room-title-row"><div><span class="room-live"><i></i> ${room.participants ? 'CANLI' : 'AÇIK'}</span><h3>${escapeHtml(room.name)}</h3></div><span class="room-lock">◉</span></div><div class="room-meta"><span>${room.participants} dinleyici</span><span class="meta-sep">·</span><span>${room.queueCount} parça sırada</span></div>${room.nowPlaying ? `<p class="room-now-playing">Şimdi: ${escapeHtml(room.nowPlaying)}</p>` : '<p class="room-now-playing">Henüz şarkı çalmıyor</p>'}<button class="button button-join" data-directory-join="${escapeHtml(room.roomId)}">Odaya katıl <span>→</span></button></div></article>`).join('') : '<div class="directory-empty">Filtrelere uygun açık oda bulunamadı.</div>');
  $('[data-directory-create]')?.addEventListener('click', () => showModal('createModal'));
  $$('[data-directory-join]').forEach(button => button.addEventListener('click', () => enterRoom(button.dataset.directoryJoin)));
  $$('[data-favorite-room]').forEach(button => button.addEventListener('click', async () => { if (!state.user) return modalAuth('login'); try { const favorite = !button.classList.contains('active'); await api(`/api/me/favorites/rooms/${encodeURIComponent(button.dataset.favoriteRoom)}`, { method: 'PUT', body: JSON.stringify({ favorite }) }); state.user.favoriteRooms = state.user.favoriteRooms || []; state.user.favoriteRooms = favorite ? [...new Set([...state.user.favoriteRooms, button.dataset.favoriteRoom])] : state.user.favoriteRooms.filter(id => id !== button.dataset.favoriteRoom); await refreshRooms(); } catch (error) { toast(error.message); } }));
}
function activeView(name) { $('#homeView').classList.toggle('hidden', name !== 'home'); $('#roomsDirectoryView').classList.toggle('hidden', name !== 'rooms'); $('#roomView').classList.toggle('hidden', name !== 'room'); $('#profileView').classList.toggle('hidden', name !== 'profile'); $('#communityView').classList.toggle('hidden', name !== 'community'); $('#pageCrumb').textContent = name === 'room' ? 'Dinleme odası' : name === 'rooms' ? 'Dinleme odaları' : name === 'profile' ? 'Profilim' : name === 'community' ? 'Topluluk' : 'Senin için'; $$('.main-nav .nav-item').forEach(item => item.classList.toggle('active', item.hash === (name === 'profile' ? '#profile' : name === 'community' ? '#community' : name === 'rooms' || name === 'room' ? '#room' : '#home'))); if ((name === 'home' || name === 'rooms') && state.rooms) renderRoomsSnapshot(state.rooms); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function enterRoom(roomId, { forceRejoin = false } = {}) {
  if (!requireUser()) return;
  roomId = String(roomId || '').trim();
  const sameRoom = state.room?.roomId === roomId;
  if (sameRoom && !forceRejoin) { activeView('room'); return; }
  if (sameRoom) state.roomEpoch += 1;
  else if (state.room || state.selectedTrack !== null || state.roomEpoch > 0) leaveRoom({ notifyServer: false, navigate: false });
  else state.roomEpoch += 1;
  const roomEpoch = state.roomEpoch;
  try { connectSocket(); } catch (e) { toast(e.message); return; }
  state.socket.emit('room:join', { roomId }, response => {
    if (roomEpoch !== state.roomEpoch) return;
    if (response?.error) { if (sessionStorage.getItem(ACTIVE_ROOM_KEY) === roomId) sessionStorage.removeItem(ACTIVE_ROOM_KEY); const wasRestoring = document.documentElement.classList.contains('room-restoring'); document.documentElement.classList.remove('room-restoring'); $('#roomResumeNotice').classList.add('hidden'); if (wasRestoring) activeView('home'); toast(response.error); return; }
    sessionStorage.setItem(ACTIVE_ROOM_KEY, roomId);
    document.documentElement.classList.remove('room-restoring'); $('#roomResumeNotice').classList.add('hidden');
    state.room = response.room; state.queue = response.room.queue || []; state.participants = uniqueParticipants(response.room.participants || []); state.chatMessages = response.room.chat || []; state.isHost = response.room.hostId === state.user.id; state.isDj = state.isHost || !!state.user.isAdmin || !!state.participants.find(person => person.id === state.socket.id)?.isDj; state.playbackNeedsGesture = false; roomPlayer.enter(response.room); if (!sameRoom) { $('#chatMessages').innerHTML = ''; $('#chatBadge').textContent = '0'; $('#searchResults').innerHTML = '<div class="search-hint">Şarkı adını yazıp sonuçları ara.</div>'; } renderChat(); renderPoll(); loadFriends().then(renderParticipants).catch(() => {}); if (!sameRoom) { $('#pollComposer')?.classList.add('hidden'); $('#pollCreateForm')?.reset(); } renderRoomFeatures();
    $('#roomTitle').textContent = response.room.name || 'Arkadaşlarla dinleme'; $('#hostName').textContent = response.room.hostName || (state.isHost ? state.user.username : 'Oda sahibi'); setAvatar($('#hostAvatar'), state.participants.find(person => person.userId === response.room.hostId)?.avatar || '', response.room.hostName || state.user.username); $('#roomVisibility').textContent = response.room.visibility === 'private' ? 'Özel oda · davetli' : 'Herkese açık'; $('#roomCode').textContent = roomId; $('#participantList').dataset.owner = response.room.hostId; $('#queueCount').textContent = state.queue.length; $('#queueSubCount').textContent = `${state.queue.length} parça`; if (!forceRejoin) activeView('room'); renderQueue(); renderParticipants(); refreshRooms();
    state.socket.off('room:queue').on('room:queue', update => { if (!state.room || update?.roomId !== state.room.roomId) return; applyQueueSnapshot(update.queue || []); });
    state.socket.off('room:participants').on('room:participants', update => { if (!state.room || update?.roomId !== state.room.roomId) return; state.participants = uniqueParticipants(update.participants || []); const host = state.participants.find(person => person.userId === state.room.hostId); if (host) setAvatar($('#hostAvatar'), host.avatar, host.username); renderParticipants(); renderRoomFeatures(); syncPeers(state.participants); });
    state.socket.off('room:history').on('room:history', event => { if (event?.roomId !== state.room?.roomId) return; state.room.history = [event.entry, ...(state.room.history || [])].slice(0, 30); renderRoomFeatures(); });
    state.socket.off('room:stats').on('room:stats', event => { if (event?.roomId !== state.room?.roomId) return; state.room.statistics = event.statistics; renderRoomFeatures(); });
    state.socket.off('room:requests').on('room:requests', event => { if (event?.roomId !== state.room?.roomId) return; state.room.requests = event.requests || []; renderRoomFeatures(); });
    state.socket.off('room:announcement').on('room:announcement', event => { if (event?.roomId !== state.room?.roomId) return; state.room.announcement = event.announcement || ''; renderRoomFeatures(); });
    state.socket.off('room:role').on('room:role', role => { if (role?.roomId && role.roomId !== state.room?.roomId) return; state.isDj = state.isHost || !!state.user?.isAdmin || !!role.isDj; renderPlaybackPermissions(); renderQueue(); renderRoomFeatures(); renderParticipants(); });
    state.socket.off('room:chat').on('room:chat', msg => { if (msg?.roomId === state.room?.roomId) appendChat(msg); });
    state.socket.off('room:chat:reaction').on('room:chat:reaction', event => { if (event?.roomId !== state.room?.roomId) return; const message = state.chatMessages.find(item => item.id === event.messageId); if (message) { message.reactions = event.reactions || {}; renderChat(); } });
    state.socket.off('room:poll').on('room:poll', event => { if (event?.roomId !== state.room?.roomId) return; state.room.activePoll = event.poll; renderPoll(); });
    state.socket.off('room:details').on('room:details', details => { if (!state.room || details?.roomId !== state.room.roomId) return; Object.assign(state.room, details); $('#roomTitle').textContent = state.room.name; $('#roomVisibility').textContent = state.room.visibility === 'private' ? 'Özel oda · davetli' : 'Herkese açık'; refreshRooms(); });
    state.socket.off('room:closed').on('room:closed', event => { if (event?.roomId && event.roomId !== state.room?.roomId) return; toast('Oda sahibi odayı kapattı.'); leaveRoom({ notifyServer: false }); });
    state.socket.off('room:kicked').on('room:kicked', event => { if (event?.roomId && event.roomId !== state.room?.roomId) return; toast('Oda sahibi seni odadan çıkardı.'); leaveRoom({ notifyServer: false }); });
    state.socket.off('room:host').on('room:host', host => { if (!state.room || host?.roomId !== state.room.roomId) return; state.room.hostId = host.hostId; state.room.hostName = host.hostName; state.isHost = !!host.isHost; state.isDj = state.isHost || !!host.isDj || !!state.user?.isAdmin; $('#hostName').textContent = host.hostName; $('#participantList').dataset.owner = host.hostId; $('#deleteRoom').classList.toggle('hidden', !state.isHost && !state.user?.isAdmin); renderPlaybackPermissions(); renderQueue(); renderParticipants(); });
    state.socket.off('rtc:signal').on('rtc:signal', message => onSignal(message));
    state.socket.off('disconnect').on('disconnect', () => { if (state.room) toast('Bağlantı koptu, yeniden bağlanılıyor…'); });
    $('#deleteRoom').classList.toggle('hidden', !state.isHost && !state.user?.isAdmin);
    state.repeat = response.room.playback?.repeat || 'off'; state.shuffle = !!response.room.playback?.shuffle; updateRepeatButton(); $('#shuffleBtn').classList.toggle('active', state.shuffle); renderPlaybackPermissions();
  });
}
function uniqueParticipants(participants) { return [...new Map(participants.map(person => [person.userId || person.id, person])).values()]; }
function renderParticipants() {
  state.participants = uniqueParticipants(state.participants);
  const ownerId = $('#participantList').dataset.owner;
  $('#participantCount').textContent = `${state.participants.length} kişi`;
  $('#participantList').innerHTML = state.participants.map(p => `<div class="participant" data-person="${escapeHtml(p.id)}">${p.userId === state.user?.id ? `<span class="participant-avatar">${p.avatar ? `<img src="${escapeHtml(p.avatar)}" alt="" />` : escapeHtml(initials(p.username))}</span>` : `<button type="button" class="participant-avatar profile-avatar-button" data-profile-view="${escapeHtml(p.username)}" aria-label="${escapeHtml(p.username)} profilini görüntüle">${p.avatar ? `<img src="${escapeHtml(p.avatar)}" alt="" />` : escapeHtml(initials(p.username))}</button>`}<span>${p.userId === state.user?.id ? `${escapeHtml(p.username)} (sen)` : `<button class="participant-profile-link" data-profile-view="${escapeHtml(p.username)}">${escapeHtml(p.username)}</button>`}</span>${p.micOn ? '<span class="media-indicator">MIC</span>' : ''}${p.cameraOn ? '<span class="media-indicator">CAM</span>' : ''}${p.isAdmin ? '<span class="participant-role participant-admin">ADMIN</span>' : p.userId === ownerId ? '<span class="participant-role">SAHİP</span>' : p.isDj ? '<span class="participant-role">DJ</span>' : ''}${p.userId !== state.user?.id ? `<button class="participant-more" data-person-menu="${escapeHtml(p.userId)}" title="Üye işlemleri">···</button>` : ''}</div>`).join('') || '<div class="side-empty">Katılımcılar yükleniyor.</div>';
  $$('[data-person-menu]').forEach(button => button.addEventListener('click', e => { e.stopPropagation(); document.querySelectorAll('.participant-menu').forEach(menu => menu.remove()); const person = state.participants.find(p => p.userId === button.dataset.personMenu); if (!person) return; const isFriend = state.friends.friends.some(item => item.id === person.userId); const outgoingRequest = state.friends.outgoing.some(item => item.to === person.userId); const incomingRequest = state.friends.incoming.find(item => item.from === person.userId); const friendAction = isFriend ? '' : incomingRequest ? '<button data-action="accept-friend">Gelen isteği kabul et</button>' : outgoingRequest ? '<button disabled>İstek gönderildi</button>' : '<button data-action="friend-request">Arkadaşlık isteği gönder</button>'; const menu = document.createElement('div'); menu.className = 'participant-menu'; menu.innerHTML = `${friendAction}${(state.isHost || state.user?.isAdmin) ? (person.isDj ? '<button data-action="revoke">DJ yetkisini kaldır</button>' : '<button data-action="dj">DJ yap</button>') : ''}${state.isDj ? '<button data-action="handoff">DJ kontrolünü devret</button>' : ''}${state.isHost ? '<button data-action="host">Oda sahipliğini devret</button>' : ''}${(state.isHost || state.user?.isAdmin) ? '<button data-action="kick" class="danger-action">Üyeyi odadan çıkar</button>' : ''}`; button.parentElement.append(menu); menu.onclick = event => { const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return; if (action === 'friend-request') api('/api/me/friends/request', { method: 'POST', body: JSON.stringify({ username: person.username }) }).then(async () => { await loadFriends(); renderParticipants(); toast('Arkadaşlık isteği gönderildi.'); }).catch(error => toast(error.message)); if (action === 'accept-friend' && incomingRequest) api('/api/me/friends/requests/' + encodeURIComponent(incomingRequest.id), { method: 'POST', body: JSON.stringify({ accept: true }) }).then(async () => { await loadFriends(); renderParticipants(); toast('Arkadaşlık isteği kabul edildi.'); }).catch(error => toast(error.message)); if (action === 'kick') { if (!confirm(`${person.username} odadan çıkarılsın mı?`)) return; state.socket.emit('room:kick', person.userId); } if (action === 'dj' || action === 'revoke') { const eventName = action === 'dj' ? 'room:dj:assign' : 'room:dj:revoke'; state.socket.emit(eventName, person.userId, result => { if (result?.error) toast(result.error); else toast(action === 'dj' ? `${person.username} DJ oldu.` : `${person.username} için DJ rolü kaldırıldı.`); }); } if (action === 'handoff') state.socket.emit('room:dj:handoff', person.userId, result => { if (result?.error) toast(result.error); else toast(`DJ kontrolü ${person.username} kullanıcısına devredildi.`); }); if (action === 'host') { if (!confirm(`Oda sahipliği ${person.username} kullanıcısına devredilsin mi?`)) return; state.socket.emit('room:host:transfer', person.userId); } menu.remove(); }; document.addEventListener('click', () => menu.remove(), { once: true }); }));
  $('[data-profile-view]').forEach(button => button.onclick = () => openPublicProfile(button.dataset.profileView));
  $$('.participant').forEach(row => row.oncontextmenu = event => { const button = row.querySelector('[data-person-menu]'); if (!button) return; event.preventDefault(); button.click(); });
  $('#voiceParticipants').innerHTML = state.participants.map(p => `<span class="voice-person">${escapeHtml(p.username)}${p.micOn ? ' · MIC' : ''}${p.cameraOn ? ' · CAM' : ''}</span>`).join('');
}
async function openPublicProfile(username) {
  try {
    const profile = await api(`/api/users/${encodeURIComponent(username)}`);
    $('#publicProfileName').textContent = profile.username; $('#publicProfileStatus').textContent = profile.status || ''; $('#publicProfileBio').textContent = profile.bio || '';
    $('#publicProfileGenres').textContent = profile.genres?.length ? `Türler: ${profile.genres.join(', ')}` : 'Favori tür eklenmemiş.';
    $('#publicProfileStats').innerHTML = `<div class="admin-stat"><span>Çalınan parça</span><b>${profile.stats.plays}</b></div><div class="admin-stat"><span>Dinleme</span><b>${Math.floor(profile.stats.seconds / 3600)} sa</b></div><div class="admin-stat"><span>Arkadaş</span><b>${profile.friendCount || 0}</b></div>`;
    setAvatar($('#publicProfileAvatar'), profile.avatar, profile.username);
    let button = $('#publicFriendRequest');
    if (!button) { button = document.createElement('button'); button.id = 'publicFriendRequest'; button.className = 'button button-outline'; $('#publicProfileName').insertAdjacentElement('afterend', button); }
    const knownFriend = state.friends.friends.some(person => person.username.toLowerCase() === profile.username.toLowerCase()); const requestPending = state.friends.outgoing.some(item => item.username?.toLowerCase() === profile.username.toLowerCase()); button.textContent = knownFriend ? 'Zaten arkadaşsınız' : requestPending ? 'İstek gönderildi' : 'Arkadaşlık isteği gönder'; button.disabled = knownFriend || requestPending; button.classList.toggle('hidden', !state.user || profile.username.toLowerCase() === state.user.username.toLowerCase());
    button.onclick = async () => { try { await api('/api/me/friends/request', { method: 'POST', body: JSON.stringify({ username: profile.username }) }); button.textContent = 'İstek gönderildi'; button.disabled = true; toast('Arkadaşlık isteği gönderildi.'); } catch (error) { toast(error.message); } };
    showModal('publicProfileModal');
  } catch (error) { toast(error.message); }
}
function renderPlaybackPermissions() {
  ['#playBtn', '#prevBtn', '#nextBtn', '#shuffleBtn', '#repeatBtn', '#clearQueue', '#announceBtn'].forEach(selector => { const button = $(selector); if (button) { const localResume = selector === '#playBtn' && (state.playbackNeedsGesture || (!state.isDj && state.lastPlayback?.playing)); button.disabled = !state.isDj && !localResume; button.title = localResume ? 'Bu cihazda dinlemeyi başlat veya durdur; oda canlı konumunu izler' : state.isDj ? (button.dataset.djTitle || button.title) : 'Ortak oynatma kontrolü yalnızca oda sahibi veya DJ’de'; } });
  $$('#queueList [data-play-index], #queueList [data-remove-track]').forEach(button => { button.disabled = !state.isDj; if (!state.isDj) button.title = 'Yalnızca oda sahibi veya DJ kullanabilir'; });
  $$('#searchResults [data-add-track]').forEach(button => { button.disabled = false; button.title = state.isDj ? 'Kuyruğa ekle' : 'DJ’ye şarkı isteği gönder'; });
  $$('.player-controls input[type="range"]').forEach(input => { if (input.id === 'seekBar') input.disabled = !state.isDj; });
}
function updateVoiceConnectionStatus() {
  const label = $('#voiceConnectionStatus'); if (!label) return;
  const peers = [...state.peers.values()];
  if (!peers.length) { label.textContent = 'Odada başka biri olduğunda ses ve kamera bağlantısı kurulur.'; return; }
  if (peers.some(peer => peer.connectionState === 'failed')) { label.textContent = state.turnConfigured === false ? 'Bağlantı kurulamadı. Farklı ağlarda görüşme için Render’a TURN_URL, TURN_USERNAME ve TURN_PASSWORD eklenmeli.' : 'Bağlantı kurulamadı. Görüşme yeniden bağlanmayı denedi.'; return; }
  label.textContent = peers.every(peer => peer.connectionState === 'connected') ? 'Ses ve kamera bağlantısı kuruldu.' : 'Karşı tarafın cihazına bağlanıyor…';
}
function renderQueue() {
  $('#queueCount').textContent = state.queue.length; $('#queueSubCount').textContent = `${state.queue.length} parça`;
  if (!state.queue.length) { $('#queueList').innerHTML = '<div class="queue-empty"><span>♫</span><b>Sıra henüz boş</b><small>Yukarıdan şarkı ara veya bağlantı ekle.</small></div>'; return; }
  $('#queueList').innerHTML = state.queue.map((track, i) => `<div class="queue-item" data-index="${i}"><span class="queue-index">${String(i + 1).padStart(2, '0')}</span>${track.thumbnail ? `<img class="queue-thumb" src="${escapeHtml(track.thumbnail)}" alt="" />` : '<span class="queue-thumb" style="display:grid;place-items:center;color:#c6ec82">♫</span>'}<span class="queue-track"><b>${escapeHtml(track.title)}</b><span>${escapeHtml(track.artist || track.addedBy || '—')}</span></span><span class="queue-source">${track.source === 'youtube' ? 'YT' : 'LOCAL'}</span><button class="queue-remove" data-play-index="${i}" title="Çal">▶</button>${state.isDj ? `<button class="queue-remove" data-remove-track="${escapeHtml(track.id)}" title="Kuyruktan kaldır">×</button>` : ''}</div>`).join('');
  $$('[data-play-index]').forEach(button => button.addEventListener('click', () => playAt(Number(button.dataset.playIndex))));
  $$('[data-remove-track]').forEach(button => button.addEventListener('click', () => { button.disabled = true; state.socket.emit('room:queue:remove', button.dataset.removeTrack, result => { if (result?.error) { toast(result.error); button.disabled = false; } else toast('Şarkı kuyruktan kaldırıldı.'); }); }));
  renderPlaybackPermissions();
}
function applyQueueSnapshot(queue) {
  if (!Array.isArray(queue)) return;
  const currentId = state.lastPlayback?.track?.id || state.queue[state.selectedTrack]?.id;
  state.queue = queue;
  state.selectedTrack = currentId ? queue.findIndex(track => track.id === currentId) : null;
  if (state.selectedTrack < 0) state.selectedTrack = null;
  $('#queueCount').textContent = state.queue.length;
  $('#queueSubCount').textContent = `${state.queue.length} parça`;
  renderQueue();
}
function addTrack(track) {
  if (!state.room || !state.socket) return toast('Önce odaya katıl.');
  const event = state.isDj ? 'room:queue:add' : 'room:request:add';
  state.socket.emit(event, { ...track, videoId: track.id || track.videoId }, result => { if (result?.error) return toast(result.error); if (state.isDj && Array.isArray(result?.queue)) applyQueueSnapshot(result.queue); toast(state.isDj ? 'Şarkı sıraya eklendi.' : 'Şarkı isteğin DJ’ye gönderildi.'); });
}
async function searchTracks() {
  const q = $('#trackSearch').value.trim(); if (!q) return;
  const requestId = ++state.catalogSearchRequest;
  $('#searchResults').innerHTML = '<div class="search-hint">Aranıyor…</div>';
  try {
    let items;
    if (state.source === 'youtube') items = (await api(`/api/youtube/search?q=${encodeURIComponent(q)}`)).items;
    else { const catalog = await api('/api/catalog'); items = catalog.filter(t => `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase())).map(t => ({ ...t, id: t._id, thumbnail: '' })); }
    if (requestId !== state.catalogSearchRequest) return;
    $('#searchResults').innerHTML = items?.length ? items.map(item => `<div class="search-result"><img src="${escapeHtml(item.thumbnail || '')}" alt="" /><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.artist)}</span></div><button data-add-track="${escapeHtml(item.id)}" title="Kuyruğa ekle">＋</button></div>`).join('') : '<div class="search-hint">Sonuç bulunamadı.</div>';
    renderPlaybackPermissions();
    $$('[data-add-track]').forEach(button => button.addEventListener('click', () => { const item = items.find(x => x.id === button.dataset.addTrack); addTrack(state.source === 'youtube' ? { title: item.title, artist: item.artist, source: 'youtube', videoId: item.id, thumbnail: item.thumbnail } : { title: item.title, artist: item.artist, source: 'library', url: item.url }); }));
  } catch (e) { if (requestId === state.catalogSearchRequest) $('#searchResults').innerHTML = `<div class="search-hint">${escapeHtml(e.message)}</div>`; }
}
function parseYouTube(value) { try { const u = new URL(value); const host = u.hostname.replace(/^www\./, '').toLowerCase(); if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return ''; let id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v'); if (host !== 'youtu.be' && u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2]; return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : ''; } catch { return ''; } }
function playAt(index) { roomPlayer.play(index); }
function playerPosition() { return roomPlayer.position(); }
function syncPlayback(playing = true, position = playerPosition(), index = state.selectedTrack) { roomPlayer.command({ playing, position, index }); }
function togglePlayback() {
  if (state.playbackNeedsGesture) return roomPlayer.resumeLocal();
  if (!state.isDj && state.lastPlayback?.playing) return roomPlayer.toggle();
  if (!state.isDj) return toast('Oynatmayı oda DJ’i yönetiyor.');
  if (state.selectedTrack == null) return state.queue.length ? playAt(0) : toast('Önce kuyruğa bir şarkı ekle.');
  roomPlayer.toggle();
}
function resumeLocalPlayback() { roomPlayer.resumeLocal(); }
function applyPlayback(playback, force = false) { if (force) roomPlayer.resync(playback); else roomPlayer.receive(playback); }
function updateRepeatButton() { const button = $('#repeatBtn'); if (!button) return; button.dataset.mode = state.repeat; button.title = `Tekrar: ${{ off: 'Kapalı', all: 'Tüm sıra', one: 'Tek şarkı' }[state.repeat]}`; button.classList.toggle('active', state.repeat !== 'off'); }
function nextTrack(manual = false) { if (!state.queue.length || !state.isDj) return; if (!manual && state.repeat === 'one') return playAt(state.selectedTrack ?? 0); if (!manual && state.repeat === 'off' && state.selectedTrack === state.queue.length - 1) { syncPlayback(false); return; } let next = ((state.selectedTrack ?? -1) + 1) % state.queue.length; if (state.shuffle && state.queue.length > 1) { const choices = state.queue.map((_, i) => i).filter(i => i !== state.selectedTrack); next = choices[Math.floor(Math.random() * choices.length)]; } playAt(next); }
function prevTrack() { if (!state.isDj) return; if (playerPosition() > 3) { syncPlayback(true, 0); return; } if (state.queue.length) playAt((state.selectedTrack - 1 + state.queue.length) % state.queue.length); }
function appendChat(msg) { if (!msg?.id || state.chatMessages.some(item => item.id === msg.id)) return; state.chatMessages.push(msg); state.chatMessages = state.chatMessages.slice(-100); renderChat(); $('#chatBadge').textContent = Number($('#chatBadge').textContent || 0) + 1; }
function applyLocalMusicVolume() { roomPlayer.applyVolume(); const button = $('#roomListenToggle'); if (button) { button.textContent = state.localMusicMuted ? '🎧 Müzik sessiz' : '🎧 Müziği dinle'; button.setAttribute('aria-pressed', String(state.localMusicMuted)); button.title = state.localMusicMuted ? 'Oda müziğinin sesini bu cihazda aç' : 'Oda müziğini bu cihazda sessize al'; } }
function renderChat() {
  const box = $('#chatMessages'); if (!box) return;
  if (!state.chatMessages.length) { box.innerHTML = '<div class="chat-welcome">Odaya hoş geldin. Sohbeti başlat!</div>'; return; }
  box.innerHTML = state.chatMessages.map(msg => {
    const person = state.participants.find(item => item.userId === msg.userId || item.username === msg.username); const reactions = msg.reactions || {};
    const reactionButtons = ['👍', '❤️', '😂', '🔥', '👏'].map(reaction => `<button type="button" class="chat-reaction ${reactions[reaction]?.mine ? 'selected' : ''}" data-chat-react="${escapeHtml(reaction)}" data-message-id="${escapeHtml(msg.id)}">${reaction} <span>${reactions[reaction]?.count || 0}</span></button>`).join('');
    return `<article class="chat-message"><span class="chat-avatar">${person?.avatar ? `<img src="${escapeHtml(person.avatar)}" alt="" />` : escapeHtml(initials(msg.username))}</span><div class="chat-message-body"><div class="chat-message-head"><b>${escapeHtml(msg.username)}</b><time>${new Date(msg.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</time></div><p>${escapeHtml(msg.text)}</p><div class="chat-reactions">${reactionButtons}</div></div></article>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
  $$('[data-chat-react]').forEach(button => button.onclick = () => state.socket.emit('room:chat:react', { messageId: button.dataset.messageId, reaction: button.dataset.chatReact }, result => { if (result?.error) toast(result.error); }));
}
function renderPoll() {
  const box = $('#activePoll'); if (!box) return;
  const toggle = $('#pollToggle'); if (toggle) { toggle.disabled = !!state.room && !state.isDj && !state.isHost; toggle.title = toggle.disabled ? 'Anketi yalnızca oda sahibi veya DJ oluşturabilir.' : 'Oda için oylama başlat'; }
  const poll = state.room?.activePoll;
  if (!poll) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const total = poll.options.reduce((sum, option) => sum + (Number(option.votes) || 0), 0);
  box.innerHTML = `<div class="poll-head"><div><b>${escapeHtml(poll.question)}</b><small>${escapeHtml(poll.createdBy)} · ${total} oy</small></div>${state.isDj || state.isHost ? `<button type="button" class="text-button" id="pollClose">Anketi kapat</button>` : ''}</div><div class="poll-options">${poll.options.map(option => { const votes = Number(option.votes) || 0; const selected = !!option.votedByMe; return `<button type="button" class="poll-option ${selected ? 'selected' : ''}" data-poll-vote="${escapeHtml(option.id)}"><span>${escapeHtml(option.label)}</span><span>${votes}</span><i style="width:${total ? Math.round(votes / total * 100) : 0}%"></i></button>`; }).join('')}</div>`;
  $$('[data-poll-vote]').forEach(button => button.onclick = () => state.socket.emit('room:poll:vote', { pollId: poll.id, optionId: button.dataset.pollVote }, result => { if (result?.error) toast(result.error); }));
  $('#pollClose')?.addEventListener('click', () => state.socket.emit('room:poll:close', { pollId: poll.id }, result => { if (result?.error) toast(result.error); }));
}
async function loadFriends() {
  if (!state.user) return;
  try {
    state.friends = await api('/api/me/friends');
    $('#friendRequests').innerHTML = state.friends.incoming.length ? `<h4>Gelen istekler</h4>${state.friends.incoming.map(item => `<article class="activity-row"><div><b>${escapeHtml(item.username || 'Kullanıcı')}</b><span>Arkadaşlık isteği gönderdi</span></div><button class="button button-outline" data-friend-accept="${escapeHtml(item.id)}">Kabul</button><button class="button button-quiet" data-friend-reject="${escapeHtml(item.id)}">Reddet</button></article>`).join('')}` : '<p class="activity-empty">Bekleyen arkadaşlık isteği yok.</p>';
    $('#friendList').innerHTML = state.friends.friends.length ? state.friends.friends.map(item => `<article class="activity-row"><div><b>${escapeHtml(item.username)}</b><span>${item.online ? '● Çevrimiçi' : escapeHtml(item.status || 'Karaaslan Müzik üyesi')}</span></div>${state.room ? `<button class="button button-outline" data-invite-friend="${escapeHtml(item.id)}">Odaya davet et</button>` : ''}<button class="button button-quiet" data-unfriend="${escapeHtml(item.id)}">Çıkar</button></article>`).join('') : '<p class="activity-empty">Henüz arkadaş eklemedin.</p>';
    $$('[data-friend-accept],[data-friend-reject]').forEach(button => button.onclick = async () => { try { await api(`/api/me/friends/requests/${encodeURIComponent(button.dataset.friendAccept || button.dataset.friendReject)}`, { method: 'POST', body: JSON.stringify({ accept: !!button.dataset.friendAccept }) }); await loadFriends(); toast(button.dataset.friendAccept ? 'Arkadaş eklendi.' : 'İstek reddedildi.'); } catch (error) { toast(error.message); } });
    $$('[data-unfriend]').forEach(button => button.onclick = async () => { try { await api(`/api/me/friends/${encodeURIComponent(button.dataset.unfriend)}`, { method: 'DELETE' }); await loadFriends(); } catch (error) { toast(error.message); } });
    $$('[data-invite-friend]').forEach(button => button.onclick = async () => { try { await api(`/api/rooms/${encodeURIComponent(state.room.roomId)}/invite-friend`, { method: 'POST', body: JSON.stringify({ friendId: button.dataset.inviteFriend }) }); toast('Oda daveti gönderildi.'); } catch (error) { toast(error.message); } });
  } catch (error) { $('#friendRequests').textContent = error.message; }
}
let communityMemberTimer;
function scheduleCommunityMembers() { clearTimeout(communityMemberTimer); communityMemberTimer = setTimeout(() => loadCommunityMembers(), 250); }
async function loadCommunityMembers() {
  if (!state.user) return;
  try {
    const result = await api(`/api/community/members?q=${encodeURIComponent($('#communitySearch').value.trim())}&page=${state.communityPage}`);
    state.communityMembers = result.members || []; state.communityTotal = result.total || 0; state.communityPages = Math.max(1, result.pages || 1);
    if (state.communityPage >= state.communityPages) { state.communityPage = state.communityPages - 1; return loadCommunityMembers(); }
    $('#memberCount').textContent = state.communityTotal;
    $('#communityMembers').innerHTML = state.communityMembers.length ? state.communityMembers.map(person => {
      const status = person.online ? 'Çevrimiçi' : person.status || 'Karaaslan Müzik üyesi';
      let action = person.isFriend ? `<button class="button button-outline" data-community-dm="${escapeHtml(person.id)}">Mesaj gönder</button>` : person.requestReceived ? `<button class="button button-primary" data-community-accept="${escapeHtml(person.requestId)}">İsteği kabul et</button>` : person.requestSent ? '<button class="button button-outline" disabled>İstek gönderildi</button>' : `<button class="button button-outline" data-community-request="${escapeHtml(person.username)}">Arkadaş ekle</button>`;
      return `<article class="community-member">${communityAvatarMarkup(person.username, person.avatar)}<div class="community-member-copy"><b>${escapeHtml(person.username)}</b><span>${escapeHtml(status)}</span></div>${action}</article>`;
    }).join('') : '<p class="activity-empty">Bu aramayla eşleşen üye bulunamadı.</p>';
    bindCommunityAvatarFallbacks($('#communityMembers'));
    $$('[data-community-request]').forEach(button => button.onclick = async () => { try { await api('/api/me/friends/request', { method: 'POST', body: JSON.stringify({ username: button.dataset.communityRequest }) }); toast('Arkadaşlık isteği gönderildi; karşı tarafa bildirim gitti.'); await loadCommunityMembers(); } catch (error) { toast(error.message); } });
    $$('[data-community-accept]').forEach(button => button.onclick = async () => { try { await api(`/api/me/friends/requests/${encodeURIComponent(button.dataset.communityAccept)}`, { method: 'POST', body: JSON.stringify({ accept: true }) }); toast('Arkadaşlık isteği kabul edildi.'); await loadCommunityMembers(); await loadFriends(); } catch (error) { toast(error.message); } });
    $$('[data-community-dm]').forEach(button => button.onclick = async () => { await openDirectChat(state.friends.friends.find(person => person.id === button.dataset.communityDm) || { id: button.dataset.communityDm, username: button.closest('.community-member').querySelector('.community-member-copy b').textContent }); selectCommunityTab('dms'); });
    const pagination = $('#communityPagination');
    pagination.innerHTML = state.communityPages > 1 ? `<button type="button" class="button button-outline" data-community-page="prev" ${state.communityPage <= 0 ? 'disabled' : ''}>Önceki</button><span>${state.communityPage + 1} / ${state.communityPages} · ${state.communityTotal} üye</span><button type="button" class="button button-outline" data-community-page="next" ${state.communityPage + 1 >= state.communityPages ? 'disabled' : ''}>Sonraki</button>` : `<span>${state.communityTotal} üye</span>`;
    $$('[data-community-page]').forEach(button => button.onclick = () => { state.communityPage += button.dataset.communityPage === 'next' ? 1 : -1; loadCommunityMembers(); });
  } catch (error) { $('#communityMembers').textContent = error.message; }
}
function selectCommunityTab(tab) {
  state.communityTab = tab;
  $$('.community-tab').forEach(button => button.classList.toggle('active', button.dataset.communityTab === tab));
  ['members', 'general', 'dms'].forEach(name => $(`#community${name[0].toUpperCase()}${name.slice(1)}Pane`).classList.toggle('hidden', name !== tab));
  if (tab === 'members') loadCommunityMembers();
  if (tab === 'general') joinCommunityChat();
  if (tab === 'dms') loadDirectFriends();
}
function joinCommunityChat() {
  if (!state.socket?.connected) return;
  state.socket.emit('community:chat:join', {}, result => { if (result?.error) return toast(result.error); state.communityMessages = result.messages || []; renderCommunityMessages(); });
}
function appendCommunityMessage(message) {
  if (!message?.id || state.communityMessages.some(item => item.id === message.id)) return;
  state.communityMessages.push(message); state.communityMessages = state.communityMessages.slice(-100); renderCommunityMessages();
}
function renderCommunityMessages() {
  const box = $('#communityMessages'); if (!box) return;
  box.innerHTML = state.communityMessages.length ? state.communityMessages.map(message => `<article class="community-message">${communityAvatarMarkup(message.username, message.avatar)}<div><b>${escapeHtml(message.username)}</b><p>${escapeHtml(message.text)}</p><time>${new Date(message.createdAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</time></div></article>`).join('') : '<div class="chat-welcome">Genel sohbette henüz mesaj yok. İlk mesajı sen yaz.</div>';
  bindCommunityAvatarFallbacks(box);
  box.scrollTop = box.scrollHeight;
}
async function loadDirectFriends() {
  if (!state.user) return;
  try { state.friends = await api('/api/me/friends');
    $('#dmFriendList').innerHTML = state.friends.friends.length ? state.friends.friends.map(person => `<button type="button" class="dm-friend ${state.activeDmFriend?.id === person.id ? 'active' : ''}" data-dm-friend="${escapeHtml(person.id)}">${communityAvatarMarkup(person.username, person.avatar)}<span><b>${escapeHtml(person.username)}</b><small>${person.online ? 'Çevrimiçi' : 'Mesajlaşma'}</small></span></button>`).join('') : '<p class="activity-empty">Özel sohbet için önce arkadaş ekle.</p>';
    bindCommunityAvatarFallbacks($('#dmFriendList'));
    $$('[data-dm-friend]').forEach(button => button.onclick = () => openDirectChat(state.friends.friends.find(person => person.id === button.dataset.dmFriend)));
  } catch (error) { $('#dmFriendList').textContent = error.message; }
}
async function openDirectChat(friend) {
  if (!friend?.id) return;
  if (state.activeDmFriend && state.activeDmFriend.id !== friend.id) state.socket?.emit('dm:leave', { friendId: state.activeDmFriend.id });
  state.activeDmFriend = friend; state.dmMessages = []; $('#dmTitle').textContent = `@${friend.username}`; $('#dmChatForm').classList.remove('hidden'); renderDirectFriends(); renderDirectMessages();
  if (!state.socket?.connected) return toast('Canlı bağlantı kuruluyor; birazdan mesajlarını yenile.');
  state.socket.emit('dm:join', { friendId: friend.id }, result => {
    if (state.activeDmFriend?.id !== friend.id) return;
    if (result?.error) { toast(result.error); return; }
    state.dmMessages = result.messages || []; renderDirectMessages();
  });
}
function renderDirectFriends() {
  const list = $('#dmFriendList'); if (!list || !state.friends.friends.length) return;
  list.innerHTML = state.friends.friends.map(person => `<button type="button" class="dm-friend ${state.activeDmFriend?.id === person.id ? 'active' : ''}" data-dm-friend="${escapeHtml(person.id)}">${communityAvatarMarkup(person.username, person.avatar)}<span><b>${escapeHtml(person.username)}</b><small>${person.online ? 'Çevrimiçi' : 'Mesajlaşma'}</small></span></button>`).join('');
  bindCommunityAvatarFallbacks(list);
  $$('[data-dm-friend]').forEach(button => button.onclick = () => openDirectChat(state.friends.friends.find(person => person.id === button.dataset.dmFriend)));
}
function appendDirectMessage(message) {
  if (!message?.id || state.dmMessages.some(item => item.id === message.id)) return;
  state.dmMessages.push(message); state.dmMessages = state.dmMessages.slice(-100); renderDirectMessages();
}
function renderDirectMessages() {
  const box = $('#dmMessages'); if (!box) return;
  box.innerHTML = state.dmMessages.length ? state.dmMessages.map(message => `<article class="community-message">${communityAvatarMarkup(message.fromUsername, message.avatar)}<div><b>${escapeHtml(message.fromUsername)}</b><p>${escapeHtml(message.text)}</p><time>${new Date(message.createdAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</time></div></article>`).join('') : '<div class="chat-welcome">Sohbeti başlatmak için bir mesaj yaz.</div>';
  bindCommunityAvatarFallbacks(box);
  box.scrollTop = box.scrollHeight;
}
function renderRoomFeatures() {
  if (!state.room) return;
  renderPoll();
  const history = state.room.history || []; $('#roomHistory').innerHTML = history.length ? history.map(item => `<article class="activity-row"><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.artist || '—')} · ${new Date(item.playedAt).toLocaleString('tr-TR')}</span></div>${state.isDj ? `<button class="button button-outline" data-history-add="${escapeHtml(item.trackId)}">Sıraya ekle</button>` : ''}</article>`).join('') : '<p class="activity-empty">Bu odada henüz parça çalmadı.</p>';
  $$('[data-history-add]').forEach(button => button.onclick = () => { const item = history.find(track => track.trackId === button.dataset.historyAdd); if (item) addTrack({ title: item.title, artist: item.artist, source: item.source, videoId: item.videoId, url: item.url }); });
  const requests = state.room.requests || []; const pending = requests.filter(item => item.status === 'pending'); $('#requestCount').textContent = pending.length; $('#roomRequests').innerHTML = requests.length ? requests.slice(0, 30).map(item => `<article class="activity-row"><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.requester)} istedi · ${item.status === 'pending' ? 'Bekliyor' : item.status === 'accepted' ? 'Kabul edildi' : 'Reddedildi'}</span></div>${state.isDj && item.status === 'pending' ? `<button class="button button-outline" data-request-action="accept" data-request-id="${escapeHtml(item.requestId)}">Kabul</button><button class="button button-outline" data-request-action="reject" data-request-id="${escapeHtml(item.requestId)}">Reddet</button>` : ''}</article>`).join('') : '<p class="activity-empty">Henüz istek yok.</p>';
  $$('[data-request-action]').forEach(button => button.onclick = () => state.socket.emit('room:request:resolve', { requestId: button.dataset.requestId, accept: button.dataset.requestAction === 'accept' }, result => { if (result?.error) toast(result.error); else toast(button.dataset.requestAction === 'accept' ? 'İstek kuyruğa eklendi.' : 'İstek reddedildi.'); }));
  const stats = state.room.statistics || { plays: 0, seconds: 0 }; $('#roomStats').innerHTML = `<div class="admin-stat"><span>Çalınan parça</span><b>${stats.plays || 0}</b></div><div class="admin-stat"><span>Dinleme süresi</span><b>${Math.floor((stats.seconds || 0) / 60)} dk</b></div><div class="admin-stat"><span>Şu an odada</span><b>${state.participants.length}</b></div>`;
  const announcement = $('#announcementBar'); announcement.textContent = state.room.announcement || ''; announcement.classList.toggle('hidden', !state.room.announcement);
}
function renderNotifications() {
  const unread = state.notifications.filter(item => !item.read).length; $('#notificationCount').textContent = unread > 9 ? '9+' : String(unread); $('#notificationCount').classList.toggle('hidden', !unread);
  $('#notificationList').innerHTML = state.notifications.length ? state.notifications.map(item => `<article class="activity-row ${item.read ? '' : 'unread'}"><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.message)} · ${new Date(item.createdAt).toLocaleString('tr-TR')}</span></div>${item.type === 'friend-request' && item.metadata?.friendRequestId ? `<button class="button button-outline" data-notification-friend-accept="${escapeHtml(item.metadata.friendRequestId)}">Kabul</button><button class="button button-quiet" data-notification-friend-reject="${escapeHtml(item.metadata.friendRequestId)}">Reddet</button>` : ''}${item.type === 'direct-message' && item.metadata?.userId ? `<button class="button button-outline" data-notification-dm="${escapeHtml(item.metadata.userId)}">Sohbete git</button>` : ''}${item.roomId ? `<button class="button button-outline" data-notification-room="${escapeHtml(item.roomId)}">Odaya git</button>` : ''}</article>`).join('') : '<p class="activity-empty">Yeni bildirimin yok.</p>';
  $$('[data-notification-room]').forEach(button => button.onclick = () => { hideModals(); enterRoom(button.dataset.notificationRoom); });
  $$('[data-notification-friend-accept],[data-notification-friend-reject]').forEach(button => button.onclick = async () => { try { await api(`/api/me/friends/requests/${encodeURIComponent(button.dataset.notificationFriendAccept || button.dataset.notificationFriendReject)}`, { method: 'POST', body: JSON.stringify({ accept: !!button.dataset.notificationFriendAccept }) }); state.notifications = state.notifications.map(item => item.metadata?.friendRequestId === (button.dataset.notificationFriendAccept || button.dataset.notificationFriendReject) ? { ...item, read: true } : item); renderNotifications(); await loadFriends(); if (!$('#communityView').classList.contains('hidden')) await loadCommunityMembers(); toast(button.dataset.notificationFriendAccept ? 'Arkadaşlık isteği kabul edildi.' : 'Arkadaşlık isteği reddedildi.'); } catch (error) { toast(error.message); } });
  $$('[data-notification-dm]').forEach(button => button.onclick = async () => { hideModals(); activeView('community'); selectCommunityTab('dms'); try { await loadDirectFriends(); const friend = state.friends.friends.find(person => person.id === button.dataset.notificationDm); if (friend) await openDirectChat(friend); else toast('Bu kullanıcı artık arkadaş listende değil.'); } catch (error) { toast(error.message); } });
}
async function loadNotifications() { try { const stored = await api('/api/me/notifications'); const merged = new Map(state.notifications.map(item => [item.id, item])); for (const item of stored) merged.set(item.id, item); state.notifications = [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50); renderNotifications(); } catch (error) { toast(error.message); } }
async function loadProfileActivity() {
  if (!state.user) return;
  try {
    const activity = await api('/api/me/activity'); const plays = activity.stats?.plays || 0; const seconds = activity.stats?.seconds || 0;
    $('#profileStats').innerHTML = `<div class="admin-stat"><span>Parça</span><b>${plays}</b></div><div class="admin-stat"><span>Dinleme</span><b>${Math.floor(seconds / 3600)} sa ${Math.floor(seconds % 3600 / 60)} dk</b></div>`;
    $('#profileHistory').innerHTML = activity.recentTracks?.length ? activity.recentTracks.map(item => `<article class="activity-row"><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.artist || '—')} · ${new Date(item.playedAt).toLocaleDateString('tr-TR')}</span></div></article>`).join('') : '<p class="activity-empty">Dinleme geçmişin burada birikecek.</p>';
    const favorites = state.myRooms.filter(room => room.favorite); $('#profileFavorites').innerHTML = favorites.length ? favorites.map(room => `<article class="activity-row"><div><b>${escapeHtml(room.name)}</b><span>${escapeHtml(room.mood || '')} · ${room.participants} dinleyici</span></div><button class="button button-outline" data-favorite-join="${escapeHtml(room.roomId)}">Katıl</button></article>`).join('') : '<p class="activity-empty">Henüz favori oda eklemedin.</p>';
    $$('[data-favorite-join]').forEach(button => button.onclick = () => enterRoom(button.dataset.favoriteJoin));
    const playlistRequest = ++state.playlistRequest; const playlists = await api('/api/me/playlists'); if (playlistRequest === state.playlistRequest) { state.playlists = playlists; renderPlaylists(); }
  } catch (error) { toast(error.message); }
}
function renderPlaylists() {
  $('#profilePlaylists').innerHTML = state.playlists.length ? state.playlists.map(list => `<article class="activity-row"><div><b>${escapeHtml(list.name)}</b><span>${list.tracks?.length || 0} parça</span></div>${state.room && state.isDj ? `<button class="button button-outline" data-playlist-add="${escapeHtml(list._id || list.id)}">Odaya ekle</button>` : ''}<button class="button button-outline" data-playlist-delete="${escapeHtml(list._id || list.id)}">Sil</button></article>`).join('') : '<p class="activity-empty">Henüz kişisel listen yok. Odadaki kuyruğu liste olarak kaydedebilirsin.</p>';
  $$('[data-playlist-delete]').forEach(button => button.onclick = async () => { try { await api(`/api/me/playlists/${encodeURIComponent(button.dataset.playlistDelete)}`, { method: 'DELETE' }); state.playlists = state.playlists.filter(list => (list._id || list.id) !== button.dataset.playlistDelete); renderPlaylists(); } catch (error) { toast(error.message); } });
  $$('[data-playlist-add]').forEach(button => button.onclick = () => { const list = state.playlists.find(item => (item._id || item.id) === button.dataset.playlistAdd); if (list) list.tracks.forEach(track => addTrack(track)); });
}
function selectTab(name) { state.currentTab = name; $$('.room-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name)); ['queue','chat','voice','history','requests','stats'].forEach(tab => $(`#${tab}Panel`).classList.toggle('hidden', name !== tab)); if (name === 'chat') $('#chatBadge').textContent = '0'; }
function createPeer(remoteId) {
  if (state.peers.has(remoteId) || !state.socket) return;
  if (!window.RTCPeerConnection) { toast('Bu tarayıcı WebRTC sesli ve görüntülü görüşmeyi desteklemiyor.'); return; }
  const pc = new RTCPeerConnection({ iceServers: state.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] }); state.peers.set(remoteId, pc);
  updateVoiceConnectionStatus();
  pc.pendingCandidates = [];
  pc.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender; pc.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
  if (state.voiceStream) pc.audioSender.replaceTrack(state.voiceStream.getAudioTracks()[0] || null).catch(error => console.warn('Mikrofon izi gönderilemedi:', error));
  if (state.cameraStream) pc.videoSender.replaceTrack(state.cameraStream.getVideoTracks()[0] || null).catch(error => console.warn('Kamera izi gönderilemedi:', error));
  pc.onicecandidate = e => { if (e.candidate && state.socket?.connected) state.socket.emit('rtc:signal', { to: remoteId, signal: { candidate: e.candidate } }); };
  pc.onicecandidateerror = event => console.warn(`ICE adayı ${remoteId} için üretilemedi:`, event.errorCode, event.errorText);
  pc.ontrack = e => {
    let stream = state.remoteStreams.get(remoteId);
    if (!stream) { stream = new MediaStream(); state.remoteStreams.set(remoteId, stream); }
    if (!stream.getTracks().some(track => track.id === e.track.id)) stream.addTrack(e.track);
    if (e.track.kind === 'audio') {
      let audio = document.querySelector(`[data-remote-audio="${remoteId}"]`);
      if (!audio) { audio = document.createElement('audio'); audio.autoplay = true; audio.playsInline = true; audio.dataset.remoteAudio = remoteId; document.body.append(audio); }
      audio.srcObject = stream;
      audio.play().then(() => $('#enableRemoteAudio').classList.add('hidden')).catch(() => { $('#enableRemoteAudio').classList.remove('hidden'); toast('Tarayıcı karşı tarafın sesini bekletiyor. Görüşme sekmesinden “Sesi etkinleştir”e dokun.'); });
    }
    if (e.track.kind === 'video') {
      let tile = document.querySelector(`[data-remote-tile="${remoteId}"]`);
      if (!tile) { tile = document.createElement('div'); tile.className = 'video-tile'; tile.dataset.remoteTile = remoteId; const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; const label = document.createElement('span'); label.textContent = state.participants.find(p => p.id === remoteId)?.username || 'Katılımcı'; tile.append(video, label); $('#videoGrid').append(tile); }
      const video = tile.querySelector('video'); video.srcObject = stream; video.play().then(() => tile.classList.remove('video-play-blocked')).catch(error => { console.warn('Uzak video otomatik başlatılamadı:', error); tile.classList.add('video-play-blocked'); let retry = tile.querySelector('.video-retry'); if (!retry) { retry = document.createElement('button'); retry.type = 'button'; retry.className = 'video-retry'; retry.textContent = 'Görüntüyü aç'; tile.append(retry); } retry.onclick = () => video.play().then(() => { tile.classList.remove('video-play-blocked'); retry.remove(); }).catch(problem => console.warn('Uzak video başlatılamadı:', problem)); }); tile.classList.toggle('has-video', e.track.readyState === 'live' && !e.track.muted);
      e.track.onmute = () => tile.classList.remove('has-video'); e.track.onunmute = () => tile.classList.add('has-video');
    }
  };
  pc.onconnectionstatechange = () => {
    updateVoiceConnectionStatus();
    if (pc.connectionState === 'failed') {
      if (!pc.iceRestartTried && state.socket?.id < remoteId) {
        pc.iceRestartTried = true; toast('Ses/kamera bağlantısı yenileniyor…');
        pc.restartIce(); pc.createOffer({ iceRestart: true }).then(offer => pc.setLocalDescription(offer)).then(() => state.socket?.emit('rtc:signal', { to: remoteId, signal: { description: pc.localDescription } })).catch(error => console.warn('ICE yeniden başlatılamadı:', error));
      } else if (!pc.failureTimer) {
        toast('Ses/kamera bağlantısı yenileniyor. Farklı ağlarda TURN sunucusu gerekebilir.');
        pc.failureTimer = setTimeout(() => {
          if (pc.connectionState !== 'failed' || state.peers.get(remoteId) !== pc) return;
          closePeer(remoteId, pc); createPeer(remoteId);
        }, 7000);
      }
      return;
    }
    if (pc.connectionState === 'connected') { clearTimeout(pc.failureTimer); pc.failureTimer = null; }
    if (pc.connectionState === 'closed') closePeer(remoteId, pc);
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected') {
      clearTimeout(pc.recoveryTimer);
      pc.recoveryTimer = setTimeout(() => {
        if (pc.iceConnectionState !== 'disconnected' || pc.signalingState !== 'stable' || pc.iceRestartTried) return;
        pc.iceRestartTried = true;
        pc.restartIce();
        pc.createOffer({ iceRestart: true }).then(offer => pc.setLocalDescription(offer)).then(() => state.socket?.emit('rtc:signal', { to: remoteId, signal: { description: pc.localDescription } })).catch(error => console.warn('ICE bağlantısı yenilenemedi:', error));
      }, 2500);
    } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      clearTimeout(pc.recoveryTimer); pc.iceRestartTried = false;
    }
  };
  if (state.socket.id < remoteId) pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => state.socket.emit('rtc:signal', { to: remoteId, signal: { description: pc.localDescription } })).catch(() => {});
}
function closePeer(id, peer = state.peers.get(id)) { if (!peer) return; const isCurrent = state.peers.get(id) === peer; if (isCurrent) { state.peers.delete(id); state.remoteStreams.delete(id); document.querySelector(`[data-remote-audio="${id}"]`)?.remove(); document.querySelector(`[data-remote-tile="${id}"]`)?.remove(); updateVoiceConnectionStatus(); } clearTimeout(peer.recoveryTimer); clearTimeout(peer.failureTimer); peer.close(); }
function syncPeers(people) { if (!state.room) return; const otherIds = people.filter(p => p.id !== state.socket.id).map(p => p.id); otherIds.forEach(createPeer); for (const [id, peer] of state.peers) if (!otherIds.includes(id)) closePeer(id, peer); updateVoiceConnectionStatus(); }
async function onSignal({ from, signal }) {
  if (!from || !signal) return; if (!state.peers.has(from)) createPeer(from); const pc = state.peers.get(from); if (!pc) return;
  try { if (signal.description) { await pc.setRemoteDescription(signal.description); for (const candidate of pc.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate); if (signal.description.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); state.socket.emit('rtc:signal', { to: from, signal: { description: pc.localDescription } }); } } else if (signal.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate); else pc.pendingCandidates.push(signal.candidate); } } catch (e) { console.warn('Medya bağlantısı kurulamadı', e); }
}
async function replacePeerTrack(kind, track) {
  const failed = [];
  await Promise.all([...state.peers].map(async ([remoteId, pc]) => {
    const sender = kind === 'audio' ? pc.audioSender : pc.videoSender;
    if (!sender) return;
    try { await sender.replaceTrack(track); }
    catch (error) { failed.push(remoteId); console.warn(`${kind} izi ${remoteId} cihazına gönderilemedi:`, error); }
  }));
  if (failed.length) toast(`${kind === 'audio' ? 'Ses' : 'Kamera'} ${failed.length} katılımcıya gönderilemedi. Görüşmeden çıkıp yeniden bağlanmayı dene.`);
  return failed.length === 0;
}
function mediaErrorMessage(error, device) {
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return `${device} izni verilmedi. Tarayıcıdan site iznini açıp yeniden dene.`;
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return `${device} bulunamadı.`;
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return `${device} başka bir uygulama tarafından kullanılıyor.`;
  if (error?.name === 'OverconstrainedError') return `${device} bu cihazda istenen ayarlarla açılamadı.`;
  if (!navigator.mediaDevices?.getUserMedia) return 'Bu tarayıcıda medya erişimi yok. HTTPS bağlantısı ve güncel tarayıcı gerekiyor.';
  return `${device} erişilemedi. Tarayıcı izinlerini ve cihaz bağlantısını kontrol et.`;
}
async function toggleMic() {
  if (!state.room) return toast('Önce odaya katıl.');
  try {
    if (state.voiceStream) { await replacePeerTrack('audio', null); state.voiceStream.getTracks().forEach(t => t.stop()); state.voiceStream = null; state.voiceOn = false; $('#micToggle').textContent = 'Mikrofonu aç'; toast('Mikrofon kapatıldı.'); }
    else { state.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); state.voiceOn = true; const track = state.voiceStream.getAudioTracks()[0]; const sent = await replacePeerTrack('audio', track); $('#micToggle').textContent = 'Mikrofonu kapat'; if (sent) toast('Mikrofon açıldı.'); }
    state.socket.emit('room:media', { micOn: state.voiceOn, cameraOn: state.cameraOn }); renderParticipants();
  } catch (e) { toast(mediaErrorMessage(e, 'Mikrofon')); }
}
async function toggleCamera() {
  if (!state.room) return toast('Önce odaya katıl.');
  try {
    if (state.cameraStream) { await replacePeerTrack('video', null); state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; state.cameraOn = false; $('#localVideo').srcObject = null; $('#localVideoTile').classList.remove('has-video'); $('#localVideoLabel').textContent = 'Kameranı açınca burada görünürsün'; $('#cameraToggle').textContent = 'Kamerayı aç'; toast('Kamera kapatıldı.'); }
    else { state.cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' } }); state.cameraOn = true; const track = state.cameraStream.getVideoTracks()[0]; const sent = await replacePeerTrack('video', track); $('#localVideo').srcObject = state.cameraStream; $('#localVideoTile').classList.add('has-video'); $('#localVideoLabel').textContent = state.user.username; $('#cameraToggle').textContent = 'Kamerayı kapat'; if (sent) toast('Kamera açıldı.'); }
    state.socket.emit('room:media', { micOn: state.voiceOn, cameraOn: state.cameraOn }); renderParticipants();
  } catch (e) { toast(mediaErrorMessage(e, 'Kamera')); }
}
function clearPlaybackSurface() {
  state.selectedTrack = null; state.lastPlayback = null; state.playbackNeedsGesture = false;
  roomPlayer.leave();
  state.repeat = 'off'; state.shuffle = false; updateRepeatButton(); $('#shuffleBtn').classList.remove('active');
}
function leaveRoom({ notifyServer = true, navigate = true } = {}) {
  document.documentElement.classList.remove('room-restoring'); $('#roomResumeNotice').classList.add('hidden');
  sessionStorage.removeItem(ACTIVE_ROOM_KEY);
  const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('room'); history.replaceState(history.state, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  state.roomEpoch += 1; state.voiceStream?.getTracks().forEach(t => t.stop()); state.cameraStream?.getTracks().forEach(t => t.stop());
  for (const pc of state.peers.values()) pc.close(); state.peers.clear(); state.remoteStreams.clear();
  document.querySelectorAll('[data-remote-audio],[data-remote-tile]').forEach(x => x.remove()); $('#enableRemoteAudio').classList.add('hidden'); $('#voiceConnectionStatus').textContent = 'Odaya katıldığında bağlantı durumu burada görünür.';
  $('#localVideo').srcObject = null; $('#localVideoTile').classList.remove('has-video'); $('#micToggle').textContent = 'Mikrofonu aç'; $('#cameraToggle').textContent = 'Kamerayı aç';
  state.voiceStream = null; state.cameraStream = null; state.voiceOn = false; state.cameraOn = false;
  if (notifyServer && state.socket && state.room) state.socket.emit('room:leave');
  state.room = null; state.isHost = false; state.isDj = false; state.queue = []; state.participants = []; clearPlaybackSurface();
  if (navigate) activeView('home'); refreshRooms();
}

$('#loginOpen').onclick = () => modalAuth('login'); $('#registerOpen').onclick = () => modalAuth('register');
$('#logoutBtn').onclick = () => { leaveRoom(); state.socket?.disconnect(); state.socket = null; state.socketConfigured = false; state.token = ''; state.user = null; localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); setAuthHeader(); toast('Oturum kapatıldı.'); };
$('#heroCreate').onclick = $('#cardCreate')?.onclick || (() => showModal('createModal')); $('#newRoomSide').onclick = $('#heroCreate').onclick; $('#bottomCreate').onclick = $('#heroCreate').onclick;
$('#heroJoin').onclick = () => showModal('joinModal'); $('#allRooms').onclick = () => { activeView('rooms'); refreshRooms(); }; $('#directoryRefresh').onclick = () => refreshRooms().then(() => toast('Odalar yenilendi.')); $('#directoryCreate').onclick = () => showModal('createModal');
$('#roomFilterQuery').oninput = $('#roomFilterMood').onchange = $('#roomMinListeners').onchange = $('#roomSort').onchange = renderRoomDirectory;
$('#communityRefresh').onclick = () => loadCommunityMembers().then(() => toast('Üye listesi yenilendi.'));
$('#communitySearch').oninput = () => { state.communityPage = 0; clearTimeout(communityMemberTimer); communityMemberTimer = setTimeout(loadCommunityMembers, 220); };
$$('.community-tab').forEach(button => button.onclick = () => selectCommunityTab(button.dataset.communityTab));
$('#communityChatForm').onsubmit = event => { event.preventDefault(); const input = $('#communityChatInput'); const text = input.value.trim(); if (!text) return; state.socket?.emit('community:chat:send', { text }, result => { if (result?.error) toast(result.error); else input.value = ''; }); };
$('#dmChatForm').onsubmit = event => { event.preventDefault(); const input = $('#dmChatInput'); const text = input.value.trim(); if (!text || !state.activeDmFriend) return; state.socket?.emit('dm:send', { friendId: state.activeDmFriend.id, text }, result => { if (result?.error) toast(result.error); else input.value = ''; }); };
$('#createRoomForm').onsubmit = async e => { e.preventDefault(); if (!requireUser()) return; const data = new FormData(e.currentTarget); try { const room = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: data.get('name'), mood: data.get('mood'), visibility: data.get('visibility') }) }); hideModals(); enterRoom(room.roomId); } catch (error) { $('#createError').textContent = error.message; } };
$('#joinForm').onsubmit = e => { e.preventDefault(); let roomId = new FormData(e.currentTarget).get('code').trim(); try { const parsed = new URL(roomId, location.href); roomId = parsed.searchParams.get('room') || parsed.pathname.split('/').filter(Boolean).at(-1) || roomId; } catch {} hideModals(); if (!state.user) { state.pendingRoom = roomId; return modalAuth('login'); } enterRoom(roomId); };
$('#backHome').onclick = () => { leaveRoom(); location.hash = '#home'; }; $('#profileBack').onclick = () => { activeView('home'); location.hash = '#home'; };
async function editCurrentRoom() { if (!state.room || (!state.isHost && !state.user?.isAdmin)) return toast('Odayı yalnızca sahibi düzenleyebilir.'); const name = prompt('Oda adı:', state.room.name || ''); if (name === null) return; const mood = prompt('Oda türü:', state.room.mood || 'Serbest dinleme'); if (mood === null) return; const visibility = confirm('Tamam: herkese açık yap. İptal: özel oda yap.') ? 'public' : 'private'; try { const updated = await api(`/api/rooms/${encodeURIComponent(state.room.roomId)}`, { method: 'PATCH', body: JSON.stringify({ name, mood, visibility }) }); Object.assign(state.room, updated); $('#roomTitle').textContent = state.room.name; $('#roomVisibility').textContent = visibility === 'private' ? 'Özel oda · davetli' : 'Herkese açık'; toast('Oda bilgileri güncellendi.'); } catch (e) { toast(e.message); } }
async function deleteRoom(roomId = state.room?.roomId) { if (!roomId || !confirm('Bu oda ve kuyruğu kalıcı olarak silinsin mi?')) return; try { await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' }); toast('Oda silindi.'); if (state.room?.roomId === roomId) leaveRoom(); refreshRooms(); } catch (e) { toast(e.message); } }
$('#roomMore').onclick = editCurrentRoom; $('#editRoom').onclick = editCurrentRoom; $('#deleteRoom').onclick = () => deleteRoom(); $('#inviteBtn').onclick = $('#roomInviteIcon').onclick = async () => { const url = `${location.origin}/?room=${state.room?.roomId || ''}`; try { await navigator.clipboard.writeText(url); toast('Davet bağlantısı kopyalandı.'); } catch { toast(`Oda kodu: ${state.room?.roomId}`); } }; $('#copyCode').onclick = () => navigator.clipboard.writeText(state.room?.roomId || '').then(() => toast('Oda kodu kopyalandı.')).catch(() => {});
$$('.room-tab').forEach(tab => tab.onclick = () => selectTab(tab.dataset.tab));
$('#chatPanel').insertAdjacentHTML('afterbegin', '<div id="activePoll" class="active-poll hidden"></div><div class="chat-tools"><span>Sohbet odadaki herkese görünür</span><button type="button" class="text-button" id="pollToggle">Anket oluştur</button></div><form id="pollComposer" class="poll-composer hidden"><input name="question" maxlength="120" required placeholder="Anket sorusu" /><div class="poll-choice-inputs"><input name="option" maxlength="50" required placeholder="Seçenek 1" /><input name="option" maxlength="50" required placeholder="Seçenek 2" /></div><input name="option" maxlength="50" placeholder="Seçenek 3 (isteğe bağlı)" /><button class="button button-outline" type="submit">Anketi paylaş</button></form>');
$('#announcementBar').insertAdjacentHTML('afterend', '<div id="playbackGestureNotice" class="playback-gesture-notice hidden" role="status"><span>Bu tarayıcı otomatik oynatmayı engelledi. Ortak şarkı odada çalmaya devam ediyor; bu cihazda dinlemek için etkinleştir.</span><button type="button" class="button button-primary" id="resumeLocalPlayback">Bu cihazda dinle</button></div>');
$('.voice-controls').insertAdjacentHTML('afterend', '<div class="personal-listen-controls"><button type="button" class="button button-outline" id="roomListenToggle"></button><label>Bu cihazdaki oda müziği <input id="listenVolume" type="range" min="0" max="100" value="75" aria-label="Bu cihazdaki oda müziği ses düzeyi" /></label><small>Müzik sessizdeyken oda diğer kişilerde çalmaya devam eder.</small></div>');
$('#resumeLocalPlayback').onclick = resumeLocalPlayback;
$('#pollToggle').onclick = () => { if (!state.room) return; $('#pollComposer').classList.toggle('hidden'); $('#pollComposer').elements.question.focus(); };
$('#pollComposer').onsubmit = e => { e.preventDefault(); const form = e.currentTarget; const options = [...form.querySelectorAll('[name="option"]')].map(input => input.value.trim()).filter(Boolean); state.socket.emit('room:poll:create', { question: form.elements.question.value, options }, result => { if (result?.error) toast(result.error); else { form.reset(); form.classList.add('hidden'); toast('Anket odada paylaşıldı.'); } }); };
$('#chatForm').onsubmit = e => { e.preventDefault(); const text = $('#chatInput').value.trim(); if (text) { state.socket.emit('room:chat', { text }, result => { if (result?.error) toast(result.error); }); $('#chatInput').value = ''; } };
$$('.source-option').forEach(button => button.onclick = () => { state.source = button.dataset.source; $$('.source-option').forEach(b => b.classList.toggle('active', b === button)); $('#trackSearch').placeholder = state.source === 'youtube' ? 'Şarkı veya sanatçı...' : 'Katalogda ara...'; $('#searchResults').innerHTML = '<div class="search-hint">Şarkı adını yazıp sonuçları ara.</div>'; });
$('#searchBtn').onclick = searchTracks; $('#trackSearch').onkeydown = e => { if (e.key === 'Enter') searchTracks(); };
$('#pasteLink').onclick = () => { const value = prompt('YouTube şarkı veya video bağlantısını yapıştır:'); if (!value) return; const id = parseYouTube(value); if (!id) return toast('Geçerli bir YouTube bağlantısı değil.'); const title = prompt('Şarkı adı (isteğe bağlı):') || 'YouTube parçası'; addTrack({ title, artist: 'YouTube', source: 'youtube', videoId: id }); };
$('#playBtn').onclick = togglePlayback; $('#nextBtn').onclick = () => nextTrack(true); $('#prevBtn').onclick = prevTrack; $('#shuffleBtn').onclick = () => { if (!state.isDj) return toast('Yalnızca DJ kuyruğu yönetebilir.'); state.shuffle = !state.shuffle; $('#shuffleBtn').classList.toggle('active', state.shuffle); syncPlayback(!!state.lastPlayback?.playing); toast(state.shuffle ? 'Karıştırma açıldı.' : 'Karıştırma kapatıldı.'); }; $('#repeatBtn').onclick = () => { if (!state.isDj) return toast('Yalnızca DJ kuyruğu yönetebilir.'); state.repeat = ({ off: 'all', all: 'one', one: 'off' })[state.repeat]; updateRepeatButton(); syncPlayback(!!state.lastPlayback?.playing); }; $('#clearQueue').onclick = () => { if (!state.isDj) return toast('Yalnızca DJ kuyruğu yönetebilir.'); state.socket.emit('room:queue:replace', [], result => { if (result?.error) toast(result.error); else toast('Kuyruk temizlendi.'); }); }; $('#micToggle').onclick = toggleMic; $('#cameraToggle').onclick = toggleCamera;
$('#enableRemoteAudio').onclick = async () => { let failed = false; for (const audio of document.querySelectorAll('[data-remote-audio]')) { try { await audio.play(); } catch { failed = true; } } $('#enableRemoteAudio').classList.toggle('hidden', !failed); if (!failed) toast('Karşı tarafın sesi açıldı.'); };
$('#localAudio').ontimeupdate = () => { if (state.queue[state.selectedTrack]?.source === 'library') { const a = $('#localAudio'); $('#currentTime').textContent = fmt(a.currentTime); $('#duration').textContent = fmt(a.duration); $('#seekBar').value = a.duration ? a.currentTime / a.duration * 100 : 0; } };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.room || !state.socket?.connected) return;
  state.socket.emit('room:playback:sync', result => { if (result?.playback) applyPlayback(result.playback, true); });
});
function fmt(value) { if (!Number.isFinite(value)) return '0:00'; return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
setInterval(() => {
  const track = state.lastPlayback?.track || state.queue[state.selectedTrack]; if (!track) return;
  const position = playerPosition(); const duration = roomPlayer.duration();
  $('#currentTime').textContent = fmt(position); $('#duration').textContent = fmt(duration); $('#seekBar').value = duration ? position / duration * 100 : 0;
}, 800);
setInterval(() => { if (state.room && state.socket?.connected && state.lastPlayback?.playing) state.socket.emit('room:listen:heartbeat'); }, 15000);
$('#seekBar').onchange = e => { const track = state.queue[state.selectedTrack]; if (!state.isDj || !track) return; const value = Number(e.target.value) / 100; roomPlayer.seek(value * roomPlayer.duration()); };
$('#volumeRange').oninput = e => { applyLocalMusicVolume(); $('#listenVolume').value = e.target.value; };
$('#volumeRange').value = localStorage.getItem('km_volume') || '75'; $('#listenVolume').value = $('#volumeRange').value; applyLocalMusicVolume(); $('#volumeRange').addEventListener('change', e => localStorage.setItem('km_volume', e.target.value)); $('#listenVolume').oninput = e => { $('#volumeRange').value = e.target.value; $('#volumeRange').dispatchEvent(new Event('input')); localStorage.setItem('km_volume', e.target.value); }; $('#roomListenToggle').onclick = () => { state.localMusicMuted = !state.localMusicMuted; localStorage.setItem('km_music_muted', state.localMusicMuted ? '1' : '0'); applyLocalMusicVolume(); };
$('#volumeBtn').onclick = () => { if (matchMedia('(max-width: 570px)').matches) { document.body.classList.toggle('volume-open'); $('#volumeBtn').setAttribute('aria-pressed', document.body.classList.contains('volume-open')); } else { const range = $('#volumeRange'); range.value = Number(range.value) > 0 ? '0' : (localStorage.getItem('km_volume') || '75'); range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change')); } };
$('#profileOpen').onclick = () => { if (!state.user) return; $('#profileName').textContent = state.user.username; $('#profileUsername').textContent = state.user.username; $('#profileEmail').textContent = state.user.email; $('#profileBio').value = state.user.bio || ''; $('#profileStatus').value = state.user.status || ''; $('#profileGenres').value = (state.user.genres || []).join(', '); $('#profileVisibility').value = state.user.profileVisibility || 'public'; setAvatar($('#profileAvatar'), state.user.avatar, state.user.username); $('.profile-details > div:last-child b').textContent = state.user.isAdmin ? 'Yönetici' : 'Dinleyici'; activeView('profile'); loadProfileActivity(); loadFriends(); };
$('#friendAddForm').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; try { const result = await api('/api/me/friends/request', { method: 'POST', body: JSON.stringify({ username: form.elements.username.value }) }); form.reset(); await loadFriends(); toast(result.accepted ? 'Karşılıklı istek kabul edildi; artık arkadaşsınız.' : 'Arkadaşlık isteği gönderildi.'); } catch (error) { toast(error.message); } };
$('#saveProfile').onclick = async () => { try { const data = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ bio: $('#profileBio').value, status: $('#profileStatus').value, genres: $('#profileGenres').value.split(',').map(value => value.trim()).filter(Boolean), profileVisibility: $('#profileVisibility').value }) }); state.user = data.user; toast('Profil kaydedildi.'); } catch (e) { toast(e.message); } };
$('#playlistCreateForm').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; const name = form.elements.name.value.trim(); if (!name) return; try { await api('/api/me/playlists', { method: 'POST', body: JSON.stringify({ name }) }); const playlistRequest = ++state.playlistRequest; state.playlists = await api('/api/me/playlists'); if (playlistRequest === state.playlistRequest) renderPlaylists(); form.reset(); $('#profilePlaylists').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); toast('Kişisel liste oluşturuldu.'); } catch (error) { toast(error.message); } };
$('#savePlaylistBtn').onclick = async () => { if (!state.user) return modalAuth('login'); if (!state.queue.length) return toast('Kaydedilecek kuyruk boş.'); try { state.playlists = await api('/api/me/playlists'); const names = state.playlists.map((list, index) => `${index + 1}. ${list.name}`).join('\n'); const choice = prompt(`Kuyruğu hangi listeye ekleyelim?\n${names}\n\nListe numarasını yaz:`); if (!choice) return; const list = state.playlists[Number(choice) - 1]; if (!list) return toast('Geçerli bir liste numarası gir.'); const updated = await api(`/api/me/playlists/${encodeURIComponent(list._id || list.id)}`, { method: 'PATCH', body: JSON.stringify({ tracks: [...(list.tracks || []), ...state.queue] }) }); state.playlists = state.playlists.map(item => (item._id || item.id) === (list._id || list.id) ? updated : item); renderPlaylists(); toast('Kuyruk listeye eklendi.'); } catch (error) { toast(error.message); } };
$('#announceBtn').onclick = () => { if (!state.isDj) return toast('Duyuruyu yalnızca oda sahibi veya DJ düzenleyebilir.'); const text = prompt('Oda duyurusu (boş bırakırsan kaldırılır):', state.room?.announcement || ''); if (text === null) return; state.socket.emit('room:announcement', text, result => { if (result?.error) toast(result.error); else toast(text.trim() ? 'Oda duyurusu yayımlandı.' : 'Duyuru kaldırıldı.'); }); };
$('#notificationsOpen').onclick = async () => { await loadNotifications(); showModal('notificationsModal'); try { await api('/api/me/notifications/read', { method: 'POST' }); state.notifications = state.notifications.map(item => ({ ...item, read: true })); renderNotifications(); } catch {} };
$('#avatarUpload').onchange = async e => { const file = e.target.files[0]; if (!file) return; if (file.size > 2e6) return toast('Profil resmi en fazla 2 MB olabilir.'); try { const result = await api('/api/me/avatar', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); state.user.avatar = result.avatar; setAvatar($('#profileAvatar'), result.avatar, state.user.username); setAvatar($('#profileOpen'), result.avatar, state.user.username); toast('Profil resmi kaydedildi.'); } catch (error) { toast(error.message); } };
$('#trackUpload').onchange = e => { const file = e.target.files[0]; if (file) $('#uploadTitle').value = file.name.replace(/\.[^.]+$/, ''); };
$('#uploadTrack').onclick = async () => { const file = $('#trackUpload').files[0]; if (!file) return $('#adminMessage').textContent = 'Önce ses dosyası seçin.'; try { await api(`/api/admin/tracks?title=${encodeURIComponent($('#uploadTitle').value)}&artist=${encodeURIComponent($('#uploadArtist').value)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); $('#adminMessage').textContent = 'Şarkı kataloğa eklendi.'; $('#trackUpload').value = ''; toast('Şarkı yüklendi.'); loadAdminTracks(); } catch (e) { $('#adminMessage').textContent = e.message; } };
function selectAdminView(view) { ['rooms', 'users', 'catalog'].forEach(name => { $(`#admin${name[0].toUpperCase()}${name.slice(1)}Pane`).classList.toggle('hidden', name !== view); $(`[data-admin-view="${name}"]`).classList.toggle('active', name === view); }); if (view === 'users') loadAdminUsers(); if (view === 'catalog') loadAdminTracks(); }
async function loadAdminUsers() { try { const users = await api('/api/admin/users'); $('#adminUsers').innerHTML = users.length ? users.map(user => `<article class="admin-user-row"><span class="admin-user-avatar">${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" />` : escapeHtml(initials(user.username))}</span><div class="admin-user-info"><b>${escapeHtml(user.username)}${user.id === state.user.id ? ' · sen' : ''}</b><span>${escapeHtml(user.email || 'E-posta yok')}</span><small>${user.isAdmin ? 'Yönetici' : 'Üye'} · ${user.createdAt ? new Date(user.createdAt).toLocaleDateString('tr-TR') : 'Tarih yok'}</small></div><button class="button button-outline" data-edit-user="${escapeHtml(user.id)}">Düzenle</button>${user.id !== state.user.id ? `<button class="button button-danger" data-delete-user="${escapeHtml(user.id)}">Sil</button>` : ''}</article>`).join('') : '<p class="admin-empty">Henüz üye yok.</p>'; $$('[data-edit-user]').forEach(button => button.onclick = () => editAdminUser(users.find(user => user.id === button.dataset.editUser))); $$('[data-delete-user]').forEach(button => button.onclick = () => deleteAdminUser(button.dataset.deleteUser)); } catch (error) { $('#adminUsers').textContent = error.message; } }
function editAdminUser(user) { if (!user) return; const form = $('#adminUserForm'); form.elements.id.value = user.id; form.elements.username.value = user.username || ''; form.elements.email.value = user.email || ''; form.elements.bio.value = user.bio || ''; form.elements.password.value = ''; form.elements.isAdmin.checked = !!user.isAdmin; $('#adminUserError').textContent = ''; showModal('adminUserModal'); }
async function deleteAdminUser(id) { if (!confirm('Bu üye hesabı ve açık oturumları silinsin mi? Bu işlem geri alınamaz.')) return; try { await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Üye hesabı silindi.'); loadAdminUsers(); } catch (error) { toast(error.message); } }
async function loadAdminTracks() { try { const tracks = await api('/api/admin/tracks'); $('#adminTracks').innerHTML = tracks.length ? tracks.map(track => `<article class="admin-track-row"><span class="admin-track-icon">♫</span><div><b>${escapeHtml(track.title)}</b><small>${escapeHtml(track.artist || 'Bilinmeyen sanatçı')}</small></div><button class="button button-danger" data-delete-track="${escapeHtml(track.id)}">Sil</button></article>`).join('') : '<p class="admin-empty">Katalog henüz boş.</p>'; $$('[data-delete-track]').forEach(button => button.onclick = async () => { if (!confirm('Bu şarkıyı katalogdan ve kuyruklardan silmek istiyor musun?')) return; try { await api(`/api/admin/tracks/${encodeURIComponent(button.dataset.deleteTrack)}`, { method: 'DELETE' }); toast('Şarkı kaldırıldı.'); loadAdminTracks(); } catch (error) { toast(error.message); } }); } catch (error) { $('#adminTracks').textContent = error.message; } }
async function openAdminPanel() { showModal('adminModal'); selectAdminView('rooms'); try { const data = await api('/api/admin/overview'); $('#adminOverview').innerHTML = [['Üye', data.users], ['Katalog', data.tracks], ['Oda', data.activeRooms], ['Çalınan şarkı', data.plays || 0], ['Toplam dinleme', `${Math.floor((data.listeningSeconds || 0) / 3600)} sa`]].map(([label, value]) => `<div class="admin-stat"><span>${label}</span><b>${value}</b></div>`).join(''); $('#adminRooms').innerHTML = data.recentRooms?.length ? data.recentRooms.map(room => `<article class="admin-room"><div><b>${escapeHtml(room.name || room.roomId)}</b><span>${room.participants} kişi · ${room.queue.length} parça sırada · ${room.visibility === 'private' ? 'Özel' : 'Açık'}</span><small>${room.queue.slice(0, 3).map(t => escapeHtml(t.title)).join(' · ') || 'Kuyruk boş'}</small></div><button class="button button-outline" data-admin-room="${escapeHtml(room.roomId)}">Odayı aç</button><button class="button button-danger" data-admin-delete="${escapeHtml(room.roomId)}">Sil</button></article>`).join('') : '<div class="admin-empty">Henüz oda oluşturulmadı.</div>'; $$('[data-admin-room]').forEach(button => button.onclick = () => { hideModals(); enterRoom(button.dataset.adminRoom); }); $$('[data-admin-delete]').forEach(button => button.onclick = () => deleteRoom(button.dataset.adminDelete)); } catch (e) { $('#adminRooms').textContent = e.message; } }
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
  try { state.user = (await api('/api/me')).user; setAuthHeader(); try { const rtc = await api('/api/rtc/config'); state.iceServers = rtc.iceServers; state.turnConfigured = !!rtc.turnConfigured; } catch {} connectSocket(); toast('Oturum bu sekmede de açıldı.'); }
  catch { state.token = ''; state.user = null; localStorage.removeItem('km_token'); setAuthHeader(); }
});
function routeHash() {
  const route = location.hash.split('/')[0];
  if (route === '#room') { activeView('rooms'); refreshRooms(); }
  else if (route === '#community') { if (!state.user) { state.pendingView = 'community'; return modalAuth('login'); } activeView('community'); selectCommunityTab(state.communityTab || 'members'); }
  else if (route === '#profile') { if (state.user) $('#profileOpen').click(); else { state.pendingView = 'profile'; modalAuth('login'); } }
  else { activeView('home'); }
}
$$('.main-nav .nav-item').forEach(item => item.addEventListener('click', () => { if (location.hash === item.hash) routeHash(); }));
window.addEventListener('hashchange', routeHash);
const queryRoom = new URLSearchParams(location.search).get('room');
bootstrap().then(() => { const roomToRestore = queryRoom || sessionStorage.getItem(ACTIVE_ROOM_KEY); if (roomToRestore && state.user) enterRoom(roomToRestore); else if (roomToRestore) { document.documentElement.classList.remove('room-restoring'); state.pendingRoom = roomToRestore; modalAuth('login'); } else routeHash(); });
