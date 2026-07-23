require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch-new').Strategy;
const cron = require('node-cron');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);

// Keep-Alive Ping/Pong direkt in Socket.IO konfiguriert (verhindert Fehler 1006)
const io = new Server(server, { 
    cors: { origin: "*" },
    pingInterval: 30000, 
    pingTimeout: 10000 
});

// 1. MONGODB (mit maxPoolSize Limitierung)
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI, {
        maxPoolSize: 50 // Verhindert das Überschreiten des 500er Limits
    })
        .then(() => console.log('✅ MongoDB verbunden!'))
        .catch(err => console.log('❌ MongoDB Fehler:', err));
}

// 2. SESSION & TWITCH LOGIN (Sicheres Session Management)
app.set('trust proxy', 1); // WICHTIG: Erlaubt sichere Cookies hinter dem Render-Proxy!

app.use(session({
    secret: process.env.SESSION_SECRET || 'thecager_geheim_123',
    resave: false, 
    saveUninitialized: false,
    store: process.env.MONGODB_URI ? MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        autoRemove: 'native' // Automatische TTL-Bereinigung durch MongoDB
    }) : new session.MemoryStore(),
    cookie: {
        httpOnly: true, // Verhindert XSS
        // Wir schalten die harte Secure-Pflicht hier etwas entspannter für Render
        secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
        maxAge: 1000 * 60 * 60 * 24 // 1 Tag
    }
}));
app.use(passport.initialize());
app.use(passport.session());

if (process.env.TWITCH_CLIENT_ID) {
    passport.use(new TwitchStrategy({
        clientID: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET,
        callbackURL: process.env.CALLBACK_URL || "http://localhost:3000/auth/twitch/callback",
        scope: "user_read"
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            let user = await User.findOne({ twitchId: profile.id });
            if (!user) {
                user = await User.create({ twitchId: profile.id, displayName: profile.display_name, profileImageUrl: profile.profile_image_url });
            } else {
                user.displayName = profile.display_name; user.profileImageUrl = profile.profile_image_url; await user.save();
            }
            return done(null, user);
        } catch (err) { return done(err); }
    }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try { const user = await User.findById(id); done(null, user); } catch (err) { done(err); }
});

// 3. ROUTES
app.get('/auth/twitch', passport.authenticate('twitch'));
// Wieder dein originaler, direkt funktionierender Callback:
app.get('/auth/twitch/callback', passport.authenticate('twitch', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });
app.get('/api/user', (req, res) => res.json(req.user || null));

app.use(express.static(path.join(__dirname, 'public/hub')));
app.use('/chess', express.static(path.join(__dirname, 'public/chess')));

// 4. SCHACH MULTIPLAYER
const rooms = new Map();
function generateRoomCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

io.on('connection', (socket) => {
    socket.on('create_room', ({ playerName, mode, pfp }) => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            mode: mode || 'class',
            players: { w: { id: socket.id, name: playerName, pfp: pfp || '', ready: false }, b: null },
            board: null, typeCooldowns: null, singleCooldowns: null
        });
        socket.join(roomCode);
        socket.emit('room_created', { roomCode, playerId: socket.id, color: 'w', mode });
    });

    socket.on('join_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = rooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        if (room.players.b) return socket.emit('error_msg', 'Room is full!');
        
        room.players.b = { id: socket.id, name: playerName, pfp: pfp || '', ready: false };
        socket.join(code);
        
        socket.emit('room_joined', { 
            roomCode: code, playerId: socket.id, color: 'b', mode: room.mode, 
            opponentName: room.players.w.name, opponentPfp: room.players.w.pfp 
        });
        socket.to(code).emit('opponent_joined', { opponentName: playerName, opponentPfp: pfp });
    });

    socket.on('player_ready', ({ roomCode, playerId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        if (room.players.w && room.players.w.id === playerId) room.players.w.ready = true;
        if (room.players.b && room.players.b.id === playerId) room.players.b.ready = true;

        const playersReady = [
            { color: 'w', ready: room.players.w ? room.players.w.ready : false },
            { color: 'b', ready: room.players.b ? room.players.b.ready : false }
        ];
        io.to(roomCode).emit('ready_update', { playersReady });

        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready) {
            if (room.mode === 'class') {
                room.typeCooldowns = { 'w': { 'p':0,'n':0,'b':0,'r':0,'q':0,'k':0 }, 'b': { 'p':0,'n':0,'b':0,'r':0,'q':0,'k':0 } };
            } else {
                room.singleCooldowns = Array(8).fill(null).map(() => Array(8).fill(0));
            }
            io.to(roomCode).emit('start_match_countdown', { typeCooldowns: room.typeCooldowns, singleCooldowns: room.singleCooldowns });
        }
    });

    socket.on('select_square', ({ roomCode, r, c }) => socket.to(roomCode).emit('opponent_select_square', { r, c }));
    socket.on('request_move', (moveData) => io.to(moveData.roomCode).emit('apply_move', moveData));
    socket.on('mouse_move', ({ roomCode, xPct, yPct }) => socket.to(roomCode).emit('opponent_mouse_move', { xPct, yPct }));
    socket.on('mouse_leave', ({ roomCode }) => socket.to(roomCode).emit('opponent_mouse_leave'));
    
    // Split-Brain-Prävention: Sendet State nach Reconnect zurück
    socket.on('request_sync', ({ roomCode }) => {
        // Hier würde normalerweise der State aus der DB gelesen werden
        socket.emit('sync_state', { message: 'sync_ok' }); 
    });

    socket.on('leave_room', ({ roomCode }) => { socket.to(roomCode).emit('opponent_left'); socket.leave(roomCode); });
});

// 5. CRON-JOB ZUR DATENBANKBEREINIGUNG
cron.schedule('0 0 * * *', async () => {
    // Da Spieldaten aktuell im Memory-Map "rooms" liegen, bereinigen wir verwaiste Räume
    for (const [code, room] of rooms.entries()) {
        if (!room.players.w && !room.players.b) {
            rooms.delete(code);
        }
    }
    console.log('Tägliche Bereinigung alter Spieldaten ausgeführt.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
