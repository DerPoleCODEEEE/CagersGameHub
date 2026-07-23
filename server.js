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

// Statische Ordner servieren
app.use(express.static(path.join(__dirname, 'public/hub')));
app.use('/chess', express.static(path.join(__dirname, 'public/chess')));
app.use('/mutant-chess', express.static(path.join(__dirname, 'public/mutant-chess')));

// 4. SCHACH MULTIPLAYER (Cagers Quick Chess - Unverändert)
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

// 5. MUTANT MERGE CHESS (Isolierter Namespace)
const mutantIo = io.of('/mutant-chess');
const mutantRooms = new Map();

function createInitialMutantBoard() {
    const board = Array(8).fill(null).map(() => Array(8).fill(null));
    const backRow = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let c = 0; c < 8; c++) {
        board[0][c] = { color: 'b', types: [backRow[c]] };
        board[1][c] = { color: 'b', types: ['p'] };
        board[6][c] = { color: 'w', types: ['p'] };
        board[7][c] = { color: 'w', types: [backRow[c]] };
    }
    return board;
}

function isValidMutantMove(board, startR, startC, targetR, targetC, playerColor) {
    const piece = board[startR][startC];
    const target = board[targetR][targetC];
    
    if (target && target.color === playerColor) {
        if (piece.types.length + target.types.length > 2) return false;
    }

    const dr = targetR - startR;
    const dc = targetC - startC;
    const absDr = Math.abs(dr);
    const absDc = Math.abs(dc);

    for (const type of piece.types) {
        if (type === 'p') {
            const dir = piece.color === 'w' ? -1 : 1;
            const startRow = piece.color === 'w' ? 6 : 1;
            if (dc === 0 && dr === dir && !target) return true;
            if (dc === 0 && startR === startRow && dr === 2 * dir && !target && !board[startR + dir][startC]) return true;
            if (absDc === 1 && dr === dir && target) return true;
        }
        if (type === 'n') {
            if ((absDr === 2 && absDc === 1) || (absDr === 1 && absDc === 2)) return true;
        }
        if (type === 'k') {
            if (absDr <= 1 && absDc <= 1) return true;
        }
        if (type === 'r' || type === 'q') {
            if (dr === 0 || dc === 0) {
                const stepR = dr === 0 ? 0 : (dr > 0 ? 1 : -1);
                const stepC = dc === 0 ? 0 : (dc > 0 ? 1 : -1);
                let checkR = startR + stepR, checkC = startC + stepC;
                let blocked = false;
                while (checkR !== targetR || checkC !== targetC) {
                    if (board[checkR][checkC]) blocked = true;
                    checkR += stepR; checkC += stepC;
                }
                if (!blocked) return true;
            }
        }
        if (type === 'b' || type === 'q') {
            if (absDr === absDc) {
                const stepR = dr > 0 ? 1 : -1;
                const stepC = dc > 0 ? 1 : -1;
                let checkR = startR + stepR, checkC = startC + stepC;
                let blocked = false;
                while (checkR !== targetR || checkC !== targetC) {
                    if (board[checkR][checkC]) blocked = true;
                    checkR += stepR; checkC += stepC;
                }
                if (!blocked) return true;
            }
        }
    }
    return false;
}

mutantIo.on('connection', (socket) => {
    socket.on('join_mutant_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode || 'CHAOS';
        let room = mutantRooms.get(code);
        
        if (!room) {
            room = {
                players: { w: { id: socket.id, name: playerName, pfp: pfp }, b: null },
                board: createInitialMutantBoard(),
                turn: 'w'
            };
            mutantRooms.set(code, room);
            socket.join(code);
            socket.emit('game_started', { color: 'w', board: room.board, turn: room.turn });
        } else if (!room.players.b && room.players.w.id !== socket.id) {
            room.players.b = { id: socket.id, name: playerName, pfp: pfp };
            socket.join(code);
            socket.emit('game_started', { color: 'b', board: room.board, turn: room.turn, opp: room.players.w });
            socket.to(code).emit('opponent_joined', { name: playerName, pfp: pfp });
        } else {
            const isWhite = room.players.w && room.players.w.id === socket.id;
            socket.join(code);
            socket.emit('game_started', { color: isWhite ? 'w' : 'b', board: room.board, turn: room.turn });
        }
    });

    socket.on('make_move', ({ roomCode, start, target }) => {
        const room = mutantRooms.get(roomCode);
        if (!room) return;

        const [sr, sc] = start;
        const [tr, tc] = target;
        const piece = room.board[sr][sc];
        
        const callerColor = room.players.w && room.players.w.id === socket.id ? 'w' : 'b';
        
        if (!piece || piece.color !== callerColor || room.turn !== callerColor) {
            return socket.emit('invalid_move', 'Nicht am Zug oder ungültige Figur!');
        }

        if (isValidMutantMove(room.board, sr, sc, tr, tc, callerColor)) {
            const targetPiece = room.board[tr][tc];
            
            // Fusions-Logik
            if (targetPiece && targetPiece.color === callerColor) {
                targetPiece.types = [...targetPiece.types, ...piece.types];
            } 
            // Normales Schlagen & Ziehen
            else {
                if (targetPiece && targetPiece.types.includes('k')) {
                    mutantIo.to(roomCode).emit('game_over', { winner: callerColor });
                }
                room.board[tr][tc] = piece;
            }
            
            room.board[sr][sc] = null;
            room.turn = room.turn === 'w' ? 'b' : 'w';
            
            mutantIo.to(roomCode).emit('board_update', { board: room.board, turn: room.turn });
        } else {
            socket.emit('invalid_move', 'Ungültiger Zug für diese Mutante!');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
