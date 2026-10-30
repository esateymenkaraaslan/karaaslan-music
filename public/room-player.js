/* One room snapshot drives every local player. The server clock is the only playback clock. */
class RoomPlayer {
  constructor({ getRoom, getQueue, getIndex, getRepeat, getShuffle, canControl, onSnapshot, onGesture, onError, onEnded }) {
    this.getRoom = getRoom;
    this.getQueue = getQueue;
    this.getIndex = getIndex;
    this.getRepeat = getRepeat;
    this.getShuffle = getShuffle;
    this.canControl = canControl;
    this.onSnapshot = onSnapshot;
    this.onGesture = onGesture;
    this.onError = onError;
    this.onEnded = onEnded;
    this.socket = null;
    this.roomId = null;
    this.snapshot = null;
    this.revision = 0;
    this.generation = 0;
    this.player = null;
    this.playerReady = false;
    this.pending = null;
    this.loadedTrackId = null;
    this.gestureRequired = false;
    this.apiPromise = null;
    this.clockOffsetMs = 0;
    this.clockSynced = false;
    this.clockSyncPending = false;
    this.onSocketPlayback = playback => this.receive(playback);
    this.onAudioEnded = () => this.onEnded?.();
    this.onPlayerReady = () => { this.playerReady = true; this.applyPending(); };
    this.onPlayerState = event => {
      if (window.YT && event.data === window.YT.PlayerState.ENDED) this.onEnded?.();
    };
    this.onPlayerError = () => this.onError?.('Bu YouTube parçası oynatılamıyor.');
    this.audio = document.querySelector('#localAudio');
    this.placeholder = document.querySelector('#playerPlaceholder');
    this.localStage = document.querySelector('#localStage');
    this.playButton = document.querySelector('#playBtn');
    if (this.audio) this.audio.addEventListener('ended', this.onAudioEnded);
    this.corrector = setInterval(() => this.correctDrift(), 900);
    this.clockSyncTimer = setInterval(() => this.syncClock(), 30000);
  }

  bind(socket) {
    if (this.socket === socket) return;
    if (this.socket) this.socket.off('room:playback', this.onSocketPlayback);
    this.socket = socket;
    this.socket?.on('room:playback', this.onSocketPlayback);
  }

  enter(room) {
    this.roomId = room?.roomId || null;
    this.snapshot = null;
    this.revision = 0;
    this.loadedTrackId = null;
    this.pending = null;
    this.syncClock();
    if (room?.playback?.track) this.receive({ ...room.playback, roomId: this.roomId }, true);
    else this.clear();
  }

  leave() {
    this.roomId = null;
    this.snapshot = null;
    this.revision = 0;
    this.clear();
  }

  receive(playback, force = false) {
    if (!playback || playback.roomId !== this.roomId) return;
    const revision = Number(playback.revision) || 0;
    if (!force && revision <= this.revision) return;
    this.revision = Math.max(this.revision, revision);
    this.snapshot = playback;
    this.onSnapshot?.(playback);
    if (!playback.track) return this.clear();
    const generation = ++this.generation;
    this.pending = { playback, generation };
    if (playback.track.source === 'youtube') this.prepareYoutube(playback, generation);
    else this.prepareLocal(playback, generation);
  }

  command({ playing, position, index = this.getIndex() }) {
    const room = this.getRoom();
    const socket = this.socket;
    const track = this.getQueue()[index];
    if (!room || !socket?.connected || !this.canControl()) {
      this.onError?.('Oda bağlantısı veya DJ yetkisi yok. Yeniden bağlanıp tekrar dene.');
      return;
    }
    if (playing && !track) {
      this.onError?.('Oynatılacak parça bulunamadı. Kuyruk güncellendiğinde tekrar dene.');
      return;
    }
    const roomId = room.roomId;
    socket.emit('room:playback', {
      roomId,
      playing: !!playing,
      position: Math.max(0, Number(position) || 0),
      index: track ? index : null,
      track: track || null,
      repeat: this.getRepeat(),
      shuffle: !!this.getShuffle()
    }, result => {
      if (result?.error) return this.onError?.(result.error);
      if (result?.playback && this.roomId === roomId && (Number(result.playback.revision) || 0) > this.revision) this.receive(result.playback);
    });
  }

  play(index) {
    if (!this.canControl()) return this.onError?.('Yalnızca oda sahibi veya DJ müziği yönetebilir.');
    const track = this.getQueue()[index];
    if (!track) return this.onError?.('Bu parça artık kuyrukta değil.');
    this.command({ playing: true, position: 0, index });
  }

  toggle() {
    if (this.gestureRequired || (!this.canControl() && this.snapshot?.playing)) return this.resumeLocal();
    if (!this.canControl()) return this.onError?.('Oynatmayı oda DJ’i yönetiyor.');
    const playing = !this.snapshot?.playing;
    this.command({ playing, position: this.position() });
  }

  position() {
    const track = this.snapshot?.track;
    if (!track) return 0;
    if (track.source === 'youtube') return Number(this.player?.getCurrentTime?.()) || 0;
    return Number(this.audio?.currentTime) || 0;
  }

  duration() {
    return this.snapshot?.track?.source === 'youtube'
      ? Number(this.player?.getDuration?.()) || 0
      : Number(this.audio?.duration) || 0;
  }

  target(playback = this.snapshot) {
    const position = Math.max(0, Number(playback?.position) || 0);
    const serverTime = Number(playback?.serverTime) || Date.now();
    return position + (playback?.playing ? Math.max(0, (Date.now() + this.clockOffsetMs - serverTime) / 1000) : 0);
  }

  syncClock() {
    if (this.clockSyncPending || !this.roomId || !this.socket?.connected) return;
    const roomId = this.roomId;
    const sentAt = Date.now();
    this.clockSyncPending = true;
    const timeout = setTimeout(() => { this.clockSyncPending = false; }, 5000);
    this.socket.emit('room:playback:sync', result => {
      clearTimeout(timeout);
      this.clockSyncPending = false;
      if (roomId !== this.roomId || !Number.isFinite(Number(result?.serverNow))) return;
      const receivedAt = Date.now();
      const estimate = Number(result.serverNow) - (sentAt + receivedAt) / 2;
      this.clockOffsetMs = this.clockSynced ? this.clockOffsetMs * 0.8 + estimate * 0.2 : estimate;
      this.clockSynced = true;
      if (this.snapshot?.playing) this.receive(this.snapshot, true);
    });
  }

  async prepareYoutube(playback, generation) {
    this.showYoutube();
    try {
      await this.loadYoutubeApi();
      if (generation !== this.generation || !this.roomId) return;
      if (!this.player) {
        this.player = new window.YT.Player('ytPlayer', {
          height: '240', width: '100%',
          playerVars: { playsinline: 1, origin: location.origin, controls: 0, disablekb: 1, rel: 0 },
          events: { onReady: this.onPlayerReady, onStateChange: this.onPlayerState, onError: this.onPlayerError, onAutoplayBlocked: this.requireGesture.bind(this) }
        });
      } else if (this.playerReady) this.applyYoutube(playback, generation);
    } catch (error) {
      if (generation === this.generation) this.onError?.(error.message || 'YouTube oynatıcı yüklenemedi.');
    }
  }

  loadYoutubeApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (this.apiPromise) return this.apiPromise;
    this.apiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.apiPromise = null; reject(new Error('YouTube oynatıcı zamanında yüklenemedi.')); }, 12000);
      const priorReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        try { priorReady?.(); } catch {}
        resolve();
      };
      let script = document.querySelector('#youtube-iframe-api');
      if (!script) {
        script = document.createElement('script');
        script.id = 'youtube-iframe-api';
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => { clearTimeout(timer); this.apiPromise = null; reject(new Error('YouTube oynatıcı yüklenemedi.')); };
        document.head.append(script);
      }
    });
    return this.apiPromise;
  }

  applyPending() {
    const pending = this.pending;
    if (!pending || pending.generation !== this.generation || pending.playback.track?.source !== 'youtube') return;
    this.applyYoutube(pending.playback, pending.generation);
  }

  applyYoutube(playback, generation) {
    if (!this.playerReady || generation !== this.generation || !playback.track) return;
    const track = playback.track;
    const target = this.target(playback);
    try {
      if (this.loadedTrackId !== track.id) {
        this.loadedTrackId = track.id;
        if (playback.playing) this.player.loadVideoById(track.videoId, target);
        else this.player.cueVideoById(track.videoId, target);
      } else {
        const current = Number(this.player.getCurrentTime?.()) || 0;
        if (Math.abs(current - target) > 0.8) this.player.seekTo(target, true);
        if (playback.playing) this.player.playVideo(); else this.player.pauseVideo();
      }
      this.applyVolume();
      this.syncPlayButton(playback.playing);
    } catch { this.onError?.('YouTube oynatımı başlatılamadı.'); }
  }

  async prepareLocal(playback, generation) {
    this.showLocal(playback.track);
    const audio = this.audio;
    if (!audio) return;
    const url = new URL(playback.track.url, location.href).href;
    if (audio.src !== url) {
      audio.src = url;
      try { await this.waitForMetadata(audio); }
      catch (error) { if (generation === this.generation) this.onError?.(error.message); return; }
    }
    if (generation !== this.generation || !this.roomId) return;
    audio.currentTime = this.target(playback);
    this.applyVolume();
    if (playback.playing) {
      try { await audio.play(); this.clearGesture(); }
      catch (error) { if (error.name === 'NotAllowedError') this.requireGesture(); else this.onError?.('Bu cihazda şarkı oynatılamadı.'); }
    } else audio.pause();
    this.syncPlayButton(playback.playing);
  }

  waitForMetadata(audio) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Ses dosyasının bilgileri yüklenemedi.')), 12000);
      const finish = error => {
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      const onReady = () => finish();
      const onError = () => finish(new Error('Ses dosyası bu cihazda açılamadı.'));
      audio.addEventListener('loadedmetadata', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
    });
  }

  correctDrift() {
    const playback = this.snapshot;
    if (!playback?.playing || !playback.track || !this.roomId) return;
    const target = this.target(playback);
    if (playback.track.source === 'youtube') {
      if (!this.playerReady || this.player?.getPlayerState?.() !== window.YT?.PlayerState?.PLAYING) return;
      const current = Number(this.player.getCurrentTime?.()) || 0;
      if (Math.abs(current - target) > 1.1) this.player.seekTo(target, true);
    } else if (this.audio && !this.audio.paused && this.audio.readyState >= 1 && Math.abs(this.audio.currentTime - target) > 1.1) {
      this.audio.currentTime = target;
    }
  }

  resumeLocal() {
    const playback = this.snapshot;
    if (!playback?.track) return;
    const target = this.target(playback);
    if (playback.track.source === 'youtube') {
      if (!this.playerReady || !this.player) return this.onError?.('Oynatıcı hazırlanıyor; birkaç saniye sonra tekrar dokun.');
      this.player.seekTo(target, true);
      this.player.playVideo();
      this.applyVolume();
      this.clearGesture();
    } else if (this.audio) {
      this.audio.currentTime = target;
      this.audio.play().then(() => this.clearGesture()).catch(error => {
        if (error.name === 'NotAllowedError') this.requireGesture();
        else this.onError?.('Bu cihazda şarkı oynatılamadı.');
      });
    }
  }

  seek(position) {
    if (!this.canControl() || !this.snapshot?.track) return;
    this.command({ playing: !!this.snapshot.playing, position });
  }

  showYoutube() {
    this.audio?.pause();
    this.placeholder?.classList.add('hidden');
    this.localStage?.classList.add('hidden');
    document.querySelector('#ytPlayer')?.classList.remove('hidden');
  }

  showLocal(track) {
    this.player?.pauseVideo?.();
    this.placeholder?.classList.add('hidden');
    document.querySelector('#ytPlayer')?.classList.add('hidden');
    this.localStage?.classList.remove('hidden');
    const title = document.querySelector('#localNowTitle');
    const artist = document.querySelector('#localNowArtist');
    if (title) title.textContent = track.title || 'Şarkı';
    if (artist) artist.textContent = track.artist || '';
  }

  clear() {
    this.generation++;
    this.snapshot = null;
    this.pending = null;
    this.loadedTrackId = null;
    this.audio?.pause();
    if (this.audio) { this.audio.removeAttribute('src'); this.audio.load(); }
    this.player?.stopVideo?.();
    this.placeholder?.classList.remove('hidden');
    document.querySelector('#ytPlayer')?.classList.add('hidden');
    this.localStage?.classList.add('hidden');
    const title = document.querySelector('#nowTitle');
    const artist = document.querySelector('#nowArtist');
    if (title) title.textContent = 'Henüz şarkı seçilmedi';
    if (artist) artist.textContent = 'Sıradan bir parça seçerek başlayın';
    this.syncPlayButton(false);
    this.clearGesture();
  }

  applyVolume() {
    const muted = localStorage.getItem('km_music_muted') === '1';
    const volume = muted ? 0 : Number(document.querySelector('#volumeRange')?.value || 75) / 100;
    if (this.audio) this.audio.volume = volume;
    this.player?.setVolume?.(volume * 100);
  }

  syncPlayButton(playing) {
    if (this.playButton) this.playButton.textContent = playing ? 'Ⅱ' : '▶';
  }

  requireGesture() {
    this.gestureRequired = true;
    this.syncPlayButton(false);
    this.onGesture?.(true);
  }

  clearGesture() {
    this.gestureRequired = false;
    this.onGesture?.(false);
  }
}

window.RoomPlayer = RoomPlayer;
