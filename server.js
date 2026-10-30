require('dotenv').config();
require('express-async-errors');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, cors: { origin: false } });
const port = Number(process.env.PORT || 3000);
const secret = process.env.JWT_SECRET;
const mongoUrl = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || 'karaaslan_muzik';
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
let db;
let mediaBucket;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir, { fallthrough: false, maxAge: '1h' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

function tokenFor(user) {
  return jwt.sign({ sub: user._id.toString(), username: user.username, admin: !!user.isAdmin, ver: user.tokenVersion || 0 }, secret, { expiresIn: '7d' });
}
async function auth(req, res, next) {
  const value = req.headers.authorization || '';
  try { const payload = jwt.verify(value.replace(/^Bearer\s+/i, ''), secret); if (!ObjectId.isValid(payload.sub)) throw new Error('Invalid account'); const account = await db.collection('users').findOne({ _id: new ObjectId(payload.sub) }, { projection: { username: 1, isAdmin: 1, tokenVersion: 1 } }); if (!account || (payload.ver || 0) !== (account.tokenVersion || 0)) return res.status(401).json({ error: 'Oturum sona erdi. Yeniden giriş yap.' }); req.user = { ...payload, username: account.username, admin: !!account.isAdmin }; next(); }
  catch { res.status(401).json({ error: 'Oturum açmanız gerekiyor.' }); }
}
function admin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Bu alan yalnızca yöneticiye açık.' });
  next();
}
function publicUser(user) {
  return { id: user._id.toString(), username: user.username, email: user.email, avatar: user.avatar || '', bio: user.bio || '', status: user.status || '', genres: user.genres || [], profileVisibility: user.profileVisibility || 'public', isAdmin: !!user.isAdmin, theme: user.theme || 'dark' };
}
function safeName(name) { return String(name || 'audio').replace(/[^a-z0-9._-]/gi, '_').slice(0, 100); }
function storeMedia(buffer, filename, contentType) {
  return new Promise((resolve, reject) => {
    const stream = mediaBucket.openUploadStream(filename, { metadata: { contentType } });
    stream.once('error', reject);
    stream.once('finish', () => resolve(stream.id));
    stream.end(buffer);
  });
}
async function removeMedia(id) {
  if (ObjectId.isValid(id)) await mediaBucket.delete(new ObjectId(id)).catch(error => { if (error.code !== 26 && error.codeName !== 'FileNotFound') throw error; });
}
async function migrateLegacyMedia() {
  const [tracks, users] = await Promise.all([
    db.collection('tracks').find({ url: /^\/uploads\// }, { projection: { url: 1 } }).toArray(),
    db.collection('users').find({ avatar: /^\/uploads\// }, { projection: { avatar: 1 } }).toArray()
  ]);
  const urls = [...new Set([...tracks.map(item => item.url), ...users.map(item => item.avatar)])];
  const moved = new Map();
  const contentTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };
  for (const url of urls) {
    const filename = safeName(path.basename(url)); const location = path.join(uploadDir, filename);
    if (!fs.existsSync(location)) continue;
    const contentType = contentTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    const id = await storeMedia(fs.readFileSync(location), filename, contentType);
    moved.set(url, `/media/${id.toString()}`);
  }
  for (const [url, nextUrl] of moved) {
    await Promise.all([
      db.collection('tracks').updateMany({ url }, { $set: { url: nextUrl } }),
      db.collection('users').updateMany({ avatar: url }, { $set: { avatar: nextUrl } }),
      db.collection('users').updateMany({ 'recentTracks.url': url }, { $set: { 'recentTracks.$[track].url': nextUrl } }, { arrayFilters: [{ 'track.url': url }] }),
      db.collection('rooms').updateMany({ 'queue.url': url }, { $set: { 'queue.$[track].url': nextUrl } }, { arrayFilters: [{ 'track.url': url }] }),
      db.collection('rooms').updateMany({ 'history.url': url }, { $set: { 'history.$[track].url': nextUrl } }, { arrayFilters: [{ 'track.url': url }] }),
      db.collection('rooms').updateMany({ 'playback.track.url': url }, { $set: { 'playback.track.url': nextUrl } }),
      db.collection('playlists').updateMany({ 'tracks.url': url }, { $set: { 'tracks.$[track].url': nextUrl } }, { arrayFilters: [{ 'track.url': url }] })
    ]);
  }
  if (moved.size) console.log(`Migrated ${moved.size} legacy upload(s) into MongoDB GridFS.`);
}
async function notifyUser(userId, type, title, message, roomId = '', metadata = {}) {
  if (!userId) return;
  const notification = { userId: String(userId), type, title: String(title).slice(0, 80), message: String(message).slice(0, 180), roomId, metadata, read: false, createdAt: new Date() };
  const result = await db.collection('notifications').insertOne(notification); notification.id = result.insertedId.toString();
  for (const socket of io.of('/').sockets.values()) if (socket.user?.sub === String(userId)) socket.emit('notification:new', notification);
}
function directRoomId(first, second) { return `dm:${[String(first), String(second)].sort().join(':')}`; }
async function areFriends(firstId, secondId) {
  if (!ObjectId.isValid(firstId) || !ObjectId.isValid(secondId) || firstId === secondId) return false;
  const [first, second] = await Promise.all([
    db.collection('users').findOne({ _id: new ObjectId(firstId) }, { projection: { friends: 1 } }),
    db.collection('users').findOne({ _id: new ObjectId(secondId) }, { projection: { friends: 1 } })
  ]);
  return (first?.friends || []).includes(secondId) && (second?.friends || []).includes(firstId);
}

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3–24 karakter olmalı; harf, rakam ve _ kullanılabilir.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
  if (password.length < 8) return res.status(400).json({ error: 'Şifre en az 8 karakter olmalı.' });
  try {
    const user = { username, email, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date(), theme: 'dark', isAdmin: false };
    const result = await db.collection('users').insertOne(user); user._id = result.insertedId;
    res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) { res.status(e.code === 11000 ? 409 : 500).json({ error: e.code === 11000 ? 'Bu kullanıcı adı veya e-posta zaten kullanılıyor.' : 'Kayıt tamamlanamadı.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body.username || '').trim();
  const user = await db.collection('users').findOne({ username: { $regex: `^${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  res.json({ token: tokenFor(user), user: publicUser(user) });
});
app.get('/api/me', auth, async (req, res) => {
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { passwordHash: 0 } });
  if (!user) return res.status(401).json({ error: 'Hesap bulunamadı.' });
  res.json({ user: { ...publicUser(user), favoriteRooms: user.favoriteRooms || [] } });
});
app.patch('/api/me', auth, async (req, res) => {
  const updates = {};
  if (typeof req.body.bio === 'string') updates.bio = req.body.bio.slice(0, 160);
  if (['dark', 'light'].includes(req.body.theme)) updates.theme = req.body.theme;
  if (typeof req.body.status === 'string') updates.status = req.body.status.trim().slice(0, 80);
  if (Array.isArray(req.body.genres)) updates.genres = [...new Set(req.body.genres.map(value => String(value).trim().slice(0, 30)).filter(Boolean))].slice(0, 8);
  if (['public', 'private'].includes(req.body.profileVisibility)) updates.profileVisibility = req.body.profileVisibility;
  await db.collection('users').updateOne({ _id: new ObjectId(req.user.sub) }, { $set: updates });
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { passwordHash: 0 } });
  res.json({ user: { ...publicUser(user), favoriteRooms: user.favoriteRooms || [] } });
});
app.get('/api/rtc/config', auth, (_req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) iceServers.push({ urls: process.env.TURN_URL.split(',').map(value => value.trim()).filter(Boolean), username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  res.json({ iceServers, turnConfigured: iceServers.length > 1 });
});
app.get('/api/me/activity', auth, async (req, res) => {
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { musicStats: 1, recentTracks: 1, recentRooms: 1, favoriteRooms: 1 } });
  res.json({ stats: user?.musicStats || { plays: 0, seconds: 0 }, recentTracks: user?.recentTracks || [], recentRooms: user?.recentRooms || [], favoriteRooms: user?.favoriteRooms || [] });
});
app.get('/api/users/:username', async (req, res) => {
  const username = String(req.params.username || '').slice(0, 24); const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const user = await db.collection('users').findOne({ username: { $regex: `^${escaped}$`, $options: 'i' } }, { projection: { username: 1, avatar: 1, bio: 1, status: 1, genres: 1, friends: 1, profileVisibility: 1, musicStats: 1 } });
  if (!user || user.profileVisibility === 'private') return res.status(404).json({ error: 'Bu profil gizli veya bulunamadı.' });
  res.json({ username: user.username, avatar: user.avatar || '', bio: user.bio || '', status: user.status || '', genres: user.genres || [], friendCount: (user.friends || []).length, stats: { plays: user.musicStats?.plays || 0, seconds: user.musicStats?.seconds || 0 } });
});
app.get('/api/me/rooms', auth, async (req, res) => {
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { recentRooms: 1, favoriteRooms: 1 } });
  const ids = [...new Set([...(user?.favoriteRooms || []), ...(user?.recentRooms || []).map(room => room.roomId)])].slice(0, 60);
  const rooms = await db.collection('rooms').find({ $or: [{ hostId: req.user.sub }, ...(ids.length ? [{ roomId: { $in: ids } }] : [])] }).sort({ createdAt: -1 }).limit(60).toArray();
  res.json(rooms.map(room => ({ roomId: room.roomId, name: room.name, mood: room.mood, visibility: room.visibility || 'public', hostId: room.hostId, hostName: room.hostName || '', queueCount: (room.queue || []).length, participants: roomState.get(room.roomId)?.size || 0, favorite: (user?.favoriteRooms || []).includes(room.roomId) })));
});
app.get('/api/me/friends', auth, async (req, res) => {
  const id = new ObjectId(req.user.sub);
  const user = await db.collection('users').findOne({ _id: id }, { projection: { friends: 1 } });
  const friendIds = (user?.friends || []).filter(ObjectId.isValid).map(value => new ObjectId(value));
  const [friends, incoming, outgoing] = await Promise.all([
    friendIds.length ? db.collection('users').find({ _id: { $in: friendIds } }, { projection: { username: 1, avatar: 1, status: 1 } }).toArray() : [],
    db.collection('friendRequests').find({ to: req.user.sub, status: 'pending' }).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection('friendRequests').find({ from: req.user.sub, status: 'pending' }).sort({ createdAt: -1 }).limit(50).toArray()
  ]);
  const requestUserIds = [...new Set([...incoming.map(item => item.from), ...outgoing.map(item => item.to)])].filter(ObjectId.isValid).map(value => new ObjectId(value));
  const people = requestUserIds.length ? await db.collection('users').find({ _id: { $in: requestUserIds } }, { projection: { username: 1, avatar: 1 } }).toArray() : [];
  const names = new Map(people.map(person => [person._id.toString(), { username: person.username, avatar: person.avatar || '' }]));
  const online = new Set([...io.of('/').sockets.values()].map(socket => socket.user?.sub));
  res.json({ friends: friends.map(person => ({ id: person._id.toString(), username: person.username, avatar: person.avatar || '', status: person.status || '', online: online.has(person._id.toString()) })), incoming: incoming.map(item => ({ id: item._id.toString(), from: item.from, ...names.get(item.from) })), outgoing: outgoing.map(item => ({ id: item._id.toString(), to: item.to, ...names.get(item.to) })) });
});
app.post('/api/me/friends/request', auth, async (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 24);
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = await db.collection('users').findOne({ username: { $regex: `^${escaped}$`, $options: 'i' } }, { projection: { username: 1, avatar: 1, friends: 1 } });
  if (!target) return res.status(404).json({ error: 'Bu kullanıcı bulunamadı.' });
  const from = req.user.sub; const to = target._id.toString();
  if (from === to) return res.status(400).json({ error: 'Kendine arkadaşlık isteği gönderemezsin.' });
  if ((target.friends || []).includes(from)) return res.status(409).json({ error: 'Bu kullanıcı zaten arkadaşın.' });
  const reverse = await db.collection('friendRequests').findOne({ from: to, to: from, status: 'pending' });
  if (reverse) {
    await db.collection('friendRequests').updateOne({ _id: reverse._id }, { $set: { status: 'accepted', resolvedAt: new Date() } });
    await Promise.all([db.collection('users').updateOne({ _id: new ObjectId(from) }, { $addToSet: { friends: to } }), db.collection('users').updateOne({ _id: target._id }, { $addToSet: { friends: from } })]);
    await notifyUser(to, 'friend-accepted', 'Arkadaşlık isteği kabul edildi', `${req.user.username} ile artık arkadaşsınız.`);
    return res.json({ ok: true, accepted: true });
  }
  const existing = await db.collection('friendRequests').findOne({ from, to, status: 'pending' });
  if (existing) return res.json({ ok: true, pending: true });
  const requestResult = await db.collection('friendRequests').insertOne({ from, to, status: 'pending', createdAt: new Date() });
  await notifyUser(to, 'friend-request', 'Yeni arkadaşlık isteği', `${req.user.username} seninle arkadaş olmak istiyor.`, '', { friendRequestId: requestResult.insertedId.toString() });
  res.status(201).json({ ok: true, pending: true });
});
app.post('/api/me/friends/requests/:id', auth, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'İstek kimliği geçersiz.' });
  const request = await db.collection('friendRequests').findOne({ _id: new ObjectId(req.params.id), to: req.user.sub, status: 'pending' });
  if (!request) return res.status(404).json({ error: 'Bekleyen istek bulunamadı.' });
  if (req.body.accept === true) {
    await db.collection('friendRequests').updateOne({ _id: request._id }, { $set: { status: 'accepted', resolvedAt: new Date() } });
    await Promise.all([db.collection('users').updateOne({ _id: new ObjectId(request.from) }, { $addToSet: { friends: req.user.sub } }), db.collection('users').updateOne({ _id: new ObjectId(req.user.sub) }, { $addToSet: { friends: request.from } })]);
    await notifyUser(request.from, 'friend-accepted', 'Arkadaşlık isteği kabul edildi', `${req.user.username} arkadaşlık isteğini kabul etti.`);
  } else await db.collection('friendRequests').updateOne({ _id: request._id }, { $set: { status: 'rejected', resolvedAt: new Date() } });
  res.json({ ok: true });
});
app.delete('/api/me/friends/:id', auth, async (req, res) => {
  if (!ObjectId.isValid(req.params.id) || req.params.id === req.user.sub) return res.status(400).json({ error: 'Arkadaş kimliği geçersiz.' });
  await Promise.all([db.collection('users').updateOne({ _id: new ObjectId(req.user.sub) }, { $pull: { friends: req.params.id } }), db.collection('users').updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { friends: req.user.sub } })]);
  res.json({ ok: true });
});
app.get('/api/community/members', auth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const page = Math.max(0, Math.min(10000, Number.parseInt(req.query.page, 10) || 0)); const pageSize = 50;
  const memberFilter = { _id: { $ne: new ObjectId(req.user.sub) }, ...(q ? { username: { $regex: escaped, $options: 'i' } } : {}) };
  const [me, requests] = await Promise.all([
    db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { friends: 1 } }),
    db.collection('friendRequests').find({ $or: [{ from: req.user.sub }, { to: req.user.sub }], status: 'pending' }, { projection: { from: 1, to: 1 } }).toArray()
  ]);
  const [people, total] = await Promise.all([
    db.collection('users').find(memberFilter, { projection: { username: 1, avatar: 1, status: 1, profileVisibility: 1 } }).sort({ username: 1 }).skip(page * pageSize).limit(pageSize).toArray(),
    db.collection('users').countDocuments(memberFilter)
  ]);
  const online = new Set([...io.of('/').sockets.values()].map(socket => socket.user?.sub)); const friends = new Set(me?.friends || []);
  res.json({ members: people.map(person => {
    const id = person._id.toString();
    const request = requests.find(item => item.from === req.user.sub && item.to === id || item.from === id && item.to === req.user.sub);
    return { id, username: person.username, avatar: person.avatar || '', status: person.status || '', online: online.has(id), isFriend: friends.has(id), requestSent: request?.from === req.user.sub, requestReceived: request?.to === req.user.sub, requestId: request?._id?.toString() || '' };
  }), total, page, pages: Math.ceil(total / pageSize) });
});
app.get('/api/me/dms/:friendId', auth, async (req, res) => {
  const friendId = String(req.params.friendId || '');
  if (!(await areFriends(req.user.sub, friendId))) return res.status(403).json({ error: 'Özel mesajlar yalnızca arkadaşlar arasında kullanılabilir.' });
  const messages = await db.collection('directMessages').find({ $or: [{ fromId: req.user.sub, toId: friendId }, { fromId: friendId, toId: req.user.sub }] }).sort({ createdAt: -1 }).limit(100).toArray();
  const senderIds = [...new Set(messages.map(item => item.fromId))].filter(ObjectId.isValid).map(value => new ObjectId(value));
  const senders = senderIds.length ? await db.collection('users').find({ _id: { $in: senderIds } }, { projection: { username: 1, avatar: 1 } }).toArray() : [];
  const senderDetails = new Map(senders.map(person => [person._id.toString(), { username: person.username, avatar: person.avatar || '' }]));
  res.json(messages.reverse().map(item => ({ id: item._id.toString(), fromId: item.fromId, fromUsername: senderDetails.get(item.fromId)?.username || '', avatar: senderDetails.get(item.fromId)?.avatar || '', text: item.text, createdAt: item.createdAt })));
});
app.post('/api/rooms/:roomId/invite-friend', auth, async (req, res) => {
  const roomId = String(req.params.roomId || '').slice(0, 40); const friendId = String(req.body.friendId || '');
  if (!ObjectId.isValid(friendId)) return res.status(400).json({ error: 'Arkadaş seçimi geçersiz.' });
  const [room, me, friend] = await Promise.all([db.collection('rooms').findOne({ roomId }), db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { friends: 1 } }), db.collection('users').findOne({ _id: new ObjectId(friendId) }, { projection: { friends: 1 } })]);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });
  if (!(me?.friends || []).includes(friendId) || !(friend?.friends || []).includes(req.user.sub)) return res.status(403).json({ error: 'Bu kullanıcı arkadaş listenizde değil.' });
  await notifyUser(friendId, 'room-invite', 'Dinleme odasına davet', `${req.user.username} seni “${room.name}” odasına davet etti.`, roomId);
  res.json({ ok: true });
});
app.put('/api/me/favorites/rooms/:roomId', auth, async (req, res) => {
  const roomId = String(req.params.roomId || '').slice(0, 40); const room = await db.collection('rooms').findOne({ roomId });
  if (!room || room.visibility === 'private') return res.status(404).json({ error: 'Favorilere eklenebilecek oda bulunamadı.' });
  const userId = new ObjectId(req.user.sub); const favorite = req.body.favorite !== false;
  await db.collection('users').updateOne({ _id: userId }, favorite ? { $addToSet: { favoriteRooms: roomId } } : { $pull: { favoriteRooms: roomId } });
  res.json({ roomId, favorite });
});
app.get('/api/me/playlists', auth, async (req, res) => res.json(await db.collection('playlists').find({ userId: req.user.sub }).sort({ updatedAt: -1 }).limit(50).toArray()));
app.post('/api/me/playlists', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50); if (name.length < 2) return res.status(400).json({ error: 'Liste adı en az 2 karakter olmalı.' });
  const playlist = { userId: req.user.sub, name, tracks: [], createdAt: new Date(), updatedAt: new Date() }; const result = await db.collection('playlists').insertOne(playlist);
  res.status(201).json({ ...playlist, id: result.insertedId.toString() });
});
app.patch('/api/me/playlists/:id', auth, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Liste kimliği geçersiz.' });
  const id = new ObjectId(req.params.id); const playlist = await db.collection('playlists').findOne({ _id: id, userId: req.user.sub });
  if (!playlist) return res.status(404).json({ error: 'Liste bulunamadı.' });
  const tracks = Array.isArray(req.body.tracks) ? req.body.tracks.slice(0, 100).map(track => ({ id: String(track.id || crypto.randomUUID()).slice(0, 40), title: String(track.title || '').slice(0, 120), artist: String(track.artist || '').slice(0, 120), source: track.source === 'youtube' ? 'youtube' : 'library', videoId: String(track.videoId || '').slice(0, 32), url: String(track.url || '').slice(0, 500) })).filter(track => track.title && (track.source === 'youtube' ? track.videoId : track.url)) : playlist.tracks;
  const updates = { tracks, updatedAt: new Date() }; if (typeof req.body.name === 'string') updates.name = req.body.name.trim().slice(0, 50);
  await db.collection('playlists').updateOne({ _id: id, userId: req.user.sub }, { $set: updates }); res.json({ ...playlist, ...updates, id: id.toString() });
});
app.delete('/api/me/playlists/:id', auth, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Liste kimliği geçersiz.' });
  const result = await db.collection('playlists').deleteOne({ _id: new ObjectId(req.params.id), userId: req.user.sub });
  if (!result.deletedCount) return res.status(404).json({ error: 'Liste bulunamadı.' }); res.json({ ok: true });
});
app.get('/api/me/notifications', auth, async (req, res) => {
  const items = await db.collection('notifications').find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(items.map(({ _id, ...item }) => ({ ...item, id: _id.toString() })));
});
app.post('/api/me/notifications/read', auth, async (req, res) => { await db.collection('notifications').updateMany({ userId: req.user.sub, read: false }, { $set: { read: true } }); res.json({ ok: true }); });
app.post('/api/me/avatar', auth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '2mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Profil resmi gönderilmedi.' });
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[req.headers['content-type']];
  if (!ext) return res.status(415).json({ error: 'Desteklenmeyen resim biçimi.' });
  const id = await storeMedia(req.body, `${crypto.randomUUID()}${ext}`, req.headers['content-type']);
  const avatar = `/media/${id.toString()}`;
  const current = await db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { avatar: 1 } });
  await db.collection('users').updateOne({ _id: new ObjectId(req.user.sub) }, { $set: { avatar } });
  if (current?.avatar && current.avatar !== avatar && current.avatar.startsWith('/media/')) await removeMedia(current.avatar.slice('/media/'.length)).catch(error => console.error('Old avatar cleanup failed:', error.message));
  res.json({ avatar });
});
app.get('/media/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(404).end();
  const id = new ObjectId(req.params.id); const file = await mediaBucket.find({ _id: id }).next();
  if (!file) return res.status(404).end();
  res.set('Content-Type', file.metadata?.contentType || 'application/octet-stream');
  res.set('Content-Length', String(file.length));
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  mediaBucket.openDownloadStream(id).on('error', error => { if (!res.headersSent) res.status(404).end(); else res.destroy(error); }).pipe(res);
});
app.get('/api/catalog', async (_req, res) => res.json(await db.collection('tracks').find({}).sort({ createdAt: -1 }).limit(500).toArray()));
async function getPublicRoomSnapshot() {
  const rooms = await db.collection('rooms').find({ $or: [{ visibility: 'public' }, { visibility: { $exists: false } }] }).sort({ createdAt: -1 }).limit(100).toArray();
  return rooms.map(r => ({ roomId: r.roomId, name: r.name, mood: r.mood, visibility: r.visibility || 'public', hostId: r.hostId, hostName: r.hostName || '', nowPlaying: r.playback?.track?.title || '', queueCount: (r.queue || []).length, participants: roomState.get(r.roomId)?.size || 0, createdAt: r.createdAt }));
}
app.get('/api/rooms', async (_req, res) => {
  res.json(await getPublicRoomSnapshot());
});
app.post('/api/rooms', auth, async (req, res) => {
  const roomId = crypto.randomBytes(8).toString('hex');
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (name.length < 2) return res.status(400).json({ error: 'Oda adı en az 2 karakter olmalı.' });
  const mood = String(req.body.mood || 'Serbest dinleme').slice(0, 30);
  const visibility = req.body.visibility === 'private' ? 'private' : 'public';
  const room = { roomId, name, mood, visibility, hostId: req.user.sub, hostName: req.user.username, djIds: [], queue: [], playback: { playing: false, position: 0, updatedAt: new Date(), repeat: 'off' }, history: [], requests: [], announcement: '', statistics: { plays: 0, seconds: 0 }, createdAt: new Date() };
  await db.collection('rooms').insertOne(room);
  scheduleRoomsUpdate();
  res.status(201).json({ roomId, name, mood, visibility, hostId: room.hostId, queueCount: 0, participants: 0 });
});
app.patch('/api/rooms/:roomId', auth, async (req, res) => {
  const roomId = String(req.params.roomId || '').slice(0, 40);
  const room = await db.collection('rooms').findOne({ roomId });
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });
  if (room.hostId !== req.user.sub && !req.user.admin) return res.status(403).json({ error: 'Bu odayı yalnızca sahibi düzenleyebilir.' });
  const updates = {};
  if (typeof req.body.name === 'string') { const name = req.body.name.trim().slice(0, 50); if (name.length < 2) return res.status(400).json({ error: 'Oda adı en az 2 karakter olmalı.' }); updates.name = name; }
  if (typeof req.body.mood === 'string') updates.mood = req.body.mood.trim().slice(0, 30);
  if (['public', 'private'].includes(req.body.visibility)) updates.visibility = req.body.visibility;
  await db.collection('rooms').updateOne({ roomId }, { $set: updates });
  io.to(roomId).emit('room:details', { roomId, ...updates }); scheduleRoomsUpdate(); res.json({ roomId, ...updates });
});
app.delete('/api/rooms/:roomId', auth, async (req, res) => {
  const roomId = String(req.params.roomId || '').slice(0, 40);
  const room = await db.collection('rooms').findOne({ roomId });
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });
  if (room.hostId !== req.user.sub && !req.user.admin) return res.status(403).json({ error: 'Bu odayı yalnızca sahibi silebilir.' });
  await db.collection('rooms').deleteOne({ roomId });
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) { const member = io.sockets.sockets.get(socketId); member?.emit('room:closed', { roomId }); member?.leave(roomId); if (member) { member.data.roomId = null; member.data.participant = null; } }
  roomState.delete(roomId); roomPlaybackControlAt.delete(roomId); roomListenStatsAt.delete(roomId); scheduleRoomsUpdate(); res.json({ ok: true });
});
app.get('/api/youtube/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ items: [] });
  if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube araması için YOUTUBE_API_KEY yapılandırılmalı.' });
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '8', q });
    const response = await fetch(url, { headers: { 'X-Goog-Api-Key': process.env.YOUTUBE_API_KEY } });
    const body = await response.json();
    if (!response.ok) return res.status(502).json({ error: body.error?.message || 'YouTube araması başarısız oldu.' });
    res.json({ items: (body.items || []).map(x => ({ id: x.id.videoId, title: x.snippet.title, artist: x.snippet.channelTitle, thumbnail: x.snippet.thumbnails?.medium?.url, source: 'youtube' })) });
  } catch { res.status(502).json({ error: 'YouTube servisine ulaşılamadı.' }); }
});
app.get('/api/admin/overview', auth, admin, async (_req, res) => {
  const [users, tracks, rooms] = await Promise.all([db.collection('users').countDocuments(), db.collection('tracks').countDocuments(), db.collection('rooms').countDocuments()]);
  const listening = await db.collection('rooms').aggregate([{ $group: { _id: null, plays: { $sum: '$statistics.plays' }, seconds: { $sum: '$statistics.seconds' } } }]).next();
  const recentRooms = await db.collection('rooms').find({}).sort({ createdAt: -1 }).limit(12).toArray();
  res.json({ users, tracks, activeRooms: rooms, plays: listening?.plays || 0, listeningSeconds: listening?.seconds || 0, recentTracks: await db.collection('tracks').find({}).sort({ createdAt: -1 }).limit(8).toArray(), recentRooms: recentRooms.map(r => ({ roomId: r.roomId, name: r.name, hostName: r.hostName, mood: r.mood, visibility: r.visibility || 'public', queue: r.queue || [], participants: roomState.get(r.roomId)?.size || 0 })) });
});
app.get('/api/admin/users', auth, admin, async (_req, res) => {
  const users = await db.collection('users').find({}, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).limit(300).toArray();
  res.json(users.map(user => ({ ...publicUser(user), createdAt: user.createdAt || null })));
});
app.patch('/api/admin/users/:id', auth, admin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Hesap kimliği geçersiz.' });
  const id = new ObjectId(req.params.id); const current = await db.collection('users').findOne({ _id: id });
  if (!current) return res.status(404).json({ error: 'Hesap bulunamadı.' });
  const updates = {};
  if (typeof req.body.username === 'string') { const username = req.body.username.trim(); if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3–24 karakter olmalı; harf, rakam ve _ kullanılabilir.' }); updates.username = username; }
  if (typeof req.body.email === 'string') { const email = req.body.email.trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' }); updates.email = email; }
  if (typeof req.body.bio === 'string') updates.bio = req.body.bio.slice(0, 160);
  if (typeof req.body.isAdmin === 'boolean') {
    if (current.isAdmin && !req.body.isAdmin && await db.collection('users').countDocuments({ isAdmin: true }) <= 1) return res.status(409).json({ error: 'Son yönetici hesabının yetkisi kaldırılamaz.' });
    updates.isAdmin = req.body.isAdmin;
  }
  if (typeof req.body.password === 'string' && req.body.password) { if (req.body.password.length < 8) return res.status(400).json({ error: 'Yeni şifre en az 8 karakter olmalı.' }); updates.passwordHash = await bcrypt.hash(req.body.password, 12); updates.tokenVersion = (current.tokenVersion || 0) + 1; }
  try { await db.collection('users').updateOne({ _id: id }, { $set: updates }); }
  catch (error) { if (error.code === 11000) return res.status(409).json({ error: 'Bu kullanıcı adı veya e-posta başka hesapta kullanılıyor.' }); throw error; }
  if (updates.passwordHash) { for (const socket of io.of('/').sockets.values()) if (socket.user.sub === id.toString()) { socket.emit('auth:revoked'); socket.disconnect(true); } }
  else if (updates.isAdmin !== undefined || updates.username) { for (const socket of io.of('/').sockets.values()) if (socket.user.sub === id.toString()) socket.disconnect(true); }
  const updated = await db.collection('users').findOne({ _id: id }); res.json({ user: publicUser(updated) });
});
app.delete('/api/admin/users/:id', auth, admin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Hesap kimliği geçersiz.' });
  const id = new ObjectId(req.params.id); const user = await db.collection('users').findOne({ _id: id });
  if (!user) return res.status(404).json({ error: 'Hesap bulunamadı.' });
  if (id.toString() === req.user.sub) return res.status(400).json({ error: 'Kendi yönetici hesabını bu panelden silemezsin.' });
  if (user.isAdmin && await db.collection('users').countDocuments({ isAdmin: true }) <= 1) return res.status(409).json({ error: 'Son yönetici hesabı silinemez.' });
  const ownedRooms = await db.collection('rooms').find({ hostId: id.toString() }).toArray();
  await db.collection('users').deleteOne({ _id: id });
  for (const socket of io.of('/').sockets.values()) if (socket.user.sub === id.toString()) { socket.emit('auth:revoked'); socket.disconnect(true); }
  await db.collection('rooms').updateMany({ hostId: id.toString() }, { $set: { hostId: req.user.sub, hostName: req.user.username } });
  for (const room of ownedRooms) for (const [socketId, participant] of roomState.get(room.roomId) || []) io.to(socketId).emit('room:host', { roomId: room.roomId, hostId: req.user.sub, hostName: req.user.username, isHost: false, isDj: participant.isDj });
  scheduleRoomsUpdate();
  if (user.avatar?.startsWith('/media/')) await removeMedia(user.avatar.slice('/media/'.length)).catch(error => console.error('Deleted user avatar cleanup failed:', error.message));
  res.json({ ok: true });
});
app.get('/api/admin/tracks', auth, admin, async (_req, res) => {
  const tracks = await db.collection('tracks').find({}).sort({ createdAt: -1 }).limit(300).toArray();
  res.json(tracks.map(track => ({ ...track, id: track._id.toString(), _id: undefined })));
});
app.delete('/api/admin/tracks/:id', auth, admin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Şarkı kimliği geçersiz.' });
  const id = new ObjectId(req.params.id); const track = await db.collection('tracks').findOne({ _id: id });
  if (!track) return res.status(404).json({ error: 'Şarkı bulunamadı.' });
  await db.collection('tracks').deleteOne({ _id: id });
  if (typeof track.url === 'string' && track.url.startsWith('/uploads/')) { const filename = path.basename(track.url); try { fs.unlinkSync(path.join(uploadDir, filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (typeof track.url === 'string' && track.url.startsWith('/media/')) await removeMedia(track.url.slice('/media/'.length)).catch(error => console.error('Deleted track media cleanup failed:', error.message));
  if (track.url) {
    const rooms = await db.collection('rooms').find({ 'queue.url': track.url }).toArray();
    for (const room of rooms) { const queue = (room.queue || []).filter(item => item.url !== track.url); await db.collection('rooms').updateOne({ roomId: room.roomId }, { $set: { queue } }); io.to(room.roomId).emit('room:queue', { roomId: room.roomId, queue }); }
    const playingIn = await db.collection('rooms').find({ 'playback.track.url': track.url }).toArray();
    for (const room of playingIn) { const playback = { ...(room.playback || {}), roomId: room.roomId, revision: (room.playback?.revision || 0) + 1, playing: false, position: 0, index: null, track: null, updatedAt: new Date(), serverTime: Date.now() }; await db.collection('rooms').updateOne({ roomId: room.roomId }, { $set: { playback } }); io.to(room.roomId).emit('room:playback', playback); }
  }
  io.emit('catalog:update');
  res.json({ ok: true });
});
app.post('/api/admin/tracks', auth, admin, express.raw({ type: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/flac', 'audio/x-flac'], limit: '30mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Ses dosyası gönderilmedi.' });
  const mime = req.headers['content-type'];
  const ext = ({ 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/x-aac': '.aac', 'audio/flac': '.flac', 'audio/x-flac': '.flac' })[mime];
  if (!ext) return res.status(415).json({ error: 'Desteklenmeyen ses biçimi.' });
  const id = await storeMedia(req.body, `${crypto.randomUUID()}${ext}`, mime);
  const track = { title: String(req.query.title || 'İsimsiz şarkı').slice(0, 120), artist: String(req.query.artist || 'Bilinmeyen sanatçı').slice(0, 120), source: 'library', url: `/media/${id.toString()}`, createdAt: new Date() };
  const result = await db.collection('tracks').insertOne(track); io.emit('catalog:update'); res.status(201).json({ ...track, id: result.insertedId.toString() });
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const roomState = new Map();
const roomPlaybackControlAt = new Map();
const roomWriteQueues = new Map();
const roomJoinQueues = new Map();
const roomListenStatsAt = new Map();
let roomsUpdateTimer;
function scheduleRoomsUpdate() {
  clearTimeout(roomsUpdateTimer);
  roomsUpdateTimer = setTimeout(async () => {
    roomsUpdateTimer = null;
    try { io.emit('rooms:update', await getPublicRoomSnapshot()); }
    catch (error) { console.error('Room directory update failed:', error.message); }
  }, 180);
}
function queueRoomJoin(roomId, work) {
  const previous = roomJoinQueues.get(roomId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  roomJoinQueues.set(roomId, current);
  current.finally(() => { if (roomJoinQueues.get(roomId) === current) roomJoinQueues.delete(roomId); }).catch(() => {});
  return current;
}
function queuePlaybackWrite(roomId, work) {
  return queueRoomWrite(roomId, work);
}
function queueRoomWrite(roomId, work) {
  const previous = roomWriteQueues.get(roomId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  roomWriteQueues.set(roomId, current);
  current.finally(() => { if (roomWriteQueues.get(roomId) === current) roomWriteQueues.delete(roomId); }).catch(() => {});
  return current;
}
const roomMutationEvents = new Set(['room:queue:add', 'room:queue:remove', 'room:queue:replace', 'room:request:add', 'room:request:resolve', 'room:announcement', 'room:poll:create', 'room:poll:vote', 'room:poll:close']);
function onAsyncSocket(socket, eventName, handler) {
  socket.on(eventName, (...args) => {
    const acknowledge = typeof args.at(-1) === 'function' ? args.at(-1) : null;
    const roomId = socket.data.roomId;
    const work = () => {
      if (roomId && socket.data.roomId !== roomId) return acknowledge?.({ error: 'Oda bağlantısı değişti. İşlemi yeniden dene.' });
      return handler(...args);
    };
    Promise.resolve().then(() => roomId && roomMutationEvents.has(eventName) ? queueRoomWrite(roomId, work) : work()).catch(error => {
      console.error(`Socket event ${eventName} failed:`, error.message);
      acknowledge?.({ error: 'İşlem tamamlanamadı. Bağlantını kontrol edip yeniden dene.' });
    });
  });
}
function visiblePoll(poll, userId) { if (!poll) return null; const { createdById: _privateId, ...publicPoll } = poll; return { ...publicPoll, options: poll.options.map(option => ({ id: option.id, label: option.label, votes: option.votes?.length || 0, votedByMe: (option.votes || []).includes(userId) })) }; }
function visibleChatMessage(message, userId) {
  const reactions = Object.fromEntries(Object.entries(message.reactions || {}).map(([emoji, ids]) => [emoji, { count: ids.length, mine: ids.includes(userId) }]));
  const { userId: _privateId, ...publicMessage } = message;
  return { ...publicMessage, reactions };
}
function broadcastChatMessage(roomId, message) {
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    const recipient = io.sockets.sockets.get(socketId);
    recipient?.emit('room:chat', visibleChatMessage(message, recipient.user?.sub));
  }
}
function broadcastRoomPoll(roomId, poll) {
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    const recipient = io.sockets.sockets.get(socketId); if (!recipient) continue;
    recipient.emit('room:poll', { roomId, poll: visiblePoll(poll, recipient.user?.sub) });
  }
}
function allowSocketEvent(socket, eventName, limit, windowMs) {
  const now = Date.now(); socket.data.eventRates ||= new Map();
  let bucket = socket.data.eventRates.get(eventName);
  if (!bucket || bucket.resetAt <= now) { bucket = { count: 0, resetAt: now + windowMs }; socket.data.eventRates.set(eventName, bucket); }
  if (bucket.count >= limit) return false;
  bucket.count += 1; return true;
}
io.use(async (socket, next) => {
  try { const p = jwt.verify(socket.handshake.auth?.token || '', secret); if (!ObjectId.isValid(p.sub)) throw new Error('Invalid account'); const account = await db.collection('users').findOne({ _id: new ObjectId(p.sub) }, { projection: { username: 1, isAdmin: 1, tokenVersion: 1 } }); if (!account || (p.ver || 0) !== (account.tokenVersion || 0)) throw new Error('Account not found or session expired'); socket.user = { ...p, username: account.username, admin: !!account.isAdmin }; next(); }
  catch { next(new Error('Oturum açmanız gerekiyor.')); }
});
io.on('connection', socket => {
  io.emit('community:presence');
  onAsyncSocket(socket, 'community:chat:join', async (_payload, done = () => {}) => {
    socket.join('community:chat');
    const messages = await db.collection('communityMessages').find({}).sort({ createdAt: -1 }).limit(100).toArray();
    const senderIds = [...new Set(messages.map(item => item.userId).filter(ObjectId.isValid))].map(value => new ObjectId(value));
    const senders = senderIds.length ? await db.collection('users').find({ _id: { $in: senderIds } }, { projection: { avatar: 1 } }).toArray() : [];
    const avatars = new Map(senders.map(person => [person._id.toString(), person.avatar || '']));
    done({ messages: messages.reverse().map(item => ({ id: item._id.toString(), username: item.username, avatar: avatars.get(item.userId) || item.avatar || '', text: item.text, createdAt: item.createdAt })) });
  });
  onAsyncSocket(socket, 'community:chat:send', async ({ text } = {}, done = () => {}) => {
    const message = String(text || '').trim().slice(0, 500);
    if (!message) return done({ error: 'Mesaj boş olamaz.' });
    if (!allowSocketEvent(socket, 'community-chat', 8, 5_000)) return done({ error: 'Sohbete çok hızlı mesaj gönderiyorsun. Biraz bekle.' });
    const sender = await db.collection('users').findOne({ _id: new ObjectId(socket.user.sub) }, { projection: { avatar: 1 } });
    const item = { username: socket.user.username, userId: socket.user.sub, avatar: sender?.avatar || '', text: message, createdAt: new Date() };
    const result = await db.collection('communityMessages').insertOne(item);
    const visible = { id: result.insertedId.toString(), username: item.username, avatar: item.avatar, text: item.text, createdAt: item.createdAt };
    io.to('community:chat').emit('community:chat:message', visible); done({ ok: true });
  });
  onAsyncSocket(socket, 'dm:join', async ({ friendId } = {}, done = () => {}) => {
    friendId = String(friendId || '');
    if (!(await areFriends(socket.user.sub, friendId))) return done({ error: 'Özel sohbet yalnızca arkadaşlar arasında kullanılabilir.' });
    const roomId = directRoomId(socket.user.sub, friendId); socket.data.dmRooms ||= new Set(); socket.data.dmRooms.add(roomId); socket.join(roomId);
    const raw = await db.collection('directMessages').find({ $or: [{ fromId: socket.user.sub, toId: friendId }, { fromId: friendId, toId: socket.user.sub }] }).sort({ createdAt: -1 }).limit(100).toArray();
    const senderIds = [...new Set(raw.map(item => item.fromId))].filter(ObjectId.isValid).map(value => new ObjectId(value));
    const senders = senderIds.length ? await db.collection('users').find({ _id: { $in: senderIds } }, { projection: { username: 1, avatar: 1 } }).toArray() : [];
    const senderDetails = new Map(senders.map(person => [person._id.toString(), { username: person.username, avatar: person.avatar || '' }]));
    done({ messages: raw.reverse().map(item => ({ id: item._id.toString(), fromId: item.fromId, fromUsername: senderDetails.get(item.fromId)?.username || '', avatar: senderDetails.get(item.fromId)?.avatar || '', text: item.text, createdAt: item.createdAt })) });
  });
  onAsyncSocket(socket, 'dm:leave', async ({ friendId } = {}) => {
    const roomId = directRoomId(socket.user.sub, String(friendId || ''));
    socket.leave(roomId); socket.data.dmRooms?.delete(roomId);
  });
  onAsyncSocket(socket, 'dm:send', async ({ friendId, text } = {}, done = () => {}) => {
    friendId = String(friendId || ''); const message = String(text || '').trim().slice(0, 500);
    if (!message) return done({ error: 'Mesaj boş olamaz.' });
    if (!allowSocketEvent(socket, 'direct-message', 12, 5_000)) return done({ error: 'Çok hızlı mesaj gönderiyorsun. Biraz bekle.' });
    if (!(await areFriends(socket.user.sub, friendId))) return done({ error: 'Özel mesaj yalnızca arkadaşlar arasında kullanılabilir.' });
    const sender = await db.collection('users').findOne({ _id: new ObjectId(socket.user.sub) }, { projection: { avatar: 1 } });
    const item = { fromId: socket.user.sub, toId: friendId, fromUsername: socket.user.username, avatar: sender?.avatar || '', text: message, createdAt: new Date() };
    const result = await db.collection('directMessages').insertOne(item);
    const visible = { id: result.insertedId.toString(), fromId: item.fromId, fromUsername: item.fromUsername, avatar: item.avatar, text: item.text, createdAt: item.createdAt };
    for (const socketId of io.sockets.adapter.rooms.get(directRoomId(item.fromId, friendId)) || []) {
      const recipient = io.sockets.sockets.get(socketId);
      recipient?.emit('dm:message', { friendId: recipient.user?.sub === item.fromId ? friendId : item.fromId, message: visible });
    }
    await notifyUser(friendId, 'direct-message', `Yeni mesaj · ${item.fromUsername}`, message, '', { userId: item.fromId });
    done({ ok: true });
  });
  onAsyncSocket(socket, 'room:join', async ({ roomId, username } = {}, done = () => {}) => {
    if (socket.data.roomId && socket.data.roomId !== roomId) { try { await leaveCurrentRoom(socket); } catch (error) { console.error('Room switch cleanup failed:', error.message); return done({ error: 'Önceki odadan ayrılırken bağlantı hatası oluştu.' }); } }
    roomId = String(roomId || '').trim().slice(0, 40);
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(roomId)) return done({ error: 'Oda kodu geçersiz.' });
    return queueRoomJoin(roomId, async () => {
      const room = await db.collection('rooms').findOne({ roomId });
      if (!room) return done({ error: 'Bu oda artık mevcut değil.' });
      let set = roomState.get(roomId) || new Map();
      const existing = [...set.entries()].find(([id, person]) => id !== socket.id && person.userId === socket.user.sub);
      if (existing) {
        const previousSocket = io.sockets.sockets.get(existing[0]);
        previousSocket?.emit('room:session:replaced', { roomId });
        if (previousSocket) await leaveCurrentRoom(previousSocket);
        else set.delete(existing[0]);
        set = roomState.get(roomId) || new Map();
      }
      if (set.size >= 20 && !set.has(socket.id)) return done({ error: 'Oda dolu (en fazla 20 kişi).' });
      const dbUser = await db.collection('users').findOne({ _id: new ObjectId(socket.user.sub) });
      const participant = { id: socket.id, userId: socket.user.sub, username: dbUser?.username || username || 'Dinleyici', avatar: dbUser?.avatar || '', isAdmin: !!socket.user.admin, isHost: room.hostId === socket.user.sub, isDj: room.hostId === socket.user.sub || !!socket.user.admin || (room.djIds || []).includes(socket.user.sub), micOn: false, cameraOn: false };
      await db.collection('users').updateOne({ _id: new ObjectId(socket.user.sub) }, { $pull: { recentRooms: { roomId } } });
      await db.collection('users').updateOne({ _id: new ObjectId(socket.user.sub) }, { $push: { recentRooms: { $each: [{ roomId, name: room.name, mood: room.mood, joinedAt: new Date() }], $position: 0, $slice: 25 } } });
      set.set(socket.id, participant); roomState.set(roomId, set); socket.join(roomId); socket.data.roomId = roomId; socket.data.participant = participant;
      done({ room: { roomId, name: room.name, mood: room.mood, visibility: room.visibility || 'public', hostId: room.hostId, hostName: room.hostName || '', queue: room.queue || [], playback: { ...(room.playback || { playing: false, position: 0, index: null }), roomId }, participants: [...set.values()], history: room.history || [], requests: room.requests || [], chat: (room.chat || []).map(message => visibleChatMessage(message, socket.user.sub)), activePoll: visiblePoll(room.activePoll, socket.user.sub), announcement: room.announcement || '', statistics: room.statistics || { plays: 0, seconds: 0 } } });
      if (room.playback?.playing) socket.emit('room:playback', { ...room.playback, roomId });
      io.to(roomId).emit('room:participants', { roomId, participants: [...set.values()] });
      scheduleRoomsUpdate();
    });
  });
  onAsyncSocket(socket, 'room:queue:add', async (track, done = () => {}) => {
    const roomId = socket.data.roomId; if (!roomId) return done({ error: 'Önce odaya katıl.' });
    const set = roomState.get(roomId); const person = set?.get(socket.id); const room = await db.collection('rooms').findOne({ roomId });
    if (!room || (!person?.isDj && room.hostId !== socket.user.sub && !socket.user.admin)) return done({ error: 'Kuyruğa yalnızca oda sahibi veya DJ şarkı ekleyebilir.' });
    const item = { id: crypto.randomUUID(), title: String(track?.title || '').slice(0, 120), artist: String(track?.artist || '').slice(0, 120), source: track?.source === 'youtube' ? 'youtube' : 'library', videoId: String(track?.videoId || '').slice(0, 32), url: String(track?.url || '').slice(0, 500), addedBy: person.username };
    if (!item.title || (item.source === 'youtube' && !item.videoId) || (item.source === 'library' && !item.url)) return done({ error: 'Şarkı bilgisi geçersiz.' });
    const queue = room.queue || []; if (queue.length >= 100) return done({ error: 'Oda kuyruğu dolu.' }); queue.push(item); await db.collection('rooms').updateOne({ roomId }, { $set: { queue } }); io.to(roomId).emit('room:queue', { roomId, queue }); scheduleRoomsUpdate(); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:request:add', async (track, done = () => {}) => {
    const roomId = socket.data.roomId; if (!roomId) return done({ error: 'Önce bir odaya katıl.' });
    if (!allowSocketEvent(socket, 'song-request', 8, 60_000)) return done({ error: 'İstekleri biraz yavaş gönder; bir dakika sonra yeniden dene.' });
    const room = await db.collection('rooms').findOne({ roomId }); if (!room) return done({ error: 'Oda bulunamadı.' });
    const item = { requestId: crypto.randomUUID(), title: String(track?.title || '').slice(0, 120), artist: String(track?.artist || '').slice(0, 120), source: track?.source === 'youtube' ? 'youtube' : 'library', videoId: String(track?.videoId || '').slice(0, 32), url: String(track?.url || '').slice(0, 500), requesterId: socket.user.sub, requester: socket.user.username, status: 'pending', requestedAt: new Date() };
    if (!item.title || (item.source === 'youtube' ? !item.videoId : !item.url)) return done({ error: 'Şarkı isteği geçersiz.' });
    const pending = (room.requests || []).filter(request => request.status === 'pending' && request.requesterId === socket.user.sub).length; if (pending >= 5) return done({ error: 'Aynı anda en fazla 5 bekleyen isteğin olabilir.' });
    const requests = [item, ...(room.requests || [])].slice(0, 50); await db.collection('rooms').updateOne({ roomId }, { $set: { requests } }); io.to(roomId).emit('room:requests', { roomId, requests });
    const recipients = [...new Set([room.hostId, ...(room.djIds || [])])];
    Promise.all(recipients.map(userId => notifyUser(userId, 'song-request', 'Yeni şarkı isteği', `${item.requester}: ${item.title}`, roomId))).catch(error => console.error('Song request notifications failed:', error.message));
    done({ ok: true });
  });
  onAsyncSocket(socket, 'room:request:resolve', async ({ requestId, accept } = {}, done = () => {}) => {
    const roomId = socket.data.roomId; const room = roomId ? await db.collection('rooms').findOne({ roomId }) : null; const participant = roomState.get(roomId)?.get(socket.id);
    if (!room || (!participant?.isDj && room.hostId !== socket.user.sub && !socket.user.admin)) return done({ error: 'İstekleri yalnızca oda sahibi veya DJ yönetebilir.' });
    const requests = room.requests || []; const request = requests.find(item => item.requestId === requestId && item.status === 'pending'); if (!request) return done({ error: 'Bekleyen istek bulunamadı.' });
    request.status = accept ? 'accepted' : 'rejected'; request.resolvedAt = new Date(); request.resolvedBy = socket.user.username;
    const update = { $set: { requests } }; let queue = room.queue || [];
    if (accept) { if (queue.length >= 100) return done({ error: 'Oda kuyruğu dolu.' }); queue = [...queue, { id: crypto.randomUUID(), title: request.title, artist: request.artist, source: request.source, videoId: request.videoId, url: request.url, addedBy: request.requester }]; update.$set.queue = queue; }
    await db.collection('rooms').updateOne({ roomId }, update); io.to(roomId).emit('room:requests', { roomId, requests }); if (accept) { io.to(roomId).emit('room:queue', { roomId, queue }); scheduleRoomsUpdate(); }
    notifyUser(request.requesterId, accept ? 'request-accepted' : 'request-rejected', accept ? 'İsteğin kabul edildi' : 'İsteğin reddedildi', request.title, roomId).catch(error => console.error('Song request notification failed:', error.message));
    done({ ok: true });
  });
  onAsyncSocket(socket, 'room:announcement', async (text, done = () => {}) => {
    const roomId = socket.data.roomId; const room = roomId ? await db.collection('rooms').findOne({ roomId }) : null; const participant = roomState.get(roomId)?.get(socket.id);
    if (!room || (!participant?.isDj && room.hostId !== socket.user.sub && !socket.user.admin)) return done({ error: 'Duyuruyu yalnızca oda sahibi veya DJ düzenleyebilir.' });
    const announcement = String(text || '').trim().slice(0, 180); await db.collection('rooms').updateOne({ roomId }, { $set: { announcement } }); io.to(roomId).emit('room:announcement', { roomId, announcement }); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:queue:replace', async (queue, done = () => {}) => {
    const roomId = socket.data.roomId; if (!roomId || !Array.isArray(queue) || queue.length > 100) return done({ error: 'Kuyruk isteği geçersiz.' });
    const person = roomState.get(roomId)?.get(socket.id); const room = await db.collection('rooms').findOne({ roomId });
    if (!room || (!person?.isDj && room.hostId !== socket.user.sub && !socket.user.admin)) return done({ error: 'Kuyruğu yalnızca oda sahibi veya DJ temizleyebilir.' });
    const sanitized = queue.map(x => ({ id: String(x.id || crypto.randomUUID()).slice(0, 40), title: String(x.title || '').slice(0, 120), artist: String(x.artist || '').slice(0, 120), source: x.source === 'youtube' ? 'youtube' : 'library', videoId: String(x.videoId || '').slice(0, 32), url: String(x.url || '').slice(0, 500), addedBy: String(x.addedBy || '').slice(0, 24) })).filter(x => x.title && (x.source === 'youtube' ? x.videoId : x.url));
    const currentId = room?.playback?.track?.id; const index = currentId ? sanitized.findIndex(item => item.id === currentId) : -1;
    const playback = index < 0 ? { ...(room?.playback || {}), roomId, revision: (room?.playback?.revision || 0) + 1, playing: false, position: 0, index: null, track: null, updatedAt: new Date(), serverTime: Date.now() } : { ...room.playback, roomId, revision: (room.playback?.revision || 0) + 1, index, track: sanitized[index], updatedAt: new Date(), serverTime: Date.now() };
    await db.collection('rooms').updateOne({ roomId }, { $set: { queue: sanitized, playback } }); io.to(roomId).emit('room:queue', { roomId, queue: sanitized }); io.to(roomId).emit('room:playback', playback); scheduleRoomsUpdate(); done({ ok: true, queue: sanitized });
  });
  onAsyncSocket(socket, 'room:queue:remove', async (trackId, done = () => {}) => {
    const roomId = socket.data.roomId; if (!roomId) return done({ error: 'Önce odaya katıl.' });
    const person = roomState.get(roomId)?.get(socket.id); const room = await db.collection('rooms').findOne({ roomId });
    if (!room) return done({ error: 'Oda bulunamadı.' });
    if (!person?.isDj && room.hostId !== socket.user.sub && !socket.user.admin) return done({ error: 'Şarkıyı yalnızca oda sahibi veya DJ kaldırabilir.' });
    const oldQueue = room.queue || []; const removedIndex = oldQueue.findIndex(item => item.id === trackId); if (removedIndex < 0) return done({ error: 'Bu şarkı kuyrukta bulunamadı; liste güncelleniyor.' });
    const queue = oldQueue.filter(x => x.id !== trackId); let playback = room.playback || { playing: false, position: 0 };
    if (playback.track?.id === trackId) playback = { ...playback, roomId, revision: (playback.revision || 0) + 1, playing: false, position: 0, index: null, track: null, updatedAt: new Date(), serverTime: Date.now() };
    else if (Number.isInteger(playback.index) && removedIndex < playback.index) playback = { ...playback, roomId, revision: (playback.revision || 0) + 1, index: playback.index - 1, updatedAt: new Date(), serverTime: Date.now() };
    await db.collection('rooms').updateOne({ roomId }, { $set: { queue, playback } }); io.to(roomId).emit('room:queue', { roomId, queue }); io.to(roomId).emit('room:playback', { ...playback, roomId }); scheduleRoomsUpdate(); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:playback:sync', async (done = () => {}) => {
    const roomId = socket.data.roomId; const room = roomId ? await db.collection('rooms').findOne({ roomId }, { projection: { playback: 1 } }) : null;
    if (!room) return done({ error: 'Oda bağlantısı bulunamadı.' });
    done({ playback: { ...(room.playback || { playing: false, position: 0, index: null }), roomId } });
  });
  socket.on('room:playback', (state, done = () => {}) => {
    const roomId = socket.data.roomId; if (!roomId || state?.roomId !== roomId) return done({ error: 'Oda bağlantısı bulunamadı. Odaya yeniden katıl.' });
    queuePlaybackWrite(roomId, async () => {
      if (socket.data.roomId !== roomId) return { error: 'Oda bağlantısı değişti. Odaya yeniden katıl.' };
      const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
      if (!room || (!set?.get(socket.id)?.isDj && room.hostId !== socket.user.sub && !socket.user.admin)) return { error: 'Oynatma kontrolü yalnızca oda sahibi veya DJ kullanabilir.' };
      if (state.heartbeat) {
        const people = [...(set?.values() || [])]; const ownerOnline = people.some(person => person.userId === room.hostId);
        const leader = ownerOnline ? people.find(person => person.userId === room.hostId) : people.find(person => person.isDj);
        if (leader?.id !== socket.id || Date.now() - (roomPlaybackControlAt.get(roomId) || 0) < 2500) return { ok: true, ignored: true };
      }
      else roomPlaybackControlAt.set(roomId, Date.now());
      const queue = room.queue || []; let index = null; let track = null;
      if (state.track?.id) { index = queue.findIndex(item => item.id === state.track.id); if (index < 0) return { error: 'Bu parça artık oda kuyruğunda değil. Kuyruğu yenile.' }; track = queue[index]; }
      else if (Number.isInteger(state.index) && state.index >= 0 && state.index < queue.length) { index = state.index; track = queue[index]; }
      if (state.playing && !track) return { error: 'Oynatılacak parça bulunamadı.' };
      const playback = { roomId, revision: (room.playback?.revision || 0) + 1, playing: !!state.playing && !!track, position: track ? Math.max(0, Number(state.position) || 0) : 0, index, track, repeat: ['off', 'all', 'one'].includes(state.repeat) ? state.repeat : (room.playback?.repeat || 'off'), shuffle: !!state.shuffle, updatedAt: new Date(), serverTime: Date.now() };
      const trackChanged = !!track && track.id !== room.playback?.track?.id;
      const roomUpdate = { $set: { playback } };
      if (trackChanged) {
        const historyEntry = { trackId: track.id, title: track.title, artist: track.artist || '', source: track.source, videoId: track.videoId || '', url: track.url || '', playedBy: socket.user.username, playedAt: new Date() };
        roomUpdate.$push = { history: { $each: [historyEntry], $position: 0, $slice: 30 } }; roomUpdate.$inc = { 'statistics.plays': 1 };
      }
      if (state.heartbeat && !roomListenStatsAt.has(roomId)) roomListenStatsAt.set(roomId, Date.now());
      const secondsSinceStats = state.heartbeat ? Math.min(15, Math.max(0, Math.floor((Date.now() - (roomListenStatsAt.get(roomId) || Date.now())) / 1000))) : 0;
      if (state.heartbeat && secondsSinceStats >= 15) { roomListenStatsAt.set(roomId, Date.now()); if (playback.playing) roomUpdate.$inc = { ...(roomUpdate.$inc || {}), 'statistics.seconds': 15 }; }
      await db.collection('rooms').updateOne({ roomId }, roomUpdate);
      io.to(roomId).emit('room:playback', playback);
      const activeUsers = [...new Set([...(roomState.get(roomId)?.values() || [])].map(person => person.userId))];
      const backgroundWrites = [];
      if (trackChanged) {
        const recent = { title: track.title, artist: track.artist || '', source: track.source, videoId: track.videoId || '', url: track.url || '', roomId, playedAt: new Date() };
        if (activeUsers.length) backgroundWrites.push(db.collection('users').bulkWrite(activeUsers.map(userId => ({ updateOne: { filter: { _id: new ObjectId(userId) }, update: { $inc: { 'musicStats.plays': 1 }, $push: { recentTracks: { $each: [recent], $position: 0, $slice: 30 } } } } }))));
        const historyEntry = { trackId: track.id, title: track.title, artist: track.artist || '', source: track.source, videoId: track.videoId || '', url: track.url || '', playedBy: socket.user.username, playedAt: playback.updatedAt };
        io.to(roomId).emit('room:history', { roomId, entry: historyEntry });
        const activeUserIds = new Set(activeUsers);
        for (const recipient of io.of('/').sockets.values()) if (activeUserIds.has(recipient.user?.sub)) recipient.emit('user:history', { entry: recent });
      }
      if (secondsSinceStats >= 15 && playback.playing) {
        if (activeUsers.length) backgroundWrites.push(db.collection('users').bulkWrite(activeUsers.map(userId => ({ updateOne: { filter: { _id: new ObjectId(userId) }, update: { $inc: { 'musicStats.seconds': 15 } } } }))));
        const activeUserIds = new Set(activeUsers);
        for (const recipient of io.of('/').sockets.values()) if (activeUserIds.has(recipient.user?.sub)) recipient.emit('user:stats', { roomId, seconds: 15 });
      }
      if (trackChanged || (secondsSinceStats >= 15 && playback.playing)) io.to(roomId).emit('room:stats', { roomId, statistics: { plays: (room.statistics?.plays || 0) + (trackChanged ? 1 : 0), seconds: (room.statistics?.seconds || 0) + (secondsSinceStats >= 15 && playback.playing ? 15 : 0) } });
      if (backgroundWrites.length) Promise.all(backgroundWrites).catch(error => console.error('Listening statistics update failed:', error.message));
      if (trackChanged) scheduleRoomsUpdate(); return { ok: true, revision: playback.revision };
    }).then(result => done(result || { ok: true })).catch(error => { console.error('Playback sync failed:', error.message); done({ error: 'Oynatma güncellenemedi. Tekrar dene.' }); });
  });
  onAsyncSocket(socket, 'room:dj:assign', async (userId, done = () => {}) => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (room?.hostId !== socket.user.sub && !socket.user.admin) return done({ error: 'DJ yetkisini yalnızca oda sahibi verebilir.' });
    const targets = []; for (const [id, p] of set || []) if (p.userId === userId && p.userId !== room.hostId) targets.push(id);
    const assigned = targets.length > 0;
    if (!assigned) return done({ error: 'Bu kullanıcı şu anda odada değil.' });
    await db.collection('rooms').updateOne({ roomId }, { $addToSet: { djIds: String(userId) } });
    for (const id of targets) set.get(id).isDj = true;
    for (const id of targets) io.to(id).emit('room:role', { roomId, isDj: true });
    io.to(roomId).emit('room:participants', { roomId, participants: [...(set?.values() || [])] });
    await notifyUser(userId, 'dj-assigned', 'DJ yetkisi verildi', room.name, roomId);
    done({ ok: true });
  });
  onAsyncSocket(socket, 'room:dj:revoke', async (userId, done = () => {}) => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (room?.hostId !== socket.user.sub && !socket.user.admin) return done({ error: 'DJ yetkisini yalnızca oda sahibi kaldırabilir.' });
    const targets = []; for (const [id, p] of set || []) if (p.userId === userId && p.userId !== room.hostId) targets.push(id);
    const revoked = targets.length > 0;
    if (!revoked) return done({ error: 'Bu kullanıcı DJ değil veya artık odada değil.' });
    await db.collection('rooms').updateOne({ roomId }, { $pull: { djIds: String(userId) } });
    for (const id of targets) set.get(id).isDj = false;
    for (const id of targets) io.to(id).emit('room:role', { roomId, isDj: false });
    io.to(roomId).emit('room:participants', { roomId, participants: [...(set?.values() || [])] });
    done({ ok: true });
  });
  onAsyncSocket(socket, 'room:dj:handoff', async (userId, done = () => {}) => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = roomId ? await db.collection('rooms').findOne({ roomId }) : null; const actor = set?.get(socket.id);
    if (!room || (!actor?.isDj && room.hostId !== socket.user.sub && !socket.user.admin)) return done({ error: 'DJ devrini yalnızca oda sahibi veya DJ yapabilir.' });
    const target = [...(set?.values() || [])].find(person => person.userId === userId); if (!target || target.userId === room.hostId) return done({ error: 'DJ devri için odada bir üye seç.' });
    const targets = [];
    for (const [id, person] of set) { const nextRole = person.userId === userId; if (person.userId !== room.hostId) person.isDj = nextRole; targets.push({ id, isDj: person.userId === room.hostId || nextRole }); }
    await db.collection('rooms').updateOne({ roomId }, { $set: { djIds: [String(userId)] } });
    for (const targetUser of targets) io.to(targetUser.id).emit('room:role', { roomId, isDj: targetUser.isDj });
    io.to(roomId).emit('room:participants', { roomId, participants: [...set.values()] });
    await notifyUser(userId, 'dj-handoff', 'DJ kontrolü sana devredildi', room.name, roomId); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:kick', async userId => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (!room || (room.hostId !== socket.user.sub && !socket.user.admin) || userId === room.hostId) return;
    for (const [id, p] of set || []) if (p.userId === userId) { io.to(id).emit('room:kicked', { roomId }); const target = io.sockets.sockets.get(id); if (target) { target.leave(roomId); target.data.roomId = null; target.data.participant = null; } set.delete(id); }
    io.to(roomId).emit('room:participants', { roomId, participants: [...(set?.values() || [])] }); scheduleRoomsUpdate();
  });
  onAsyncSocket(socket, 'room:host:transfer', async userId => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (!room || room.hostId !== socket.user.sub || ![...(set?.values() || [])].some(p => p.userId === userId)) return;
    const next = [...set.values()].find(p => p.userId === userId); if (!next) return;
    const assignedDjs = (room.djIds || []).filter(id => String(id) !== String(userId));
    await db.collection('rooms').updateOne({ roomId }, { $set: { hostId: userId, hostName: next.username, djIds: assignedDjs } });
    for (const [id, p] of set) { p.isHost = p.userId === userId; p.isDj = p.isHost || !!p.isAdmin || assignedDjs.includes(String(p.userId)); io.to(id).emit('room:host', { roomId, hostId: userId, hostName: next.username, isHost: p.isHost, isDj: p.isDj }); }
    io.to(roomId).emit('room:participants', { roomId, participants: [...set.values()] }); scheduleRoomsUpdate();
  });
  onAsyncSocket(socket, 'room:chat', async ({ text } = {}, done = () => {}) => {
    const message = String(text || '').trim().slice(0, 500); if (!message || !socket.data.roomId) return done({ error: 'Mesaj boş veya oda bağlantısı yok.' });
    if (!allowSocketEvent(socket, 'chat', 8, 5_000)) return done({ error: 'Sohbete çok hızlı mesaj gönderiyorsun. Biraz bekle.' });
    const roomId = socket.data.roomId; const item = { roomId, id: crypto.randomUUID(), userId: socket.user.sub, username: socket.data.participant.username, text: message, at: new Date().toISOString(), reactions: {} };
    await db.collection('rooms').updateOne({ roomId }, { $push: { chat: { $each: [item], $slice: -100 } } }); broadcastChatMessage(roomId, item); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:chat:react', async ({ messageId, reaction } = {}, done = () => {}) => {
    const roomId = socket.data.roomId; const allowed = ['👍', '❤️', '😂', '🔥', '👏'];
    if (!roomId || !allowed.includes(reaction) || !allowSocketEvent(socket, 'chat-reaction', 20, 10_000)) return done({ error: 'Tepki gönderilemedi.' });
    const room = await db.collection('rooms').findOne({ roomId }, { projection: { chat: 1 } }); const messages = room?.chat || []; const message = messages.find(item => item.id === messageId);
    if (!message) return done({ error: 'Mesaj artık bulunamadı.' });
    message.reactions ||= {}; message.reactions[reaction] ||= [];
    const users = message.reactions[reaction]; const alreadyReacted = users.includes(socket.user.sub); const path = `chat.$[message].reactions.${reaction}`;
    await db.collection('rooms').updateOne({ roomId, 'chat.id': messageId }, { [alreadyReacted ? '$pull' : '$addToSet']: { [path]: socket.user.sub } }, { arrayFilters: [{ 'message.id': messageId }] });
    if (alreadyReacted) message.reactions[reaction] = users.filter(id => id !== socket.user.sub); else users.push(socket.user.sub);
    for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
      const recipient = io.sockets.sockets.get(socketId);
      const reactions = Object.fromEntries(Object.entries(message.reactions).map(([emoji, ids]) => [emoji, { count: ids.length, mine: ids.includes(recipient?.user?.sub) }]));
      recipient?.emit('room:chat:reaction', { roomId, messageId, reactions });
    }
    done({ ok: true });
  });
  onAsyncSocket(socket, 'room:poll:create', async ({ question, options } = {}, done = () => {}) => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = roomId ? await db.collection('rooms').findOne({ roomId }) : null;
    const cleanQuestion = String(question || '').trim().slice(0, 120); const cleanOptions = Array.isArray(options) ? [...new Set(options.map(value => String(value).trim().slice(0, 50)).filter(Boolean))].slice(0, 5) : [];
    const person = set?.get(socket.id);
    if (!room || !person) return done({ error: 'Önce odaya katıl.' });
    if (!person.isDj && room.hostId !== socket.user.sub && !socket.user.admin) return done({ error: 'Anketi yalnızca oda sahibi veya DJ oluşturabilir.' });
    if (!cleanQuestion || cleanOptions.length < 2) return done({ error: 'Anket için soru ve en az iki farklı seçenek gerekli.' });
    if (room.activePoll) return done({ error: 'Önce mevcut anketi kapatın.' });
    const poll = { id: crypto.randomUUID(), question: cleanQuestion, options: cleanOptions.map((label, index) => ({ id: String(index), label, votes: [] })), createdBy: socket.data.participant.username, createdById: socket.user.sub, createdAt: new Date() };
    await db.collection('rooms').updateOne({ roomId }, { $set: { activePoll: poll } }); broadcastRoomPoll(roomId, poll); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:poll:vote', async ({ pollId, optionId } = {}, done = () => {}) => {
    const roomId = socket.data.roomId; const room = roomId ? await db.collection('rooms').findOne({ roomId }) : null; const poll = room?.activePoll;
    if (!poll || poll.id !== pollId || !(roomState.get(roomId)?.has(socket.id))) return done({ error: 'Aktif anket bulunamadı.' });
    const option = poll.options.find(item => item.id === optionId); if (!option) return done({ error: 'Seçenek bulunamadı.' });
    for (const item of poll.options) item.votes = (item.votes || []).filter(id => id !== socket.user.sub);
    option.votes.push(socket.user.sub); await db.collection('rooms').updateOne({ roomId }, { $set: { activePoll: poll } }); broadcastRoomPoll(roomId, poll); done({ ok: true });
  });
  onAsyncSocket(socket, 'room:poll:close', async ({ pollId } = {}, done = () => {}) => {
    const roomId = socket.data.roomId; const room = roomId ? await db.collection('rooms').findOne({ roomId }) : null; const person = roomState.get(roomId)?.get(socket.id);
    if (!room?.activePoll || room.activePoll.id !== pollId) return done({ error: 'Aktif anket bulunamadı.' });
    if (!person?.isDj && room.hostId !== socket.user.sub && !socket.user.admin) return done({ error: 'Anketi yalnızca oda sahibi veya DJ kapatabilir.' });
    await db.collection('rooms').updateOne({ roomId }, { $unset: { activePoll: '' } }); broadcastRoomPoll(roomId, null); done({ ok: true });
  });
  socket.on('room:media', ({ micOn, cameraOn } = {}) => {
    const roomId = socket.data.roomId; const participant = roomState.get(roomId)?.get(socket.id); if (!participant) return;
    participant.micOn = !!micOn; participant.cameraOn = !!cameraOn; io.to(roomId).emit('room:participants', { roomId, participants: [...roomState.get(roomId).values()] });
  });
  socket.on('rtc:signal', ({ to, signal } = {}) => { const target = typeof to === 'string' ? io.sockets.sockets.get(to) : null; if (socket.data.roomId && target?.data.roomId === socket.data.roomId && signal && JSON.stringify(signal).length < 100000) target.emit('rtc:signal', { from: socket.id, signal }); });
  socket.on('room:leave', () => { leaveCurrentRoom(socket).catch(error => console.error('Room leave failed:', error.message)); });
  socket.on('disconnect', () => { leaveCurrentRoom(socket).catch(error => console.error('Room disconnect cleanup failed:', error.message)).finally(() => io.emit('community:presence')); });
});

async function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId; if (!roomId) return;
  const set = roomState.get(roomId); set?.delete(socket.id); socket.leave(roomId); socket.data.roomId = null;
  if (!set?.size) { roomState.delete(roomId); roomPlaybackControlAt.delete(roomId); roomListenStatsAt.delete(roomId); }
  io.to(roomId).emit('room:participants', { roomId, participants: [...(set?.values() || [])] });
  scheduleRoomsUpdate();
}

app.use((error, _req, res, _next) => {
  const status = Number(error.statusCode || error.status) || 500;
  if (status >= 500) console.error(error.message);
  res.status(status).json({ error: status >= 500 ? 'Sunucuda beklenmeyen bir hata oluştu.' : error.message });
});

async function start() {
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET en az 32 karakterlik gizli bir değer olmalı.');
  if (!mongoUrl) throw new Error('MONGODB_URI .env içinde tanımlanmalı.');
  const client = new MongoClient(mongoUrl); await client.connect(); db = client.db(dbName); mediaBucket = new GridFSBucket(db);
  await db.createCollection('users').catch(error => { if (error.codeName !== 'NamespaceExists') throw error; });
  const users = db.collection('users');
  const indexes = await users.listIndexes().toArray();
  const usernameIndex = indexes.find(index => index.name === 'username_1');
  const usernameIndexReady = usernameIndex?.unique && usernameIndex.partialFilterExpression?.username?.$type === 'string' && usernameIndex.collation?.locale === 'en' && usernameIndex.collation?.strength === 2;
  if (usernameIndex && !usernameIndexReady) await users.dropIndex('username_1');
  const emailIndex = indexes.find(index => index.name === 'email_1');
  const emailIndexReady = emailIndex?.unique && emailIndex.partialFilterExpression?.email?.$type === 'string';
  if (emailIndex && !emailIndexReady) await users.dropIndex('email_1');
  await users.createIndex({ username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 }, partialFilterExpression: { username: { $type: 'string' } } });
  await users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
  await db.collection('rooms').createIndex({ roomId: 1 }, { unique: true });
  await db.collection('friendRequests').createIndex({ to: 1, status: 1, createdAt: -1 });
  await db.collection('friendRequests').createIndex({ from: 1, to: 1, status: 1 });
  await db.collection('communityMessages').createIndex({ createdAt: -1 });
  await db.collection('directMessages').createIndex({ fromId: 1, toId: 1, createdAt: -1 });
  await db.collection('directMessages').createIndex({ toId: 1, fromId: 1, createdAt: -1 });
  await migrateLegacyMedia();
  let bootstrapAdmin = await db.collection('users').findOne({ bootstrapAdmin: true });
  if (!bootstrapAdmin && process.env.ADMIN_USERNAME && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'change-this-before-first-run') {
    const username = process.env.ADMIN_USERNAME.trim();
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    bootstrapAdmin = await db.collection('users').findOne({ username: { $regex: `^${escapedUsername}$`, $options: 'i' } });
    if (!bootstrapAdmin) bootstrapAdmin = await db.collection('users').findOne({ email });
    if (!bootstrapAdmin) await db.collection('users').insertOne({ username, email, passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12), isAdmin: true, bootstrapAdmin: true, tokenVersion: 0, theme: 'dark', createdAt: new Date() });
    else await db.collection('users').updateOne({ _id: bootstrapAdmin._id }, { $set: { isAdmin: true, bootstrapAdmin: true } });
  }
  server.listen(port, () => console.log(`Karaaslan Müzik http://localhost:${port}`));
}
start().catch(error => { console.error(error.message); process.exit(1); });
