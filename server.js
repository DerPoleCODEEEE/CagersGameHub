require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch-new').Strategy;

const User = require('./models/User');
const MoveGen = require('./public/shared/move-gen.js');
const { DEFAULT_COOLDOWNS, COOLDOWN_BOUNDS } = require('./public/shared/piece-assets.js');

const IS_PROD = process.env.NODE_ENV === 'production';

// =========================================================
// 0. KONFIGURATION & FAIL-FAST
// =========================================================
// Ein hartkodiertes Fallback-Secret bedeutet in Produktion fälschbare
// Sessions. Deshalb: in Produktion lieber gar nicht starten.
if (IS_PROD && !process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET muss in Produktion gesetzt sein. Siehe .env.example.');
    process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('WARN: SESSION_SECRET nicht gesetzt — es wird ein zufälliges Secret benutzt. ' +
                 'Sessions überleben keinen Neustart.');
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Ohne ALLOWED_ORIGIN bleibt CORS aus -> nur Same-Origin. Vorher stand hier
// origin:"*", womit jede fremde Seite Sockets öffnen konnte.
const io = new Server(server, {
    cors: ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN, credentials: true } : false,
    maxHttpBufferSize: 1e5
});

app.use(express.json({ limit: '16kb' }));

// =========================================================
// 0b. SICHERHEITS-HEADER (ohne zusätzliche Dependency)
// =========================================================
const CSP = [
    "default-src 'self'",
    // cdnjs: chess.js + stockfish; blob: der Stockfish-Worker
    "script-src 'self' https://cdnjs.cloudflare.com blob:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    // Inline-Styles gibt es im Markup noch reichlich; für Styles ist das
    // deutlich unkritischer als für Skripte.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "media-src 'self'",
    "connect-src 'self' ws: wss: https://api.chess.com https://cdnjs.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ');

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// =========================================================
// 1. MONGODB
// =========================================================
let dbReady = false;
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => { dbReady = true; console.log('MongoDB verbunden.'); })
        .catch(err => console.error('MongoDB Fehler:', err.message));
    mongoose.connection.on('disconnected', () => { dbReady = false; });
    mongoose.connection.on('connected', () => { dbReady = true; });
} else {
    console.warn('WARN: MONGODB_URI nicht gesetzt — Login, Stats und Leaderboard sind deaktiviert.');
}

/** Guard für alle DB-Routen, damit ohne DB nichts 500t. */
function requireDb(res) {
    if (dbReady) return true;
    res.status(503).json({ error: 'Database unavailable' });
    return false;
}

// =========================================================
// 2. SESSION & TWITCH LOGIN
// =========================================================
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'cager.sid',
    // Vorher MemoryStore: jeder Deploy loggte alle User aus und der Speicher
    // wuchs unbegrenzt. connect-mongo war bereits eine Dependency.
    store: process.env.MONGODB_URI
        ? MongoStore.create({ mongoUrl: process.env.MONGODB_URI, ttl: 14 * 24 * 60 * 60 })
        : undefined,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PROD,
        maxAge: 14 * 24 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
    passport.use(new TwitchStrategy({
        clientID: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET,
        callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/twitch/callback',
        scope: 'user_read'
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            let user = await User.findOne({ twitchId: profile.id });
            if (!user) {
                user = await User.create({
                    twitchId: profile.id,
                    displayName: profile.display_name,
                    profileImageUrl: profile.profile_image_url
                });
            } else {
                user.displayName = profile.display_name;
                user.profileImageUrl = profile.profile_image_url;
                await user.save();
            }
            return done(null, user);
        } catch (err) { return done(err); }
    }));
} else {
    console.warn('WARN: TWITCH_CLIENT_ID/SECRET nicht gesetzt — Twitch-Login ist deaktiviert.');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        if (!dbReady) return done(null, false);
        const user = await User.findById(id);
        done(null, user || false);
    } catch (err) { done(null, false); }
});

// =========================================================
// 3. HILFSFUNKTIONEN
// =========================================================

/** Öffentliche Sicht auf einen User — nie das ganze Mongoose-Dokument. */
function publicUser(u) {
    if (!u) return null;
    return {
        displayName: u.displayName,
        profileImageUrl: u.profileImageUrl || '',
        stats: u.stats || {}
    };
}

/** Escaped alle Regex-Metazeichen. Ohne das: Regex-Injection + ReDoS. */
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VALID_MODES = ['chess', 'mutant', 'bot', 'prediction'];
const VALID_RESULTS = ['win', 'loss', 'draw'];

/**
 * Server-autoritative Statistik-Buchung. Wird ausschließlich intern
 * aufgerufen, wenn der Server selbst das Spielende festgestellt hat.
 */
async function recordResult(userId, mode, result) {
    if (!dbReady || !userId) return;
    if (!VALID_MODES.includes(mode) || !VALID_RESULTS.includes(result)) return;
    const field = `stats.${mode}.${result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws'}`;
    try {
        await User.updateOne({ _id: userId }, { $inc: { [field]: 1 } });
    } catch (err) {
        console.error('recordResult Fehler:', err.message);
    }
}

/** Bucht das Ergebnis für beide Spieler eines Raums. */
async function recordRoomResult(room, mode, winnerColor) {
    if (!room || room.statsRecorded) return;
    room.statsRecorded = true;
    const pairs = [
        { p: room.players.w, color: 'w' },
        { p: room.players.b, color: 'b' }
    ];
    for (const { p, color } of pairs) {
        if (!p || !p.userId) continue;
        const result = winnerColor === null ? 'draw' : (winnerColor === color ? 'win' : 'loss');
        await recordResult(p.userId, mode, result);
    }
}

/** Holt den eingeloggten User eines Sockets (oder null bei Gast). */
function socketUser(socket) {
    const u = socket.request && socket.request.user;
    return (u && u.id) ? u : null;
}

/** Kürzt und säubert einen frei wählbaren Anzeigenamen. */
function sanitizeName(name, fallback) {
    if (typeof name !== 'string') return fallback;
    const clean = name.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 24);
    return clean || fallback;
}

/** Nur http(s)-URLs als Profilbild zulassen. */
function sanitizePfp(url) {
    if (typeof url !== 'string') return '';
    const t = url.trim();
    return /^https?:\/\//i.test(t) && t.length <= 500 ? t : '';
}

function sanitizeRoomCode(code) {
    if (typeof code !== 'string') return '';
    const c = code.trim().toUpperCase();
    return /^[A-Z0-9]{1,12}$/.test(c) ? c : '';
}

function clampNumber(v, min, max, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function sanitizeCooldowns(input) {
    const out = {};
    Object.keys(DEFAULT_COOLDOWNS).forEach(k => {
        out[k] = Math.round(clampNumber(
            input && input[k], COOLDOWN_BOUNDS.min, COOLDOWN_BOUNDS.max, DEFAULT_COOLDOWNS[k]
        ));
    });
    return out;
}

function generateRoomCode() {
    // crypto statt Math.random: Raumcodes sind nicht mehr erratbar.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) out += chars[bytes[i] % chars.length];
    return out;
}

function generatePlayerId() {
    return crypto.randomBytes(12).toString('hex');
}

/**
 * Wrappt einen Socket-Handler. Vorher konnte ein einziges Event mit
 * fromR:99 den kompletten Prozess beenden — inklusive aller laufenden Partien.
 */
function safeHandler(socket, name, fn) {
    return function (payload) {
        try {
            // Nutzlast normalisieren statt verwerfen: Socket.IO ruft manche
            // Events (z.B. 'disconnecting') mit einem String-Grund auf.
            const safe = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
            fn(safe);
        } catch (err) {
            console.error(`Socket-Handler "${name}" Fehler:`, err && err.stack ? err.stack : err);
            try { socket.emit('error_msg', 'Server error — action ignored.'); } catch (e) { /* egal */ }
        }
    };
}

// =========================================================
// 4. HTTP RATE LIMIT (leichtgewichtig, ohne Dependency)
// =========================================================
const httpBuckets = new Map();

function rateLimit({ windowMs, max, keyPrefix }) {
    return (req, res, next) => {
        const key = keyPrefix + ':' + (req.user ? req.user.id : req.ip);
        const now = Date.now();
        let bucket = httpBuckets.get(key);
        if (!bucket || now > bucket.reset) {
            bucket = { count: 0, reset: now + windowMs };
            httpBuckets.set(key, bucket);
        }
        bucket.count++;
        if (bucket.count > max) {
            return res.status(429).json({ error: 'Too many requests, slow down.' });
        }
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of httpBuckets) if (now > v.reset) httpBuckets.delete(k);
}, 60_000).unref();

// =========================================================
// 5. ROUTES & APIS
// =========================================================
app.get('/auth/twitch', passport.authenticate('twitch'));
app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: '/' }),
    (req, res) => res.redirect('/')
);
app.get('/auth/logout', (req, res) => {
    req.logout(() => { req.session.destroy(() => res.redirect('/')); });
});

app.get('/api/user', (req, res) => {
    if (!req.user) return res.json(null);
    res.json({
        displayName: req.user.displayName,
        profileImageUrl: req.user.profileImageUrl || '',
        stats: req.user.stats || {}
    });
});

app.get('/api/users/search',
    rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'search' }),
    async (req, res) => {
        if (!requireDb(res)) return;
        try {
            const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
            if (raw.length < 2 || raw.length > 32) return res.json([]);

            // escapeRegex verhindert Regex-Injection ("." listete vorher alles)
            // und ReDoS ("(a+)+$" blockierte den Event-Loop).
            const safe = escapeRegex(raw);
            const users = await User.find({ displayName: new RegExp(safe, 'i') })
                .select('displayName profileImageUrl stats')
                .limit(5)
                .lean();

            res.json(users.map(publicUser));
        } catch (err) {
            console.error('Search Fehler:', err.message);
            res.status(500).json({ error: 'Search failed' });
        }
    }
);

/**
 * Nur noch für den Bot-Modus. Multiplayer-Ergebnisse bucht der Server
 * selbst (siehe recordRoomResult) — der Client kann sie nicht mehr melden.
 *
 * Der Bot-Modus läuft komplett im Browser, deshalb bleibt hier eine
 * Client-Meldung unvermeidbar. Sie ist aber eng begrenzt:
 * ein Ergebnis pro 20 Sekunden und maximal 100 pro Tag.
 */
app.post('/api/stats/update',
    rateLimit({ windowMs: 20_000, max: 1, keyPrefix: 'stats-burst' }),
    rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 100, keyPrefix: 'stats-day' }),
    async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Not logged in' });
        if (!requireDb(res)) return;

        const { mode, result } = req.body || {};
        if (mode !== 'bot') {
            return res.status(403).json({ error: 'Only bot results can be reported by the client.' });
        }
        if (!VALID_RESULTS.includes(result)) {
            return res.status(400).json({ error: 'Invalid result' });
        }

        try {
            await recordResult(req.user.id, 'bot', result);
            const fresh = await User.findById(req.user.id).select('stats').lean();
            res.json({ success: true, stats: fresh ? fresh.stats : {} });
        } catch (err) {
            console.error('Stats-Update Fehler:', err.message);
            res.status(500).json({ error: 'Could not update stats' });
        }
    }
);

app.get('/api/leaderboard',
    rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'lb' }),
    async (req, res) => {
        if (!requireDb(res)) return;
        try {
            // Vorher: User.find({}) lud die komplette Collection in den Speicher
            // und sortierte in JS. Jetzt macht das die Datenbank.
            const users = await User.aggregate([
                {
                    $addFields: {
                        totalWins: {
                            $add: [
                                { $ifNull: ['$stats.chess.wins', 0] },
                                { $ifNull: ['$stats.mutant.wins', 0] },
                                { $ifNull: ['$stats.bot.wins', 0] }
                            ]
                        }
                    }
                },
                { $match: { totalWins: { $gt: 0 } } },
                { $sort: { totalWins: -1 } },
                { $limit: 3 },
                { $project: { _id: 0, displayName: 1, profileImageUrl: 1, stats: 1, totalWins: 1 } }
            ]);
            res.json(users);
        } catch (err) {
            console.error('Leaderboard Fehler:', err.message);
            res.status(500).json({ error: 'Leaderboard failed' });
        }
    }
);

// =========================================================
// 6. STATISCHE VERZEICHNISSE
// =========================================================
/**
 * Cache-Strategie.
 *
 * Vorher galt in Produktion pauschal `max-age=1h` — auch fuer HTML und JS.
 * Nach einem Deploy holte der Browser eine Stunde lang gar nichts Neues und
 * mischte alte mit neuen Dateien. Das Symptom war z.B. eine veraltete
 * `shared/move-gen.js` neben einer neuen `client.js`:
 * "MoveGen.legalMoves is not a function", ohne dass irgendwer einen Fehler
 * gemacht haette.
 *
 * Code und Markup werden deshalb immer revalidiert. Dank ETag antwortet der
 * Server dabei fast immer mit 304 (kein Body), das kostet praktisch nichts.
 * Bilder und Sounds aendern sich nie und duerfen lange liegenbleiben.
 */
const staticOpts = {
    etag: true,
    maxAge: 0,
    setHeaders(res, filePath) {
        if (/\.(html|js|css|json)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (IS_PROD) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
};
// Ausgerechnet /shared lag vorher 7 Tage im Browser-Cache — also genau die
// Dateien, die alle Modi gemeinsam benutzen (move-gen.js, items.js, ...).
// Nach einem Deploy lief der Client dadurch gegen eine veraltete Bibliothek.
// Jetzt gilt auch hier: Code revalidieren, Sounds duerfen liegenbleiben.
app.use('/shared', express.static(path.join(__dirname, 'public/shared'), staticOpts));
app.use(express.static(path.join(__dirname, 'public/hub'), staticOpts));
app.use('/chess', express.static(path.join(__dirname, 'public/chess'), staticOpts));
app.use('/mutant-chess', express.static(path.join(__dirname, 'public/mutant-chess'), staticOpts));
app.use('/prediction-chess', express.static(path.join(__dirname, 'public/prediction-chess'), staticOpts));
app.use('/play-cager', express.static(path.join(__dirname, 'public/play-cager'), staticOpts));



// =========================================================
// 7. GEMEINSAME SOCKET-INFRASTRUKTUR
// =========================================================
const socketRateLimits = new Map();
const RATE_MAX_PER_SECOND = 20;

function checkRateLimit(socketId) {
    const now = Date.now();
    let limit = socketRateLimits.get(socketId);
    if (!limit || now > limit.resetTime) {
        limit = { count: 1, resetTime: now + 1000 };
        socketRateLimits.set(socketId, limit);
        return true;
    }
    limit.count++;
    return limit.count <= RATE_MAX_PER_SECOND;
}

const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS, 10) || 3 * 60 * 60 * 1000;
const FINISHED_ROOM_GRACE_MS = parseInt(process.env.ROOM_GRACE_MS, 10) || 2 * 60 * 1000;
const DISCONNECT_FORFEIT_MS = parseInt(process.env.FORFEIT_MS, 10) || 30_000;
const ROOM_SWEEP_MS = parseInt(process.env.ROOM_SWEEP_MS, 10) || 5 * 60 * 1000;

/** Räumt alle Timer eines Raums ab und entfernt ihn aus der Map. */
function destroyRoom(map, code) {
    const room = map.get(code);
    if (!room) return;
    ['w', 'b'].forEach(col => {
        if (room.disconnectTimers && room.disconnectTimers[col]) {
            clearTimeout(room.disconnectTimers[col]);
            room.disconnectTimers[col] = null;
        }
    });
    if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
    map.delete(code);
}

/** Nach Spielende: kurze Gnadenfrist, dann Raum löschen (vorher: nie). */
function scheduleRoomCleanup(map, code) {
    const room = map.get(code);
    if (!room || room.cleanupTimer) return;
    room.cleanupTimer = setTimeout(() => destroyRoom(map, code), FINISHED_ROOM_GRACE_MS);
    if (room.cleanupTimer.unref) room.cleanupTimer.unref();
}

/** Sweeper gegen verwaiste Lobbys, die nie ein Spielende erreichen. */
function sweepRooms(map) {
    const now = Date.now();
    for (const [code, room] of map) {
        const idle = now - (room.lastActivity || 0);
        const bothGone = (!room.players.w || !room.players.w.connected) &&
                         (!room.players.b || !room.players.b.connected);
        if (idle > ROOM_TTL_MS || (bothGone && idle > FINISHED_ROOM_GRACE_MS)) {
            destroyRoom(map, code);
        }
    }
}

function touch(room) { room.lastActivity = Date.now(); }

// =========================================================
// 8. CAGERS QUICK CHESS, HUB-CHAT & ONLINE-ZÄHLER
// =========================================================
const rooms = new Map();
const hubChatHistory = [];
const HUB_CHAT_MAX = 50;

let lastOnlineCount = -1;
function broadcastOnlineCount(force) {
    const count = io.engine.clientsCount;
    if (!force && count === lastOnlineCount) return;
    lastOnlineCount = count;
    io.emit('online_players_count', count);
}
setInterval(() => broadcastOnlineCount(true), 30_000).unref();
setInterval(() => { sweepRooms(rooms); sweepRooms(mutantRooms); }, ROOM_SWEEP_MS).unref();

/** Beendet eine Quick-Chess-Partie server-autoritativ. */
function endChessGame(code, winnerColor, reason) {
    const room = rooms.get(code);
    if (!room || room.isGameOver) return;
    room.isGameOver = true;
    ['w', 'b'].forEach(col => {
        if (room.disconnectTimers[col]) { clearTimeout(room.disconnectTimers[col]); room.disconnectTimers[col] = null; }
    });
    recordRoomResult(room, 'chess', winnerColor);
    io.to(code).emit('game_over', { winnerColor, reason });
    scheduleRoomCleanup(rooms, code);
}

io.on('connection', (socket) => {
    broadcastOnlineCount(false);
    socket.emit('hub_chat_history', hubChatHistory);

    socket.on('disconnect', () => {
        socketRateLimits.delete(socket.id);
        broadcastOnlineCount(false);
    });

    socket.on('send_hub_chat', safeHandler(socket, 'send_hub_chat', ({ text }) => {
        if (!checkRateLimit(socket.id)) return;

        // Absender kommt ausschließlich aus der Passport-Session.
        const reqUser = socketUser(socket);
        if (!reqUser) return socket.emit('error_msg', 'Log in to chat.');
        if (typeof text !== 'string') return;

        const cleanText = text.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 150);
        if (!cleanText) return;

        const newMsg = {
            name: reqUser.displayName,
            pfp: sanitizePfp(reqUser.profileImageUrl),
            text: cleanText,
            timestamp: Date.now()
        };

        hubChatHistory.push(newMsg);
        if (hubChatHistory.length > HUB_CHAT_MAX) hubChatHistory.shift();
        io.emit('receive_hub_chat', newMsg);
    }));

    socket.on('create_room', safeHandler(socket, 'create_room', ({ playerName, isClassLock, customCooldowns, pfp }) => {
        if (!checkRateLimit(socket.id)) return;

        const user = socketUser(socket);
        const roomCode = generateRoomCode();
        const playerId = generatePlayerId();
        const cds = sanitizeCooldowns(customCooldowns);
        const classLock = isClassLock !== undefined ? !!isClassLock : true;

        rooms.set(roomCode, {
            isClassLock: classLock,
            customCooldowns: cds,
            players: {
                w: {
                    socketId: socket.id, playerId,
                    name: user ? user.displayName : sanitizeName(playerName, 'Player 1'),
                    pfp: user ? sanitizePfp(user.profileImageUrl) : sanitizePfp(pfp),
                    userId: user ? user.id : null,
                    ready: false, connected: true
                },
                b: null
            },
            board: MoveGen.createInitialBoard(),
            typeCooldowns: null,
            singleCooldowns: null,
            hasMoved: MoveGen.createHasMoved(),
            enPassantTarget: null,
            isGameStarted: false,
            isGameOver: false,
            statsRecorded: false,
            disconnectTimers: { w: null, b: null },
            cleanupTimer: null,
            lastActivity: Date.now()
        });

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, playerId, color: 'w', isClassLock: classLock, customCooldowns: cds });
    }));

    socket.on('join_room', safeHandler(socket, 'join_room', ({ roomCode, playerName, pfp }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = rooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        if (room.isGameOver) return socket.emit('error_msg', 'This game is already over!');
        if (room.players.b && room.players.b.connected) return socket.emit('error_msg', 'Room is full!');
        if (room.players.w && room.players.w.socketId === socket.id) {
            return socket.emit('error_msg', 'You are already in this room!');
        }

        const user = socketUser(socket);
        const playerId = generatePlayerId();
        room.players.b = {
            socketId: socket.id, playerId,
            name: user ? user.displayName : sanitizeName(playerName, 'Player 2'),
            pfp: user ? sanitizePfp(user.profileImageUrl) : sanitizePfp(pfp),
            userId: user ? user.id : null,
            ready: false, connected: true
        };
        touch(room);
        socket.join(code);

        socket.emit('room_joined', {
            roomCode: code, playerId, color: 'b',
            isClassLock: room.isClassLock, customCooldowns: room.customCooldowns,
            opponentName: room.players.w.name, opponentPfp: room.players.w.pfp,
            hasMoved: room.hasMoved, enPassantTarget: room.enPassantTarget
        });
        socket.to(code).emit('opponent_joined', {
            opponentName: room.players.b.name, opponentPfp: room.players.b.pfp
        });
    }));

    socket.on('reconnect_room', safeHandler(socket, 'reconnect_room', ({ roomCode, playerId, playerColor }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        if (playerColor !== 'w' && playerColor !== 'b') return socket.emit('error_msg', 'Invalid session!');
        const room = rooms.get(code);
        if (!room || !room.players[playerColor]) return socket.emit('error_msg', 'Room or session expired!');

        const player = room.players[playerColor];
        if (typeof playerId !== 'string' || player.playerId !== playerId) {
            return socket.emit('error_msg', 'Invalid session credentials!');
        }

        player.socketId = socket.id;
        player.connected = true;
        touch(room);

        if (room.disconnectTimers[playerColor]) {
            clearTimeout(room.disconnectTimers[playerColor]);
            room.disconnectTimers[playerColor] = null;
        }

        socket.join(code);
        const opponent = room.players[playerColor === 'w' ? 'b' : 'w'];

        socket.emit('room_reconnected', {
            roomCode: code, playerId, color: playerColor,
            isClassLock: room.isClassLock,
            customCooldowns: room.customCooldowns,
            board: room.board,
            typeCooldowns: room.typeCooldowns,
            singleCooldowns: room.singleCooldowns,
            // Vorher fehlten diese beiden -> nach jedem Reconnect bot der
            // Client eine Rochade an, die der Server als Cheat ablehnte.
            hasMoved: room.hasMoved,
            enPassantTarget: room.enPassantTarget,
            isGameStarted: room.isGameStarted,
            isGameOver: room.isGameOver,
            opponentName: opponent ? opponent.name : '',
            opponentPfp: opponent ? opponent.pfp : '',
            playersReady: [
                { color: 'w', ready: !!(room.players.w && room.players.w.ready) },
                { color: 'b', ready: !!(room.players.b && room.players.b.ready) }
            ]
        });

        socket.to(code).emit('opponent_reconnected', { color: playerColor });
    }));

    socket.on('player_ready', safeHandler(socket, 'player_ready', ({ roomCode }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = rooms.get(code);
        if (!room || room.isGameOver) return;

        // Identität über die Socket-ID, nicht über eine mitgeschickte playerId.
        let color = null;
        if (room.players.w && room.players.w.socketId === socket.id) color = 'w';
        else if (room.players.b && room.players.b.socketId === socket.id) color = 'b';
        if (!color) return;

        room.players[color].ready = true;
        touch(room);

        const playersReady = [
            { color: 'w', ready: !!(room.players.w && room.players.w.ready) },
            { color: 'b', ready: !!(room.players.b && room.players.b.ready) }
        ];
        io.to(code).emit('ready_update', { playersReady });

        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready && !room.isGameStarted) {
            if (room.isClassLock) {
                room.typeCooldowns = {
                    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
                    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }
                };
            } else {
                room.singleCooldowns = Array.from({ length: 8 }, () => Array(8).fill(0));
            }
            room.isGameStarted = true;
            io.to(code).emit('start_match_countdown', {
                typeCooldowns: room.typeCooldowns,
                singleCooldowns: room.singleCooldowns,
                isClassLock: room.isClassLock,
                customCooldowns: room.customCooldowns
            });
        }
    }));

    socket.on('select_square', safeHandler(socket, 'select_square', ({ roomCode, r, c }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        if (!rooms.has(code)) return;
        const rr = (r === null || r === undefined) ? null : (MoveGen.isValidIndex(r) ? r : null);
        const cc = (c === null || c === undefined) ? null : (MoveGen.isValidIndex(c) ? c : null);
        socket.to(code).emit('opponent_select_square', { r: rr, c: cc });
    }));

    socket.on('request_move', safeHandler(socket, 'request_move', (moveData) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(moveData.roomCode);
        const room = rooms.get(code);
        if (!room || !room.board || room.isGameOver || !room.isGameStarted) return;

        const { fromR, fromC, toR, toC } = moveData;
        // Bounds-Check VOR jedem Board-Zugriff — das war der Ein-Event-Crash.
        if (!MoveGen.validCoords(fromR, fromC, toR, toC)) {
            return socket.emit('error_msg', 'Invalid coordinates.');
        }

        const color = (room.players.w && room.players.w.socketId === socket.id) ? 'w'
                    : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!color) return;

        const piece = room.board[fromR][fromC];
        if (!piece) return socket.emit('error_msg', 'No piece at source square.');
        if (MoveGen.colorOf(piece) !== color) return socket.emit('error_msg', 'Not your piece.');

        const now = Date.now();
        const pieceKey = piece.toLowerCase();

        if (room.isClassLock) {
            if (!room.typeCooldowns) return;
            if (room.typeCooldowns[color][pieceKey] > now) return socket.emit('error_msg', 'Piece is on cooldown!');
        } else {
            if (!room.singleCooldowns) return;
            if (room.singleCooldowns[fromR][fromC] > now) return socket.emit('error_msg', 'Square is on cooldown!');
        }

        // Dieselbe Funktion, die auch der Client benutzt -> keine Divergenz.
        const validMoves = MoveGen.classicMoves(room.board, fromR, fromC, {
            enPassantTarget: room.enPassantTarget,
            hasMoved: room.hasMoved
        });
        const validMove = validMoves.find(m => m.r === toR && m.c === toC);
        if (!validMove) return socket.emit('error_msg', 'Illegal move.');

        MoveGen.updateCastlingRights(room.hasMoved, piece, fromR, fromC, toR, toC, room.board);

        if (pieceKey === 'p' && Math.abs(toR - fromR) === 2) {
            room.enPassantTarget = { r: (fromR + toR) / 2, c: fromC, color };
        } else {
            room.enPassantTarget = null;
        }

        // Beförderung serverseitig validieren UND das Ergebnis in der
        // Broadcast-Nutzlast überschreiben (vorher wurde moveData roh
        // weitergereicht: promotedTo:'k' erzeugte Desync, 'X' crashte den Gegner).
        let finalPiece = piece;
        let promotedTo = null;
        if (pieceKey === 'p' && (toR === 0 || toR === 7)) {
            const allowed = color === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b'];
            promotedTo = allowed.includes(moveData.promotedTo) ? moveData.promotedTo : (color === 'w' ? 'Q' : 'q');
            finalPiece = promotedTo;
        }

        room.board[fromR][fromC] = null;

        if (validMove.type === 'castle') {
            const rFromC = toC === 6 ? 7 : 0;
            const rToC = toC === 6 ? 5 : 3;
            room.board[fromR][rToC] = room.board[fromR][rFromC];
            room.board[fromR][rFromC] = null;
        } else if (validMove.type === 'en_passant') {
            const captureRow = color === 'w' ? toR + 1 : toR - 1;
            if (MoveGen.isValidIndex(captureRow)) room.board[captureRow][toC] = null;
        }

        const captured = room.board[toR][toC];
        const kingCaptured = !!(captured && captured.toLowerCase() === 'k');
        room.board[toR][toC] = finalPiece;

        const cdDuration = room.customCooldowns[finalPiece.toLowerCase()] !== undefined
            ? room.customCooldowns[finalPiece.toLowerCase()]
            : DEFAULT_COOLDOWNS.p;
        const cdEndTime = now + cdDuration;

        if (room.isClassLock) {
            room.typeCooldowns[color][finalPiece.toLowerCase()] = cdEndTime;
        } else {
            room.singleCooldowns[toR][toC] = cdEndTime;
            room.singleCooldowns[fromR][fromC] = 0;
        }

        touch(room);

        // Sanitisierte Nutzlast: nur Werte, die der Server selbst bestimmt hat.
        const duration = Math.round(clampNumber(moveData.duration, 150, 3000, 500));
        io.to(code).emit('apply_move', {
            playerId: room.players[color].playerId,
            fromR, fromC, toR, toC,
            moveInfo: validMove,
            promotedTo,
            duration,
            captured: captured || null,
            hasMoved: room.hasMoved,
            enPassantTarget: room.enPassantTarget
        });

        if (kingCaptured) {
            // Ergebnis kommt jetzt vom Server, nicht mehr aus dem Browser.
            endChessGame(code, color, 'king');
        }
    }));

    socket.on('disconnecting', safeHandler(socket, 'disconnecting', () => {
        socket.rooms.forEach(code => {
            const room = rooms.get(code);
            if (!room) return;

            let discColor = null;
            if (room.players.w && room.players.w.socketId === socket.id) discColor = 'w';
            else if (room.players.b && room.players.b.socketId === socket.id) discColor = 'b';
            if (!discColor) return;

            room.players[discColor].connected = false;
            touch(room);

            if (room.isGameOver) { scheduleRoomCleanup(rooms, code); return; }
            if (!room.isGameStarted) {
                // Lobby ohne Spielstart: kein Forfeit, nur aufräumen wenn leer.
                const other = room.players[discColor === 'w' ? 'b' : 'w'];
                if (!other || !other.connected) scheduleRoomCleanup(rooms, code);
                return;
            }

            socket.to(code).emit('opponent_disconnected', {
                color: discColor,
                countdownSeconds: DISCONNECT_FORFEIT_MS / 1000
            });

            if (room.disconnectTimers[discColor]) clearTimeout(room.disconnectTimers[discColor]);
            room.disconnectTimers[discColor] = setTimeout(() => {
                const live = rooms.get(code);
                if (!live || live.isGameOver) return;
                if (live.players[discColor] && live.players[discColor].connected) return;
                endChessGame(code, discColor === 'w' ? 'b' : 'w', 'disconnect');
            }, DISCONNECT_FORFEIT_MS);
            if (room.disconnectTimers[discColor].unref) room.disconnectTimers[discColor].unref();
        });
    }));
});

// =========================================================
// 9. MUTANT MERGE CHESS
// =========================================================
const mutantIo = io.of('/mutant-chess');
const mutantRooms = new Map();

/** Verbleibende Bedenkzeit inklusive der laufenden Uhr. */
function remainingClock(room, color) {
    const base = room.clocks[color];
    if (!room.isGameStarted || room.isGameOver || room.turn !== color || !room.lastTurnTimestamp) return base;
    return base - (Date.now() - room.lastTurnTimestamp) / 1000;
}

function liveClocks(room) {
    return { w: Math.max(0, remainingClock(room, 'w')), b: Math.max(0, remainingClock(room, 'b')) };
}

function endMutantGame(code, winnerColor, reason) {
    const room = mutantRooms.get(code);
    if (!room || room.isGameOver) return;
    room.isGameOver = true;
    ['w', 'b'].forEach(col => {
        if (room.disconnectTimers[col]) { clearTimeout(room.disconnectTimers[col]); room.disconnectTimers[col] = null; }
    });
    recordRoomResult(room, 'mutant', winnerColor);
    mutantIo.to(code).emit('game_over', { winnerColor, reason });
    scheduleRoomCleanup(mutantRooms, code);
}

/**
 * Server-Uhr. Vorher wurden die Uhren NUR beim Zugempfang dekrementiert —
 * dadurch fror jede Partie bei 00:00 dauerhaft ein, statt dass jemand
 * auf Zeit gewann.
 */
setInterval(() => {
    for (const [code, room] of mutantRooms) {
        if (!room.isGameStarted || room.isGameOver || !room.lastTurnTimestamp) continue;
        if (remainingClock(room, room.turn) <= 0) {
            room.clocks[room.turn] = 0;
            endMutantGame(code, room.turn === 'w' ? 'b' : 'w', 'time');
        }
    }
}, 500).unref();

/** Uhren-Sync an die Clients, damit lokale Ticker nicht wegdriften. */
setInterval(() => {
    for (const [code, room] of mutantRooms) {
        if (!room.isGameStarted || room.isGameOver) continue;
        mutantIo.to(code).emit('clock_sync', { clocks: liveClocks(room), turn: room.turn });
    }
}, 3000).unref();

mutantIo.on('connection', (socket) => {

    socket.on('disconnect', () => { socketRateLimits.delete(socket.id); });

    socket.on('create_mutant_room', safeHandler(socket, 'create_mutant_room', (data) => {
        if (!checkRateLimit(socket.id)) return;
        const user = socketUser(socket);
        const roomCode = generateRoomCode();
        const playerId = generatePlayerId();

        const colorChoice = ['w', 'b', 'random'].includes(data.colorChoice) ? data.colorChoice : 'random';
        const hostColor = colorChoice === 'random' ? (crypto.randomBytes(1)[0] < 128 ? 'w' : 'b') : colorChoice;

        const totalTime = Math.round(clampNumber(data.totalTime, 1, 60, 3));
        const increment = Math.round(clampNumber(data.increment, 0, 60, 2));
        const limitFusions = Math.round(clampNumber(data.maxFusions, 0, 16, 3));

        const player = {
            socketId: socket.id, playerId,
            name: user ? user.displayName : sanitizeName(data.playerName, 'Player 1'),
            pfp: user ? sanitizePfp(user.profileImageUrl) : sanitizePfp(data.pfp),
            userId: user ? user.id : null,
            ready: false, connected: true
        };

        const roomData = {
            players: { w: hostColor === 'w' ? player : null, b: hostColor === 'b' ? player : null },
            board: MoveGen.createInitialMutantBoard(),
            turn: 'w',
            timeControl: { minutes: totalTime, increment },
            clocks: { w: totalTime * 60, b: totalTime * 60 },
            maxFusions: limitFusions,
            fusionsLeft: { w: limitFusions, b: limitFusions },
            allowKingFusion: data.allowKingFusion !== undefined ? !!data.allowKingFusion : true,
            hasMoved: MoveGen.createHasMoved(),
            enPassantTarget: null,
            lastTurnTimestamp: null,
            hostColor,
            isGameStarted: false,
            isGameOver: false,
            statsRecorded: false,
            disconnectTimers: { w: null, b: null },
            cleanupTimer: null,
            lastActivity: Date.now()
        };

        mutantRooms.set(roomCode, roomData);
        socket.join(roomCode);
        socket.emit('mutant_room_created', {
            roomCode, playerId, color: hostColor,
            playerName: player.name, pfp: player.pfp,
            timeControl: roomData.timeControl, clocks: roomData.clocks,
            maxFusions: roomData.maxFusions, fusionsLeft: roomData.fusionsLeft,
            allowKingFusion: roomData.allowKingFusion,
            hasMoved: roomData.hasMoved, enPassantTarget: null
        });
    }));

    socket.on('join_mutant_room', safeHandler(socket, 'join_mutant_room', ({ roomCode, playerName, pfp }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = mutantRooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        if (room.isGameOver) return socket.emit('error_msg', 'This game is already over!');

        const joinerColor = room.players.w ? 'b' : 'w';
        if (room.players[joinerColor] && room.players[joinerColor].connected) {
            return socket.emit('error_msg', 'Room is full!');
        }
        const host = room.players[joinerColor === 'w' ? 'b' : 'w'];
        if (host && host.socketId === socket.id) return socket.emit('error_msg', 'You are already in this room!');

        const user = socketUser(socket);
        const playerId = generatePlayerId();
        room.players[joinerColor] = {
            socketId: socket.id, playerId,
            name: user ? user.displayName : sanitizeName(playerName, 'Player 2'),
            pfp: user ? sanitizePfp(user.profileImageUrl) : sanitizePfp(pfp),
            userId: user ? user.id : null,
            ready: false, connected: true
        };
        touch(room);
        socket.join(code);

        const opponent = room.players[joinerColor === 'w' ? 'b' : 'w'];
        socket.emit('mutant_room_joined', {
            roomCode: code, playerId, color: joinerColor,
            opponentName: opponent ? opponent.name : '', opponentPfp: opponent ? opponent.pfp : '',
            timeControl: room.timeControl, clocks: room.clocks,
            maxFusions: room.maxFusions, fusionsLeft: room.fusionsLeft,
            allowKingFusion: room.allowKingFusion,
            hasMoved: room.hasMoved, enPassantTarget: room.enPassantTarget
        });
        socket.to(code).emit('mutant_opponent_joined', {
            opponentName: room.players[joinerColor].name,
            opponentPfp: room.players[joinerColor].pfp
        });
    }));

    socket.on('reconnect_mutant_room', safeHandler(socket, 'reconnect_mutant_room', ({ roomCode, playerId, playerColor }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        if (playerColor !== 'w' && playerColor !== 'b') return socket.emit('error_msg', 'Invalid session!');
        const room = mutantRooms.get(code);
        if (!room || !room.players[playerColor]) return socket.emit('error_msg', 'Room or session expired!');

        const player = room.players[playerColor];
        if (typeof playerId !== 'string' || player.playerId !== playerId) {
            return socket.emit('error_msg', 'Invalid session credentials!');
        }

        player.socketId = socket.id;
        player.connected = true;
        touch(room);

        if (room.disconnectTimers[playerColor]) {
            clearTimeout(room.disconnectTimers[playerColor]);
            room.disconnectTimers[playerColor] = null;
        }

        socket.join(code);
        const opponent = room.players[playerColor === 'w' ? 'b' : 'w'];

        socket.emit('mutant_room_reconnected', {
            roomCode: code, playerId, color: playerColor,
            board: room.board,
            turn: room.turn,
            clocks: liveClocks(room),
            fusionsLeft: room.fusionsLeft,
            maxFusions: room.maxFusions,
            allowKingFusion: room.allowKingFusion,
            // Vorher nicht übertragen -> Rochade-/En-Passant-Rechte gingen verloren.
            hasMoved: room.hasMoved,
            enPassantTarget: room.enPassantTarget,
            isGameStarted: room.isGameStarted,
            isGameOver: room.isGameOver,
            opponentName: opponent ? opponent.name : '',
            opponentPfp: opponent ? opponent.pfp : '',
            playersReady: [
                { color: 'w', ready: !!(room.players.w && room.players.w.ready), name: room.players.w ? room.players.w.name : '' },
                { color: 'b', ready: !!(room.players.b && room.players.b.ready), name: room.players.b ? room.players.b.name : '' }
            ]
        });

        socket.to(code).emit('mutant_opponent_reconnected', { color: playerColor });
    }));

    socket.on('player_ready', safeHandler(socket, 'player_ready', ({ roomCode }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;

        let color = null;
        if (room.players.w && room.players.w.socketId === socket.id) color = 'w';
        else if (room.players.b && room.players.b.socketId === socket.id) color = 'b';
        if (!color) return;

        room.players[color].ready = true;
        touch(room);

        const playersReady = [
            { color: 'w', ready: !!(room.players.w && room.players.w.ready), name: room.players.w ? room.players.w.name : '' },
            { color: 'b', ready: !!(room.players.b && room.players.b.ready), name: room.players.b ? room.players.b.name : '' }
        ];
        mutantIo.to(code).emit('ready_update', { playersReady });

        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready && !room.isGameStarted) {
            room.isGameStarted = true;
            // Countdown im Client ist 5s — die Uhr startet erst danach.
            room.lastTurnTimestamp = Date.now() + 5000;
            mutantIo.to(code).emit('start_match_countdown', {
                clocks: room.clocks, maxFusions: room.maxFusions, fusionsLeft: room.fusionsLeft
            });
        }
    }));

    socket.on('request_mutant_move', safeHandler(socket, 'request_mutant_move', (data) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(data.roomCode);
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver || !room.isGameStarted) return;

        const { fromR, fromC, toR, toC } = data;
        if (!MoveGen.validCoords(fromR, fromC, toR, toC)) {
            return socket.emit('error_msg', 'Invalid coordinates.');
        }

        const senderColor = (room.players.w && room.players.w.socketId === socket.id) ? 'w'
                          : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!senderColor || senderColor !== room.turn) return socket.emit('error_msg', 'Not your turn!');

        const movingPiece = room.board[fromR][fromC];
        if (!movingPiece) return socket.emit('error_msg', 'No piece at source square!');
        const pieceColor = MoveGen.getPieceColor(movingPiece);
        if (pieceColor !== senderColor) return socket.emit('error_msg', 'Not your piece!');

        // ---- Zug-Legalität: vorher gar nicht geprüft (Instant-Win-Cheat) ----
        const legal = MoveGen.mutantMoves(room.board, fromR, fromC, {
            enPassantTarget: room.enPassantTarget,
            hasMoved: room.hasMoved,
            allowKingFusion: room.allowKingFusion,
            fusionsLeft: room.fusionsLeft
        });
        const move = legal.find(m => m.r === toR && m.c === toC);
        if (!move) return socket.emit('error_msg', 'Illegal move.');

        // Uhr: verbrauchte Zeit abrechnen, dann Inkrement gutschreiben.
        const now = Date.now();
        if (room.lastTurnTimestamp) {
            const elapsed = Math.max(0, (now - room.lastTurnTimestamp) / 1000);
            room.clocks[pieceColor] = room.clocks[pieceColor] - elapsed;
            if (room.clocks[pieceColor] <= 0) {
                room.clocks[pieceColor] = 0;
                return endMutantGame(code, pieceColor === 'w' ? 'b' : 'w', 'time');
            }
            room.clocks[pieceColor] += room.timeControl.increment;
        }
        room.lastTurnTimestamp = now;

        const targetPiece = room.board[toR][toC];
        let kingCaptured = false;
        let promotedTo = null;

        if (move.type === 'castle') {
            room.board[toR][toC] = MoveGen.sortCanonically(movingPiece);
            room.board[fromR][fromC] = null;
            const rookFromC = toC === 6 ? 7 : 0;
            const rookToC = toC === 6 ? 5 : 3;
            room.board[fromR][rookToC] = room.board[fromR][rookFromC];
            room.board[fromR][rookFromC] = null;

        } else if (move.type === 'en_passant') {
            const capturedRow = pieceColor === 'w' ? toR + 1 : toR - 1;
            if (MoveGen.isValidIndex(capturedRow)) room.board[capturedRow][toC] = null;
            room.board[toR][toC] = MoveGen.sortCanonically(movingPiece);
            room.board[fromR][fromC] = null;

        } else if (move.type === 'merge') {
            // Nutzt exakt dieselbe Regelprüfung wie der Client.
            const check = MoveGen.checkMergeLegality(
                movingPiece, targetPiece, room.allowKingFusion, room.fusionsLeft[pieceColor]
            );
            if (!check.ok) return socket.emit('error_msg', check.reason);

            const combined = [...movingPiece, ...targetPiece].map(MoveGen.baseChar);
            if (combined.includes('r') && combined.includes('b')) {
                room.board[toR][toC] = [pieceColor === 'w' ? 'Q_fused' : 'q_fused'];
            } else {
                room.board[toR][toC] = MoveGen.sortCanonically([...targetPiece, ...movingPiece]);
            }
            room.board[fromR][fromC] = null;
            room.fusionsLeft[pieceColor]--;

        } else {
            const isPawn = movingPiece.length === 1 && MoveGen.baseChar(movingPiece[0]) === 'p';
            if (isPawn && (toR === 0 || toR === 7)) {
                const allowed = pieceColor === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b'];
                promotedTo = allowed.includes(data.promotedTo) ? data.promotedTo : (pieceColor === 'w' ? 'Q' : 'q');
                if (targetPiece && targetPiece.some(t => t.toLowerCase() === 'k')) kingCaptured = true;
                room.board[toR][toC] = [promotedTo];
            } else {
                if (targetPiece && targetPiece.some(t => t.toLowerCase() === 'k')) kingCaptured = true;
                room.board[toR][toC] = MoveGen.sortCanonically(movingPiece);
            }
            room.board[fromR][fromC] = null;
        }

        MoveGen.updateMutantCastlingRights(room.hasMoved, movingPiece, fromR, fromC, toR, toC);

        const isPawnMove = movingPiece.some(p => MoveGen.baseChar(p) === 'p');
        room.enPassantTarget = (isPawnMove && Math.abs(toR - fromR) === 2)
            ? { r: (fromR + toR) / 2, c: fromC, color: pieceColor }
            : null;

        room.turn = room.turn === 'w' ? 'b' : 'w';
        touch(room);

        mutantIo.to(code).emit('apply_mutant_move', {
            fromR, fromC, toR, toC,
            moveInfo: move,
            promotedTo,
            captured: targetPiece || null,
            board: room.board,
            nextTurn: room.turn,
            clocks: liveClocks(room),
            fusionsLeft: room.fusionsLeft,
            hasMoved: room.hasMoved,
            enPassantTarget: room.enPassantTarget
        });

        if (kingCaptured) endMutantGame(code, pieceColor, 'king');
    }));

    // Der Client meldet Zeitablauf weiterhin; entschieden wird aber über die
    // Server-Uhr (der Sweeper oben tut es ohnehin schon).
    socket.on('time_out', safeHandler(socket, 'time_out', ({ roomCode }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;

        const senderColor = (room.players.w && room.players.w.socketId === socket.id) ? 'w'
                          : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!senderColor) return;

        ['w', 'b'].forEach(col => {
            if (!room.isGameOver && remainingClock(room, col) <= 0) {
                endMutantGame(code, col === 'w' ? 'b' : 'w', 'time');
            }
        });
    }));

    socket.on('resign_game', safeHandler(socket, 'resign_game', ({ roomCode }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;
        const resigningColor = (room.players.w && room.players.w.socketId === socket.id) ? 'w'
                             : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!resigningColor) return;
        endMutantGame(code, resigningColor === 'w' ? 'b' : 'w', 'resign');
    }));

    socket.on('offer_draw', safeHandler(socket, 'offer_draw', ({ roomCode }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;

        const color = (room.players.w && room.players.w.socketId === socket.id) ? 'w'
                    : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!color) return;
        room.drawOfferedBy = color;
        socket.to(code).emit('draw_offered');
    }));

    socket.on('respond_draw', safeHandler(socket, 'respond_draw', ({ roomCode, accepted }) => {
        if (!checkRateLimit(socket.id)) return;
        const code = sanitizeRoomCode(roomCode);
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;

        const senderColor = (room.players.w && room.players.w.socketId === socket.id) ? 'w'
                          : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!senderColor) return;
        // Nur der Gegner des Anbietenden darf annehmen — sonst könnte man
        // sein eigenes Angebot annehmen und jede Partie remis erklären.
        if (!room.drawOfferedBy || room.drawOfferedBy === senderColor) return;

        room.drawOfferedBy = null;
        if (accepted) endMutantGame(code, null, 'draw');
        else socket.to(code).emit('draw_declined');
    }));

    socket.on('disconnecting', safeHandler(socket, 'disconnecting', () => {
        socket.rooms.forEach(code => {
            const room = mutantRooms.get(code);
            if (!room) return;

            let discColor = null;
            if (room.players.w && room.players.w.socketId === socket.id) discColor = 'w';
            else if (room.players.b && room.players.b.socketId === socket.id) discColor = 'b';
            if (!discColor) return;

            room.players[discColor].connected = false;
            touch(room);

            if (room.isGameOver) { scheduleRoomCleanup(mutantRooms, code); return; }
            if (!room.isGameStarted) {
                const other = room.players[discColor === 'w' ? 'b' : 'w'];
                if (!other || !other.connected) scheduleRoomCleanup(mutantRooms, code);
                return;
            }

            socket.to(code).emit('mutant_opponent_disconnected', {
                color: discColor,
                countdownSeconds: DISCONNECT_FORFEIT_MS / 1000
            });

            if (room.disconnectTimers[discColor]) clearTimeout(room.disconnectTimers[discColor]);
            room.disconnectTimers[discColor] = setTimeout(() => {
                const live = mutantRooms.get(code);
                if (!live || live.isGameOver) return;
                if (live.players[discColor] && live.players[discColor].connected) return;
                endMutantGame(code, discColor === 'w' ? 'b' : 'w', 'disconnect');
            }, DISCONNECT_FORFEIT_MS);
            if (room.disconnectTimers[discColor].unref) room.disconnectTimers[discColor].unref();
        });
    }));
});

// =========================================================
// 10. FEHLERBEHANDLUNG & START
// =========================================================
app.use((err, req, res, next) => {
    console.error('HTTP-Fehler:', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    // Sollte durch safeHandler nicht mehr vorkommen — aber lieber loggen als
    // stillschweigend sterben.
    console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

function shutdown(signal) {
    console.log(`${signal} empfangen — fahre herunter…`);
    io.close(() => {
        server.close(() => {
            mongoose.connection.close(false).finally(() => process.exit(0));
        });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// =========================================================
// 10. PREDICTION CHESS
// Eigene Datei, weil dieser Modus deutlich mehr Zustand hat
// (Muenzen, Effekte, Sichtfeld) als die uebrigen.
// =========================================================
const prediction = require('./prediction-chess.js')({
    io, safeHandler, sanitizeName, sanitizePfp, sanitizeRoomCode,
    generateRoomCode, generatePlayerId, socketUser, checkRateLimit,
    recordRoomResult, scheduleRoomCleanup, sweepRooms, touch,
    socketRateLimits, DISCONNECT_FORFEIT_MS, ROOM_SWEEP_MS
});

app.get('/healthz', (req, res) => res.json({
    ok: true,
    db: dbReady,
    uptime: process.uptime(),
    online: io.engine.clientsCount,
    // Diese Zahlen wuchsen vorher monoton — Räume wurden nie gelöscht.
    rooms: { chess: rooms.size, mutant: mutantRooms.size, prediction: prediction.rooms.size }
}));

server.listen(PORT, '0.0.0.0', () => console.log(`Server läuft auf Port ${PORT}`));

module.exports = { app, server, io };
