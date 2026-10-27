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
const { MongoClient, ObjectId } = require('mongodb');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, cors: { origin: false } });
const port = Number(process.env.PORT || 3000);
const secret = process.env.JWT_SECRET;
const mongoUrl = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || 'karaaslan_muzik';
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
let db;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir, { fallthrough: false, maxAge: '1h' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

function tokenFor(user) {
  return jwt.sign({ sub: user._id.toString(), username: user.username, admin: !!user.isAdmin }, secret, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const value = req.headers.authorization || '';
  try { req.user = jwt.verify(value.replace(/^Bearer\s+/i, ''), secret); next(); }
  catch { res.status(401).json({ error: 'Oturum açmanız gerekiyor.' }); }
}
function admin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Bu alan yalnızca yöneticiye açık.' });
  next();
}
function publicUser(user) {
  return { id: user._id.toString(), username: user.username, email: user.email, avatar: user.avatar || '', bio: user.bio || '', isAdmin: !!user.isAdmin, theme: user.theme || 'dark' };
}
function safeName(name) { return String(name || 'audio').replace(/[^a-z0-9._-]/gi, '_').slice(0, 100); }

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
  res.json({ user: publicUser(user) });
});
app.patch('/api/me', auth, async (req, res) => {
  const updates = {};
  if (typeof req.body.bio === 'string') updates.bio = req.body.bio.slice(0, 160);
  if (['dark', 'light'].includes(req.body.theme)) updates.theme = req.body.theme;
  await db.collection('users').updateOne({ _id: new ObjectId(req.user.sub) }, { $set: updates });
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.sub) }, { projection: { passwordHash: 0 } });
  res.json({ user: publicUser(user) });
});
app.get('/api/rtc/config', auth, (_req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) iceServers.push({ urls: process.env.TURN_URL.split(',').map(value => value.trim()).filter(Boolean), username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  res.json({ iceServers });
});
app.post('/api/me/avatar', auth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '2mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Profil resmi gönderilmedi.' });
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[req.headers['content-type']];
  const id = crypto.randomUUID(); const filename = `${id}${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), req.body, { flag: 'wx' });
  const avatar = `/uploads/${filename}`;
  await db.collection('users').updateOne({ _id: new ObjectId(req.user.sub) }, { $set: { avatar } });
  res.json({ avatar });
});
app.get('/api/catalog', async (_req, res) => res.json(await db.collection('tracks').find({}).sort({ createdAt: -1 }).limit(500).toArray()));
app.get('/api/rooms', async (_req, res) => {
  const rooms = await db.collection('rooms').find({}).sort({ createdAt: -1 }).limit(40).toArray();
  res.json(rooms.map(r => ({ roomId: r.roomId, name: r.name, mood: r.mood, hostId: r.hostId, hostName: r.hostName || '', queueCount: (r.queue || []).length, participants: roomState.get(r.roomId)?.size || 0, createdAt: r.createdAt })));
});
app.post('/api/rooms', auth, async (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex');
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (name.length < 2) return res.status(400).json({ error: 'Oda adı en az 2 karakter olmalı.' });
  const mood = String(req.body.mood || 'Serbest dinleme').slice(0, 30);
  const room = { roomId, name, mood, hostId: req.user.sub, hostName: req.user.username, queue: [], playback: { playing: false, position: 0, updatedAt: new Date() }, createdAt: new Date() };
  await db.collection('rooms').insertOne(room);
  io.emit('rooms:update');
  res.status(201).json({ roomId, name, mood, hostId: room.hostId, queueCount: 0, participants: 0 });
});
app.patch('/api/rooms/:roomId', auth, async (req, res) => {
  const roomId = String(req.params.roomId || '').slice(0, 40);
  const room = await db.collection('rooms').findOne({ roomId });
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });
  if (room.hostId !== req.user.sub && !req.user.admin) return res.status(403).json({ error: 'Bu odayı yalnızca sahibi düzenleyebilir.' });
  const updates = {};
  if (typeof req.body.name === 'string') { const name = req.body.name.trim().slice(0, 50); if (name.length < 2) return res.status(400).json({ error: 'Oda adı en az 2 karakter olmalı.' }); updates.name = name; }
  if (typeof req.body.mood === 'string') updates.mood = req.body.mood.trim().slice(0, 30);
  await db.collection('rooms').updateOne({ roomId }, { $set: updates });
  io.to(roomId).emit('room:details', updates); io.emit('rooms:update'); res.json({ roomId, ...updates });
});
app.delete('/api/rooms/:roomId', auth, async (req, res) => {
  const roomId = String(req.params.roomId || '').slice(0, 40);
  const room = await db.collection('rooms').findOne({ roomId });
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });
  if (room.hostId !== req.user.sub && !req.user.admin) return res.status(403).json({ error: 'Bu odayı yalnızca sahibi silebilir.' });
  await db.collection('rooms').deleteOne({ roomId });
  io.to(roomId).emit('room:closed'); io.in(roomId).socketsLeave(roomId); roomState.delete(roomId); io.emit('rooms:update'); res.json({ ok: true });
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
  const recentRooms = await db.collection('rooms').find({}).sort({ createdAt: -1 }).limit(12).toArray();
  res.json({ users, tracks, activeRooms: rooms, recentTracks: await db.collection('tracks').find({}).sort({ createdAt: -1 }).limit(8).toArray(), recentRooms: recentRooms.map(r => ({ roomId: r.roomId, name: r.name, hostName: r.hostName, mood: r.mood, queue: r.queue || [], participants: roomState.get(r.roomId)?.size || 0 })) });
});
app.post('/api/admin/tracks', auth, admin, express.raw({ type: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/flac', 'audio/x-flac'], limit: '30mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Ses dosyası gönderilmedi.' });
  const mime = req.headers['content-type'];
  const ext = ({ 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/x-aac': '.aac', 'audio/flac': '.flac', 'audio/x-flac': '.flac' })[mime];
  if (!ext) return res.status(415).json({ error: 'Desteklenmeyen ses biçimi.' });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(uploadDir, id + ext), req.body, { flag: 'wx' });
  const track = { title: String(req.query.title || 'İsimsiz şarkı').slice(0, 120), artist: String(req.query.artist || 'Bilinmeyen sanatçı').slice(0, 120), source: 'library', url: `/uploads/${id}${ext}`, createdAt: new Date() };
  const result = await db.collection('tracks').insertOne(track); res.status(201).json({ ...track, id: result.insertedId.toString() });
});
app.get('/api/admin/users', auth, admin, async (_req, res) => res.json(await db.collection('users').find({}, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).limit(200).toArray()));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const roomState = new Map();
io.use(async (socket, next) => {
  try { const p = jwt.verify(socket.handshake.auth?.token || '', secret); socket.user = p; next(); }
  catch { next(new Error('Oturum açmanız gerekiyor.')); }
});
io.on('connection', socket => {
  socket.on('room:join', async ({ roomId, username } = {}, done = () => {}) => {
    if (socket.data.roomId && socket.data.roomId !== roomId) await leaveCurrentRoom(socket);
    roomId = String(roomId || '').trim().slice(0, 40);
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(roomId)) return done({ error: 'Oda kodu geçersiz.' });
    const set = roomState.get(roomId) || new Map();
    if (set.size >= 20 && !set.has(socket.id)) return done({ error: 'Oda dolu (en fazla 20 kişi).' });
    const dbUser = await db.collection('users').findOne({ _id: new ObjectId(socket.user.sub) });
    const participant = { id: socket.id, userId: socket.user.sub, username: dbUser?.username || username || 'Dinleyici', avatar: dbUser?.avatar || '', isAdmin: !!socket.user.admin, isDj: !!socket.user.admin, micOn: false, cameraOn: false };
    set.set(socket.id, participant); roomState.set(roomId, set); socket.join(roomId); socket.data.roomId = roomId; socket.data.participant = participant;
    const room = await db.collection('rooms').findOneAndUpdate({ roomId }, { $setOnInsert: { roomId, hostId: socket.user.sub, queue: [], playback: { playing: false, position: 0, updatedAt: new Date() }, createdAt: new Date() } }, { upsert: true, returnDocument: 'after' });
    done({ room: { roomId, name: room.name, hostId: room.hostId, hostName: room.hostName || '', queue: room.queue || [], playback: room.playback || { playing: false, position: 0, index: null }, participants: [...set.values()] } });
    if (room.playback?.playing) socket.emit('room:playback', room.playback);
    io.to(roomId).emit('room:participants', [...set.values()]);
    io.emit('rooms:update');
  });
  socket.on('room:queue:add', async track => {
    const roomId = socket.data.roomId; if (!roomId) return;
    const set = roomState.get(roomId); const person = set?.get(socket.id); const room = await db.collection('rooms').findOne({ roomId });
    if (!person?.isDj && room?.hostId !== socket.user.sub) return;
    const item = { id: crypto.randomUUID(), title: String(track?.title || '').slice(0, 120), artist: String(track?.artist || '').slice(0, 120), source: track?.source === 'youtube' ? 'youtube' : 'library', videoId: String(track?.videoId || '').slice(0, 32), url: String(track?.url || '').slice(0, 500), addedBy: person.username };
    if (!item.title || (item.source === 'youtube' && !item.videoId) || (item.source === 'library' && !item.url)) return;
    const queue = room?.queue || []; if (queue.length >= 100) return; queue.push(item); await db.collection('rooms').updateOne({ roomId }, { $set: { queue } }); io.to(roomId).emit('room:queue', queue); io.emit('rooms:update');
  });
  socket.on('room:queue:replace', async queue => {
    const roomId = socket.data.roomId; if (!roomId || !Array.isArray(queue) || queue.length > 100) return;
    const person = roomState.get(roomId)?.get(socket.id); const room = await db.collection('rooms').findOne({ roomId });
    if (!person?.isDj && room?.hostId !== socket.user.sub) return;
    const sanitized = queue.map(x => ({ id: String(x.id || crypto.randomUUID()).slice(0, 40), title: String(x.title || '').slice(0, 120), artist: String(x.artist || '').slice(0, 120), source: x.source === 'youtube' ? 'youtube' : 'library', videoId: String(x.videoId || '').slice(0, 32), url: String(x.url || '').slice(0, 500), addedBy: String(x.addedBy || '').slice(0, 24) })).filter(x => x.title && (x.source === 'youtube' ? x.videoId : x.url));
    await db.collection('rooms').updateOne({ roomId }, { $set: { queue: sanitized } }); io.to(roomId).emit('room:queue', sanitized); io.emit('rooms:update');
  });
  socket.on('room:queue:remove', async trackId => {
    const roomId = socket.data.roomId; if (!roomId) return;
    const person = roomState.get(roomId)?.get(socket.id); const room = await db.collection('rooms').findOne({ roomId });
    if (!person?.isDj && room?.hostId !== socket.user.sub) return;
    const queue = (room?.queue || []).filter(x => x.id !== trackId);
    await db.collection('rooms').updateOne({ roomId }, { $set: { queue } }); io.to(roomId).emit('room:queue', queue); io.emit('rooms:update');
  });
  socket.on('room:playback', async state => {
    const roomId = socket.data.roomId; if (!roomId) return;
    const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (!set?.get(socket.id)?.isDj && room?.hostId !== socket.user.sub) return;
    const playback = { playing: !!state?.playing, position: Math.max(0, Number(state?.position) || 0), index: Number.isInteger(state?.index) ? state.index : null, track: state?.track || null, repeat: ['off', 'all', 'one'].includes(state?.repeat) ? state.repeat : (room.playback?.repeat || 'off'), shuffle: !!state?.shuffle, updatedAt: new Date(), serverTime: Date.now() };
    await db.collection('rooms').updateOne({ roomId }, { $set: { playback } }); socket.to(roomId).emit('room:playback', playback);
  });
  socket.on('room:dj:assign', async userId => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (room?.hostId !== socket.user.sub && !socket.user.admin) return;
    for (const [id, p] of set || []) { if (p.userId === userId && p.userId !== room.hostId) { p.isDj = true; io.to(id).emit('room:role', { isDj: true }); } }
    io.to(roomId).emit('room:participants', [...(set?.values() || [])]);
  });
  socket.on('room:dj:revoke', async userId => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (room?.hostId !== socket.user.sub && !socket.user.admin) return;
    for (const [id, p] of set || []) if (p.userId === userId && p.userId !== room.hostId) { p.isDj = false; io.to(id).emit('room:role', { isDj: false }); }
    io.to(roomId).emit('room:participants', [...(set?.values() || [])]);
  });
  socket.on('room:kick', async userId => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (!room || (room.hostId !== socket.user.sub && !socket.user.admin) || userId === room.hostId) return;
    for (const [id, p] of set || []) if (p.userId === userId) { io.to(id).emit('room:kicked'); const target = io.sockets.sockets.get(id); if (target) { target.leave(roomId); target.data.roomId = null; target.data.participant = null; } set.delete(id); }
    io.to(roomId).emit('room:participants', [...(set?.values() || [])]); io.emit('rooms:update');
  });
  socket.on('room:host:transfer', async userId => {
    const roomId = socket.data.roomId; const set = roomState.get(roomId); const room = await db.collection('rooms').findOne({ roomId });
    if (!room || room.hostId !== socket.user.sub || ![...(set?.values() || [])].some(p => p.userId === userId)) return;
    const next = [...set.values()].find(p => p.userId === userId); if (!next) return;
    await db.collection('rooms').updateOne({ roomId }, { $set: { hostId: userId, hostName: next.username } });
    for (const [id, p] of set) { p.isDj = p.userId === userId || p.isDj; io.to(id).emit('room:host', { hostId: userId, hostName: next.username, isHost: p.userId === userId, isDj: p.isDj }); }
    io.to(roomId).emit('room:participants', [...set.values()]); io.emit('rooms:update');
  });
  socket.on('room:chat', ({ text } = {}) => {
    const message = String(text || '').trim().slice(0, 500); if (!message || !socket.data.roomId) return;
    io.to(socket.data.roomId).emit('room:chat', { id: crypto.randomUUID(), username: socket.data.participant.username, text: message, at: new Date().toISOString() });
  });
  socket.on('room:media', ({ micOn, cameraOn } = {}) => {
    const roomId = socket.data.roomId; const participant = roomState.get(roomId)?.get(socket.id); if (!participant) return;
    participant.micOn = !!micOn; participant.cameraOn = !!cameraOn; io.to(roomId).emit('room:participants', [...roomState.get(roomId).values()]);
  });
  socket.on('rtc:signal', ({ to, signal } = {}) => { if (typeof to === 'string' && signal && JSON.stringify(signal).length < 100000) io.to(to).emit('rtc:signal', { from: socket.id, signal }); });
  socket.on('room:leave', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

async function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId; if (!roomId) return;
  const set = roomState.get(roomId); set?.delete(socket.id); socket.leave(roomId); socket.data.roomId = null;
  if (!set?.size) roomState.delete(roomId);
  const room = await db.collection('rooms').findOne({ roomId });
  if (room?.hostId === socket.user?.sub && set?.size) {
    const next = [...set.values()][0]; await db.collection('rooms').updateOne({ roomId }, { $set: { hostId: next.userId, hostName: next.username } });
    next.isDj = true; for (const [id, person] of set) io.to(id).emit('room:host', { hostId: next.userId, hostName: next.username, isHost: person.userId === next.userId, isDj: person.isDj });
  }
  io.to(roomId).emit('room:participants', [...(set?.values() || [])]);
  io.emit('rooms:update');
}

app.use((error, _req, res, _next) => {
  const status = Number(error.statusCode || error.status) || 500;
  if (status >= 500) console.error(error.message);
  res.status(status).json({ error: status >= 500 ? 'Sunucuda beklenmeyen bir hata oluştu.' : error.message });
});

async function start() {
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET en az 32 karakterlik gizli bir değer olmalı.');
  if (!mongoUrl) throw new Error('MONGODB_URI .env içinde tanımlanmalı.');
  const client = new MongoClient(mongoUrl); await client.connect(); db = client.db(dbName);
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
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'change-this-before-first-run') {
    const username = process.env.ADMIN_USERNAME.trim();
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let adminUser = await db.collection('users').findOne({ username: { $regex: `^${escapedUsername}$`, $options: 'i' } });
    if (!adminUser) adminUser = await db.collection('users').findOne({ email });
    const adminFields = { username, email, passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12), isAdmin: true };
    if (!adminUser) await db.collection('users').insertOne({ ...adminFields, theme: 'dark', createdAt: new Date() });
    else await db.collection('users').updateOne({ _id: adminUser._id }, { $set: adminFields });
  }
  server.listen(port, () => console.log(`Karaaslan Müzik http://localhost:${port}`));
}
start().catch(error => { console.error(error.message); process.exit(1); });
