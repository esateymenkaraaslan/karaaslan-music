const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'room-player.js'), 'utf8');

function createPlayer({ localNow = 1000, canControl = false } = {}) {
  const button = { textContent: '' };
  const context = {
    Date: class FakeDate extends Date { static now() { return localNow; } },
    URL,
    location: { href: 'https://karaaslan.example/' },
    window: { YT: { PlayerState: { PLAYING: 1 } } },
    document: { querySelector: selector => selector === '#playBtn' ? button : null },
    localStorage: { getItem: () => null },
    setInterval: () => 1,
    setTimeout: () => 2,
    clearTimeout() {}
  };
  vm.runInNewContext(source, context);
  const player = new context.window.RoomPlayer({
    getRoom: () => ({ roomId: 'room-a' }), getQueue: () => [], getIndex: () => null,
    getRepeat: () => 'off', getShuffle: () => false, canControl: () => canControl
  });
  return { player, button };
}

test('server clock offset aligns devices with different local clocks', () => {
  const { player } = createPlayer({ localNow: 1000 });
  player.roomId = 'room-a';
  player.socket = { connected: true, emit: (_event, acknowledge) => acknowledge({ serverNow: 12000 }) };
  player.syncClock();
  const target = player.target({ position: 40, serverTime: 11750, playing: true });
  assert.ok(Math.abs(target - 40.25) < 0.001);
});

test('listener pause and resume are local and resume at the room live position', () => {
  const { player, button } = createPlayer({ localNow: 1000 });
  const calls = [];
  player.roomId = 'room-a';
  player.clockOffsetMs = 11000;
  player.playerReady = true;
  player.player = {
    pauseVideo: () => calls.push('pause'),
    seekTo: position => calls.push(['seek', position]),
    playVideo: () => calls.push('play'),
    setVolume() {}
  };
  player.snapshot = { roomId: 'room-a', revision: 4, playing: true, position: 40, serverTime: 11750, track: { source: 'youtube', id: 'track-a' } };
  player.toggle();
  assert.equal(player.localPaused, true);
  assert.equal(button.textContent, '▶');
  player.toggle();
  assert.equal(player.localPaused, false);
  assert.deepEqual(calls.map(call => Array.isArray(call) ? call[0] : call), ['pause', 'seek', 'play']);
  assert.ok(Math.abs(calls[1][1] - 40.25) < 0.001);
});

test('a stale room snapshot cannot roll playback back to an older revision', () => {
  const { player } = createPlayer();
  player.roomId = 'room-a';
  player.revision = 8;
  player.snapshot = { roomId: 'room-a', revision: 8, playing: true, track: { id: 'current' } };
  player.resync({ roomId: 'room-a', revision: 7, playing: false, track: null });
  assert.equal(player.snapshot.revision, 8);
  assert.equal(player.snapshot.track.id, 'current');
});

test('a paused listener stays locally paused during an unchanged room resync', () => {
  const { player } = createPlayer();
  player.roomId = 'room-a';
  player.revision = 3;
  player.localPaused = true;
  player.snapshot = { roomId: 'room-a', revision: 3, playing: true, track: { id: 'current' } };
  player.resync({ roomId: 'room-a', revision: 3, playing: true, track: { id: 'current' } });
  assert.equal(player.localPaused, true);
  assert.equal(player.snapshot.revision, 3);
});
