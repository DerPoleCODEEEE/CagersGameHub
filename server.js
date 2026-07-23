require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch-new').Strategy;
const User = require('./models/User');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 1. MONGODB
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ MongoDB verbunden!'))
        .catch(err => console.log('❌ MongoDB Fehler:', err));
}

// 2. SESSION & TWITCH LOGIN
app.use(session({
    secret: process.env.SESSION_SECRET || 'thecager_geheim_123',
    resave: false, saveUninitialized: false
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
app.get('/auth/twitch/callback', passport.authenticate('twitch', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });
app.get('/api/user', (req, res) => res.json(req.user || null));

app.use(express.static(path.join(__dirname, 'public/hub')));
app.use('/chess', express.static(path.join(__dirname, 'public/chess')));
app.use('/mutant-chess', express.static(path.join(__dirname, 'public/mutant-chess')));

// 4. CAGERS QUICK CHESS (UNVERÄNDERT)
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
    socket.on('leave_room', ({ roomCode }) => { socket.to(roomCode).emit('opponent_left'); socket.leave(roomCode); });
});

// 5. MUTANT MERGE CHESS (ISOLIERTER NAMESPACE)
const mutantIo = io.of('/mutant-chess');
const mutantRooms = new Map();

const PIECE_RANK = { 'p': 1, 'n': 2, 'b': 3, 'r': 4, 'q': 5, 'k': 6 };

function sortCanonically(pieceArr) {
    if (!pieceArr) return pieceArr;
    return pieceArr.slice().sort((a, b) => PIECE_RANK[a.toLowerCase()] - PIECE_RANK[b.toLowerCase()]);
}

function createInitialMutantBoard() {
    return [
        [['r'], ['n'], ['b'], ['q'], ['k'], ['b'], ['n'], ['r']],
        [['p'], ['p'], ['p'], ['p'], ['p'], ['p'], ['p'], ['p']],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [['P'], ['P'], ['P'], ['P'], ['P'], ['P'], ['P'], ['P']],
        [['R'], ['N'], ['B'], ['Q'], ['K'], ['B'], ['N'], ['R']]
    ];
}

function getPieceColor(pieceArr) {
    if (!pieceArr || !pieceArr.length) return null;
    return pieceArr[0] === pieceArr[0].toUpperCase() ? 'w' : 'b';
}

mutantIo.on('connection', (socket) => {
    socket.on('create_mutant_room', ({ playerName, pfp }) => {
        const roomCode = generateRoomCode();
        mutantRooms.set(roomCode, {
            players: {
                w: { id: socket.id, name: playerName, pfp: pfp, ready: false },
                b: null
            },
            board: createInitialMutantBoard(),
            turn: 'w'
        });
        socket.join(roomCode);
        socket.emit('mutant_room_created', { roomCode, playerId: socket.id, color: 'w', playerName, pfp });
    });

    socket.on('join_mutant_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);

        if (!room) return socket.emit('error_msg', 'Raum nicht gefunden!');
        if (room.players.b) return socket.emit('error_msg', 'Raum ist voll!');

        room.players.b = { id: socket.id, name: playerName, pfp: pfp, ready: false };
        socket.join(code);

        socket.emit('mutant_room_joined', {
            roomCode: code,
            playerId: socket.id,
            color: 'b',
            opponentName: room.players.w.name,
            opponentPfp: room.players.w.pfp
        });

        socket.to(code).emit('mutant_opponent_joined', {
            opponentName: playerName,
            opponentPfp: pfp
        });
    });

    socket.on('player_ready', ({ roomCode, playerId }) => {
        const room = mutantRooms.get(roomCode);
        if (!room) return;
        if (room.players.w && room.players.w.id === playerId) room.players.w.ready = true;
        if (room.players.b && room.players.b.id === playerId) room.players.b.ready = true;

        const playersReady = [
            { color: 'w', ready: room.players.w ? room.players.w.ready : false },
            { color: 'b', ready: room.players.b ? room.players.b.ready : false }
        ];
        mutantIo.to(roomCode).emit('ready_update', { playersReady });

        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready) {
            mutantIo.to(roomCode).emit('start_match_countdown');
        }
    });

    socket.on('request_mutant_move', ({ roomCode, playerId, fromR, fromC, toR, toC, moveInfo, duration }) => {
        const room = mutantRooms.get(roomCode);
        if (!room) return;

        const movingPiece = room.board[fromR][fromC];
        if (!movingPiece) return;

        const pieceColor = getPieceColor(movingPiece);
        if (room.turn !== pieceColor) return;

        const targetPiece = room.board[toR][toC];

        // MERGE FUSION LOGIK WITH CANONICAL SORTING
        if (targetPiece && getPieceColor(targetPiece) === pieceColor) {
            if (movingPiece.length + targetPiece.length <= 2) {
                room.board[toR][toC] = sortCanonically([...targetPiece, ...movingPiece]);
                room.board[fromR][fromC] = null;
            } else {
                return socket.emit('error_msg', 'Maximal 2 Figuren pro Feld!');
            }
        } 
        // SCHLAGEN ODER ZIEHEN
        else {
            let isKingCaptured = false;
            if (targetPiece && targetPiece.some(t => t.toLowerCase() === 'k')) {
                isKingCaptured = true;
            }
            room.board[toR][toC] = sortCanonically(movingPiece);
            room.board[fromR][fromC] = null;

            if (isKingCaptured) {
                mutantIo.to(roomCode).emit('game_over', { winnerColor: pieceColor });
            }
        }

        room.turn = room.turn === 'w' ? 'b' : 'w';

        mutantIo.to(roomCode).emit('apply_mutant_move', {
            playerId, fromR, fromC, toR, toC, moveInfo, duration, board: room.board, nextTurn: room.turn
        });
    });

    socket.on('leave_room', ({ roomCode }) => {
        socket.to(roomCode).emit('opponent_left');
        socket.leave(roomCode);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
