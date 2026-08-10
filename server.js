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

app.use(express.json());

// =========================================================
// 1. MONGODB
// =========================================================
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('  MongoDB connected!'))
        .catch(err => console.log('  MongoDB Error:', err));
}

// =========================================================
// 2. SESSION & TWITCH LOGIN
// =========================================================
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
                user.displayName = profile.display_name; 
                user.profileImageUrl = profile.profile_image_url; 
                await user.save();
            }
            return done(null, user);
        } catch (err) { return done(err); }
    }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try { const user = await User.findById(id); done(null, user); } catch (err) { done(err); }
});

// =========================================================
// 3. ROUTES & APIS
// =========================================================
app.get('/auth/twitch', passport.authenticate('twitch'));
app.get('/auth/twitch/callback', passport.authenticate('twitch', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });
app.get('/api/user', (req, res) => res.json(req.user || null));

app.get('/api/users/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.json([]);
        const users = await User.find({ displayName: new RegExp(query, 'i') }).limit(5);
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

app.post('/api/stats/update', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    
    const { mode, result } = req.body;
    if (!mode || !result) return res.status(400).json({ error: 'Missing data' });

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.stats) user.stats = {};
        if (!user.stats[mode]) user.stats[mode] = { wins: 0, losses: 0, draws: 0 };
        
        if (result === 'win') user.stats[mode].wins += 1;
        else if (result === 'loss') user.stats[mode].losses += 1;
        else if (result === 'draw') user.stats[mode].draws += 1;

        await user.save();
        res.json({ success: true, stats: user.stats });
    } catch (err) {
        console.error("Stats update error:", err);
        res.status(500).json({ error: 'Could not update stats' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const users = await User.find({});
        const rankedUsers = users.map(u => {
            const stats = u.stats || {};
            const totalWins = (stats.chess?.wins || 0) + (stats.mutant?.wins || 0) + (stats.bot?.wins || 0);
            return {
                displayName: u.displayName,
                profileImageUrl: u.profileImageUrl,
                totalWins: totalWins,
                stats: stats
            };
        });

        rankedUsers.sort((a, b) => b.totalWins - a.totalWins);
        res.json(rankedUsers.slice(0, 3));
    } catch (err) {
        res.status(500).json({ error: 'Leaderboard failed' });
    }
});

// =========================================================
// 4. STATISCHE ORDNER FÜR DIE GAMES
// =========================================================
app.use(express.static(path.join(__dirname, 'public/hub')));
app.use('/chess', express.static(path.join(__dirname, 'public/chess')));
app.use('/mutant-chess', express.static(path.join(__dirname, 'public/mutant-chess')));
app.use('/play-cager', express.static(path.join(__dirname, 'public/play-cager')));
// app.use('/chaos-chess', express.static(path.join(__dirname, 'public/chaos-chess'))); // DEAKTIVIERT FÜR STREAM TEST

// =========================================================
// 5. CAGERS QUICK CHESS LOGIK
// =========================================================
const rooms = new Map();
function generateRoomCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

const INITIAL_CHESS_BOARD = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
];

function isEnemy(p1, p2) {
    if (!p1 || !p2) return false;
    return (p1 === p1.toUpperCase()) !== (p2 === p2.toUpperCase());
}

function getServerValidMoves(board, r, c, enPassantTarget, hasMoved, activeEffect) {
    let piece = board[r][c];
    if (!piece) return [];
    let moves = [];
    let color = piece === piece.toUpperCase() ? 'w' : 'b';
    let dir = color === 'w' ? -1 : 1;
    let startRow = color === 'w' ? 6 : 1;

    const isIce = activeEffect && activeEffect.id === 'ice';

    const addSliding = (dirs) => {
        for (let [dr, dc] of dirs) {
            let nr = r + dr, nc = c + dc;
            let rayMoves = [];
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                if (!board[nr][nc]) {
                    rayMoves.push({ r: nr, c: nc, type: 'normal' });
                } else {
                    if (isEnemy(piece, board[nr][nc])) {
                        rayMoves.push({ r: nr, c: nc, type: 'capture' });
                    }
                    break;
                }
                nr += dr; nc += dc;
            }
            if (isIce) {
                if (rayMoves.length > 0) moves.push(rayMoves[rayMoves.length - 1]);
            } else {
                moves.push(...rayMoves);
            }
        }
    };

    switch (piece.toLowerCase()) {
        case 'p':
            if (activeEffect && activeEffect.id === 'pawn_jump') {
                for (let [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
                    let nr = r + dr, nc = c + dc;
                    if (nr>=0 && nr<8 && nc>=0 && nc<8) {
                        if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                        else if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' });
                    }
                }
            } else {
                const canSprint = activeEffect && activeEffect.id === 'pawn_sprint';
                if (r + dir >= 0 && r + dir < 8 && !board[r + dir][c]) {
                    moves.push({ r: r + dir, c, type: 'normal' });
                    if ((r === startRow || canSprint) && r + dir * 2 >= 0 && r + dir * 2 < 8 && !board[r + dir * 2][c]) {
                        moves.push({ r: r + dir * 2, c, type: 'normal' });
                    }
                }
                for (let dc of [-1, 1]) {
                    let targetR = r + dir, targetC = c + dc;
                    if (targetR >= 0 && targetR < 8 && targetC >= 0 && targetC < 8) {
                        if (board[targetR][targetC] && isEnemy(piece, board[targetR][targetC])) moves.push({ r: targetR, c: targetC, type: 'capture' });
                        else if (enPassantTarget && enPassantTarget.color !== color && enPassantTarget.r === targetR && enPassantTarget.c === targetC) moves.push({ r: targetR, c: targetC, type: 'en_passant' });
                    }
                }
            }
            break;
        case 'r': addSliding([[-1,0],[1,0],[0,-1],[0,1]]); break;
        case 'b': addSliding([[-1,-1],[-1,1],[1,-1],[1,1]]); break;
        case 'q': addSliding([[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]); break;
        case 'n':
            for (let [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
                let nr = r + dr, nc = c + dc;
                if (nr>=0 && nr<8 && nc>=0 && nc<8) {
                    if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                    else if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' });
                }
            }
            break;
        case 'k':
            const maxDist = (activeEffect && activeEffect.id === 'royal_guard') ? 2 : 1;
            for (let dr = -maxDist; dr <= maxDist; dr++) {
                for (let dc = -maxDist; dc <= maxDist; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    let nr = r + dr, nc = c + dc;
                    if (nr>=0 && nr<8 && nc>=0 && nc<8) {
                        if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                        else if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' });
                    }
                }
            }
            let kRow = color === 'w' ? 7 : 0, kKey = color === 'w' ? 'wK' : 'bK', rookChar = color === 'w' ? 'R' : 'r';
            if (r === kRow && c === 4 && hasMoved && !hasMoved[kKey]) {
                let rRight = color === 'w' ? 'wR_right' : 'bR_right';
                if (!hasMoved[rRight] && board[kRow][7] === rookChar && !board[kRow][5] && !board[kRow][6]) moves.push({ r: kRow, c: 6, type: 'castle' });
                let rLeft = color === 'w' ? 'wR_left' : 'bR_left';
                if (!hasMoved[rLeft] && board[kRow][0] === rookChar && !board[kRow][3] && !board[kRow][2] && !board[kRow][1]) moves.push({ r: kRow, c: 2, type: 'castle' });
            }
            break;
    }
    return moves;
}

io.on('connection', (socket) => {
    socket.on('create_room', ({ playerName, mode, pfp }) => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            mode: mode || 'class',
            players: { w: { id: socket.id, name: playerName, pfp: pfp || '', ready: false }, b: null },
            board: JSON.parse(JSON.stringify(INITIAL_CHESS_BOARD)),
            typeCooldowns: null, 
            singleCooldowns: null,
            hasMoved: { 'wK': false, 'wR_left': false, 'wR_right': false, 'bK': false, 'bR_left': false, 'bR_right': false },
            enPassantTarget: null
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
    
    socket.on('request_move', (moveData) => {
        const room = rooms.get(moveData.roomCode);
        if (!room || !room.board) return;

        const color = (room.players.w && room.players.w.id === socket.id) ? 'w' : ((room.players.b && room.players.b.id === socket.id) ? 'b' : null);
        if (!color) return;

        const { fromR, fromC, toR, toC, promotedTo } = moveData;
        const piece = room.board[fromR][fromC];

        if (!piece) return socket.emit('error_msg', 'Cheat detected: No piece at source');
        if ((piece === piece.toUpperCase() ? 'w' : 'b') !== color) return socket.emit('error_msg', 'Cheat detected: Not your piece');

        const now = Date.now();
        const pieceKey = piece.toLowerCase();

        if (room.mode === 'class') {
            if (room.typeCooldowns[color][pieceKey] > now) return socket.emit('error_msg', 'Piece is on cooldown!');
        } else {
            if (room.singleCooldowns[fromR][fromC] > now) return socket.emit('error_msg', 'Square is on cooldown!');
        }

        const validMoves = getServerValidMoves(room.board, fromR, fromC, room.enPassantTarget, room.hasMoved);
        const validMove = validMoves.find(m => m.r === toR && m.c === toC);
        
        if (!validMove) return socket.emit('error_msg', 'Cheat detected: Illegal move logic!');

        if (piece === 'K') room.hasMoved['wK'] = true;
        if (piece === 'k') room.hasMoved['bK'] = true;

        if (pieceKey === 'p' && Math.abs(toR - fromR) === 2) {
            room.enPassantTarget = { r: (fromR + toR) / 2, c: fromC, color };
        } else {
            room.enPassantTarget = null;
        }

        room.board[fromR][fromC] = null;
        let finalPiece = piece;
        
        if (promotedTo && pieceKey === 'p' && (toR === 0 || toR === 7)) {
            const validPromotions = color === 'w' ? ['Q','R','N','B'] : ['q','r','n','b'];
            if (validPromotions.includes(promotedTo)) finalPiece = promotedTo;
        }

        if (validMove.type === 'castle') {
            const rFromC = toC === 6 ? 7 : 0;
            const rToC = toC === 6 ? 5 : 3;
            room.board[fromR][rToC] = room.board[fromR][rFromC];
            room.board[fromR][rFromC] = null;
        } else if (validMove.type === 'en_passant') {
            const captureRow = color === 'w' ? toR + 1 : toR - 1;
            room.board[captureRow][toC] = null;
        }

        room.board[toR][toC] = finalPiece;

        let cdDuration = 0;
        if (room.mode === 'fast_single') cdDuration = 2000;
        else if (pieceKey === 'p') cdDuration = 3500;
        else if (pieceKey === 'n' || pieceKey === 'b') cdDuration = 6500;
        else if (pieceKey === 'r') cdDuration = 10000;
        else if (pieceKey === 'q') cdDuration = 14000;
        else if (pieceKey === 'k') cdDuration = 1000;

        const cdEndTime = now + cdDuration;
        if (room.mode === 'class') {
            room.typeCooldowns[color][finalPiece.toLowerCase()] = cdEndTime;
        } else {
            room.singleCooldowns[toR][toC] = cdEndTime;
            room.singleCooldowns[fromR][fromC] = 0;
        }

        moveData.moveInfo = validMove;
        io.to(moveData.roomCode).emit('apply_move', moveData);
    });

    socket.on('disconnecting', () => {
        socket.rooms.forEach(code => { socket.to(code).emit('opponent_left'); });
    });
});

// =========================================================
// 6. MUTANT MERGE CHESS
// =========================================================
const mutantIo = io.of('/mutant-chess');
const mutantRooms = new Map();

const PIECE_RANK = { 'p': 1, 'n': 2, 'b': 3, 'r': 4, 'q': 5, 'k': 6 };
function sortCanonically(pieceArr) {
    if (!pieceArr) return pieceArr;
    return pieceArr.slice().sort((a, b) => {
        const charA = a.toLowerCase().replace('_fused', '');
        const charB = b.toLowerCase().replace('_fused', '');
        return (PIECE_RANK[charA] || 5) - (PIECE_RANK[charB] || 5);
    });
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
    return pieceArr[0][0] === pieceArr[0][0].toUpperCase() ? 'w' : 'b';
}

mutantIo.on('connection', (socket) => {
    socket.on('create_mutant_room', ({ playerName, pfp, colorChoice, totalTime, increment, maxFusions }) => {
        const roomCode = generateRoomCode();
        let hostColor = colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice;
        const limitFusions = maxFusions || 3;
        const roomData = {
            players: {
                w: hostColor === 'w' ? { id: socket.id, name: playerName, pfp, ready: false } : null,
                b: hostColor === 'b' ? { id: socket.id, name: playerName, pfp, ready: false } : null
            },
            board: createInitialMutantBoard(),
            turn: 'w',
            timeControl: { minutes: totalTime || 3, increment: increment || 2 },
            clocks: { w: (totalTime || 3) * 60, b: (totalTime || 3) * 60 },
            maxFusions: limitFusions,
            fusionsLeft: { w: limitFusions, b: limitFusions },
            lastTurnTimestamp: null,
            hostColor
        };
        mutantRooms.set(roomCode, roomData);
        socket.join(roomCode);
        socket.emit('mutant_room_created', { 
            roomCode, playerId: socket.id, color: hostColor, playerName, pfp,
            timeControl: roomData.timeControl, clocks: roomData.clocks,
            maxFusions: roomData.maxFusions, fusionsLeft: roomData.fusionsLeft
        });
    });

    socket.on('join_mutant_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        
        let joinerColor = room.players.w ? 'b' : 'w';
        if (room.players[joinerColor]) return socket.emit('error_msg', 'Room is full!');
        
        room.players[joinerColor] = { id: socket.id, name: playerName, pfp, ready: false };
        socket.join(code);
        const oppColor = joinerColor === 'w' ? 'b' : 'w';
        const opponent = room.players[oppColor];
        
        socket.emit('mutant_room_joined', {
            roomCode: code, playerId: socket.id, color: joinerColor,
            opponentName: opponent.name, opponentPfp: opponent.pfp,
            timeControl: room.timeControl, clocks: room.clocks,
            maxFusions: room.maxFusions, fusionsLeft: room.fusionsLeft
        });
        socket.to(code).emit('mutant_opponent_joined', { opponentName: playerName, opponentPfp: pfp });
    });

    socket.on('player_ready', ({ roomCode }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return;
        
        if (room.players.w && room.players.w.id === socket.id) room.players.w.ready = true;
        if (room.players.b && room.players.b.id === socket.id) room.players.b.ready = true;
        
        const playersReady = [
            { color: 'w', ready: room.players.w ? room.players.w.ready : false, name: room.players.w ? room.players.w.name : '' },
            { color: 'b', ready: room.players.b ? room.players.b.ready : false, name: room.players.b ? room.players.b.name : '' }
        ];
        mutantIo.to(code).emit('ready_update', { playersReady });
        
        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready) {
            room.lastTurnTimestamp = Date.now();
            mutantIo.to(code).emit('start_match_countdown', { clocks: room.clocks, maxFusions: room.maxFusions, fusionsLeft: room.fusionsLeft });
        }
    });

    socket.on('request_mutant_move', ({ roomCode, fromR, fromC, toR, toC, moveInfo, promotedTo }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return;
        const movingPiece = room.board[fromR][fromC];
        if (!movingPiece) return;
        
        const pieceColor = getPieceColor(movingPiece);
        if (room.turn !== pieceColor) return;
        
        const now = Date.now();
        if (room.lastTurnTimestamp) {
            const elapsedSeconds = (now - room.lastTurnTimestamp) / 1000;
            room.clocks[pieceColor] = Math.max(0, room.clocks[pieceColor] - elapsedSeconds + room.timeControl.increment);
        }
        room.lastTurnTimestamp = now;

        if (room.clocks[pieceColor] <= 0) {
            mutantIo.to(code).emit('game_over', { winnerColor: pieceColor === 'w' ? 'b' : 'w', reason: 'time' });
            return;
        }

        const targetPiece = room.board[toR][toC];
        
        if (moveInfo && moveInfo.type === 'castle') {
            room.board[toR][toC] = sortCanonically(movingPiece);
            room.board[fromR][fromC] = null;
            const rookFromC = toC === 6 ? 7 : 0;
            const rookToC = toC === 6 ? 5 : 3;
            const rookPiece = room.board[fromR][rookFromC];
            room.board[fromR][rookToC] = rookPiece;
            room.board[fromR][rookFromC] = null;
        } else if (moveInfo && moveInfo.type === 'en_passant') {
            const capturedPawnRow = pieceColor === 'w' ? toR + 1 : toR - 1;
            room.board[capturedPawnRow][toC] = null;
            room.board[toR][toC] = sortCanonically(movingPiece);
            room.board[fromR][fromC] = null;
        } else if (promotedTo && movingPiece.length === 1 && movingPiece[0].toLowerCase() === 'p') {
            room.board[toR][toC] = [promotedTo];
            room.board[fromR][fromC] = null;
        } else if (targetPiece && getPieceColor(targetPiece) === pieceColor) {
            const combined = [...movingPiece, ...targetPiece].map(p => p.toLowerCase().replace('_fused', ''));
            if (movingPiece.some(p => p.includes('_fused')) || targetPiece.some(p => p.includes('_fused'))) return socket.emit('error_msg', 'Fused piece cannot be fused again!');
            if (new Set(combined).size !== combined.length) return socket.emit('error_msg', 'Cannot merge identical pieces!');
            if (combined.includes('q') && (combined.includes('b') || combined.includes('r'))) return socket.emit('error_msg', 'Queen already moves like Bishop and Rook!');
            if (combined.includes('q') && combined.includes('p')) return socket.emit('error_msg', 'Queen cannot merge with Pawn!');
            if (combined.includes('k') && combined.includes('p')) return socket.emit('error_msg', 'King cannot merge with Pawn!');
            if (room.fusionsLeft[pieceColor] <= 0) return socket.emit('error_msg', 'No fusions remaining!');
            
            if (movingPiece.length + targetPiece.length <= 2) {
                if (combined.includes('r') && combined.includes('b')) {
                    room.board[toR][toC] = [pieceColor === 'w' ? 'Q_fused' : 'q_fused'];
                } else {
                    room.board[toR][toC] = sortCanonically([...targetPiece, ...movingPiece]);
                }
                room.board[fromR][fromC] = null;
                room.fusionsLeft[pieceColor]--;
            } else {
                return socket.emit('error_msg', 'Max 2 pieces per square!');
            }
        } else {
            let isKingCaptured = false;
            if (targetPiece && targetPiece.some(t => t.toLowerCase() === 'k')) isKingCaptured = true;
            
            room.board[toR][toC] = sortCanonically(movingPiece);
            room.board[fromR][fromC] = null;
            if (isKingCaptured) {
                mutantIo.to(code).emit('game_over', { winnerColor: pieceColor, reason: 'king' });
            }
        }
        room.turn = room.turn === 'w' ? 'b' : 'w';
        mutantIo.to(code).emit('apply_mutant_move', {
            fromR, fromC, toR, toC, moveInfo, board: room.board, nextTurn: room.turn,
            clocks: room.clocks, fusionsLeft: room.fusionsLeft
        });
    });

    socket.on('time_out', ({ roomCode, loserColor }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return;
        const winnerColor = loserColor === 'w' ? 'b' : 'w';
        mutantIo.to(code).emit('game_over', { winnerColor, reason: 'time' });
    });

    socket.on('resign_game', ({ roomCode }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return;
        const resigningColor = (room.players.w && room.players.w.id === socket.id) ? 'w' : ((room.players.b && room.players.b.id === socket.id) ? 'b' : null);
        if (!resigningColor) return;
        const winnerColor = resigningColor === 'w' ? 'b' : 'w';
        mutantIo.to(code).emit('game_over', { winnerColor, reason: 'resign' });
    });

    socket.on('offer_draw', ({ roomCode }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        socket.to(code).emit('draw_offered');
    });

    socket.on('respond_draw', ({ roomCode, accepted }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        if (accepted) {
            mutantIo.to(code).emit('game_over', { winnerColor: null, reason: 'draw' });
        } else {
            socket.to(code).emit('draw_declined');
        }
    });

    socket.on('disconnecting', () => {
        socket.rooms.forEach(code => { socket.to(code).emit('mutant_opponent_left'); });
    });
});

// =========================================================
// 7. CHAOS CHESS (REPARIERTES VOTING + GEBALANCTE KARTEN) - CURRENTLY DISABLED
// =========================================================
/*
const chaosIo = io.of('/chaos-chess');
const chaosRooms = new Map();

const CHAOS_CARDS_POOL = [
    { id: 'bloodthirst', name: 'Blutdurst', icon: '🩸', description: 'Für 2 Züge MUSS geschlagen werden, wenn ein Schlagzug möglich ist!', turnsDuration: 2 },
    { id: 'peace', name: 'Friedensvertrag', icon: '🕊️', description: 'Für 2 Züge kann KEINE Figur geschlagen werden!', turnsDuration: 2 },
    { id: 'pawn_jump', name: 'Pferdeflüsterer', icon: '🐎', description: 'Für 2 Züge springen alle Bauern wie Springer!', turnsDuration: 2 },
    { id: 'ice', name: 'Eisglätte', icon: '🧊', description: 'Damen, Türme & Läufer rutschen für 2 Züge durch bis zum Hindernis!', turnsDuration: 2 },
    { id: 'pawn_sprint', name: 'Bauern-Sprint', icon: '🏃', description: 'Bauern dürfen für 2 Züge von überall 2 Felder vorgehen!', turnsDuration: 2 },
    { id: 'royal_guard', name: 'Königsschutz', icon: '🛡️', description: 'Könige dürfen 2 Züge lang 2 Felder weit ziehen!', turnsDuration: 2 },
    { id: 'fog', name: 'Nebelschleier', icon: '🌫️', description: 'Gegnerische Figuren sind für 2 Züge in Nebel gehüllt!', turnsDuration: 2 }
];

chaosIo.on('connection', (socket) => {
    socket.on('create_chaos_room', ({ playerName, pfp, cardInterval }) => {
        const roomCode = generateRoomCode();
        const interval = parseInt(cardInterval) || 6;
        const roomData = {
            players: {
                w: { id: socket.id, name: playerName, pfp, ready: false },
                b: null
            },
            board: JSON.parse(JSON.stringify(INITIAL_CHESS_BOARD)),
            turn: 'w',
            moveCount: 0,
            cardInterval: interval,
            activeEffect: null,
            hasMoved: { 'wK': false, 'wR_left': false, 'wR_right': false, 'bK': false, 'bR_left': false, 'bR_right': false },
            enPassantTarget: null,
            isVoting: false,
            currentCards: [],
            votes: [0, 0, 0],
            votedSockets: new Set()
        };
        chaosRooms.set(roomCode, roomData);
        socket.roomCode = roomCode; // FIX: Fest auf Socket speichern!
        socket.join(roomCode);
        socket.emit('chaos_room_created', { roomCode, playerId: socket.id, color: 'w', playerName, pfp, cardInterval: interval });
    });

    socket.on('join_chaos_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = chaosRooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        if (room.players.b) return socket.emit('error_msg', 'Room is full!');
        
        room.players.b = { id: socket.id, name: playerName, pfp, ready: false };
        socket.roomCode = code; // FIX: Fest auf Socket speichern!
        socket.join(code);
        
        socket.emit('chaos_room_joined', {
            roomCode: code, playerId: socket.id, color: 'b',
            opponentName: room.players.w.name, opponentPfp: room.players.w.pfp,
            cardInterval: room.cardInterval
        });
        socket.to(code).emit('chaos_opponent_joined', { opponentName: playerName, opponentPfp: pfp });
    });

    socket.on('player_ready', ({ roomCode }) => {
        const code = socket.roomCode || (roomCode ? roomCode.toUpperCase() : '');
        const room = chaosRooms.get(code);
        if (!room) return;
        
        if (room.players.w && room.players.w.id === socket.id) room.players.w.ready = true;
        if (room.players.b && room.players.b.id === socket.id) room.players.b.ready = true;
        
        const playersReady = [
            { color: 'w', ready: room.players.w ? room.players.w.ready : false, name: room.players.w ? room.players.w.name : '' },
            { color: 'b', ready: room.players.b ? room.players.b.ready : false, name: room.players.b ? room.players.b.name : '' }
        ];
        chaosIo.to(code).emit('ready_update', { playersReady });
        
        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready) {
            chaosIo.to(code).emit('start_match', { board: room.board });
        }
    });

    socket.on('request_chaos_move', ({ fromR, fromC, toR, toC, moveInfo, promotedTo }) => {
        const code = socket.roomCode;
        const room = chaosRooms.get(code);
        if (!room || room.isVoting) return;

        const movingPiece = room.board[fromR][fromC];
        if (!movingPiece) return;
        
        const pieceColor = movingPiece === movingPiece.toUpperCase() ? 'w' : 'b';
        if (room.turn !== pieceColor) return socket.emit('error_msg', 'Not your turn!');

        const validMoves = getServerValidMoves(room.board, fromR, fromC, room.enPassantTarget, room.hasMoved, room.activeEffect);
        const validMove = validMoves.find(m => m.r === toR && m.c === toC);
        if (!validMove) return socket.emit('error_msg', 'Illegal move!');

        // --- KARTEN-LOGIK BEIM ZUG ---
        if (room.activeEffect && room.activeEffect.id === 'peace' && (validMove.type === 'capture' || validMove.type === 'en_passant')) {
            return socket.emit('error_msg', '🕊️ Friedensvertrag aktiv! Schlagen verboten!');
        }

        if (room.activeEffect && room.activeEffect.id === 'bloodthirst') {
            let hasAnyCapture = false;
            for (let r = 0; r < 8; r++) {
                for (let c = 0; c < 8; c++) {
                    const p = room.board[r][c];
                    if (p && (p === p.toUpperCase() ? 'w' : 'b') === pieceColor) {
                        const pMoves = getServerValidMoves(room.board, r, c, room.enPassantTarget, room.hasMoved, room.activeEffect);
                        if (pMoves.some(m => m.type === 'capture' || m.type === 'en_passant')) {
                            hasAnyCapture = true;
                            break;
                        }
                    }
                }
                if (hasAnyCapture) break;
            }
            if (hasAnyCapture && validMove.type !== 'capture' && validMove.type !== 'en_passant') {
                return socket.emit('error_msg', '🩸 Blutdurst aktiv! Du MUSST schlagen!');
            }
        }

        if (movingPiece === 'K') room.hasMoved['wK'] = true;
        if (movingPiece === 'k') room.hasMoved['bK'] = true;

        room.board[fromR][fromC] = null;
        let finalPiece = promotedTo || movingPiece;

        if (validMove.type === 'castle') {
            const rFromC = toC === 6 ? 7 : 0;
            const rToC = toC === 6 ? 5 : 3;
            room.board[fromR][rToC] = room.board[fromR][rFromC];
            room.board[fromR][rFromC] = null;
        } else if (validMove.type === 'en_passant') {
            const captureRow = pieceColor === 'w' ? toR + 1 : toR - 1;
            room.board[captureRow][toC] = null;
        }

        const targetPiece = room.board[toR][toC];
        let isGameOver = targetPiece && targetPiece.toLowerCase() === 'k';

        room.board[toR][toC] = finalPiece;
        
        room.moveCount++;
        room.turn = room.turn === 'w' ? 'b' : 'w';

        if (room.activeEffect) {
            room.activeEffect.turnsLeft--;
            if (room.activeEffect.turnsLeft <= 0) {
                room.activeEffect = null;
            }
        }

        const triggerVoting = (room.moveCount > 0 && room.moveCount % room.cardInterval === 0 && !isGameOver);

        chaosIo.to(code).emit('apply_chaos_move', {
            board: room.board,
            nextTurn: room.turn,
            moveCount: room.moveCount,
            cardInterval: room.cardInterval,
            activeEffect: room.activeEffect,
            isGameOver
        });

        // START VOTING
        if (triggerVoting) {
            room.isVoting = true;
            room.votes = [0, 0, 0];
            room.votedSockets.clear();

            const shuffled = [...CHAOS_CARDS_POOL].sort(() => 0.5 - Math.random());
            room.currentCards = shuffled.slice(0, 3);

            chaosIo.to(code).emit('start_card_selection', {
                cards: room.currentCards,
                duration: 30
            });

            setTimeout(() => {
                const activeRoom = chaosRooms.get(code);
                if (!activeRoom || !activeRoom.isVoting) return;

                let maxVotes = -1;
                let winningIndex = 0;
                activeRoom.votes.forEach((v, idx) => {
                    if (v > maxVotes) {
                        maxVotes = v;
                        winningIndex = idx;
                    }
                });

                const selectedCard = activeRoom.currentCards[winningIndex];
                activeRoom.activeEffect = {
                    id: selectedCard.id,
                    name: selectedCard.name,
                    description: selectedCard.description,
                    turnsLeft: selectedCard.turnsDuration
                };
                activeRoom.isVoting = false;

                chaosIo.to(code).emit('card_applied', {
                    activeEffect: activeRoom.activeEffect
                });
            }, 30000);
        }
    });

    // VOTING HANDLER (JETZT FÜR ALLE SPIELER PERFEKT RELIABLE)
    socket.on('cast_vote', ({ cardIndex }) => {
        const code = socket.roomCode;
        if (!code) return;
        const room = chaosRooms.get(code);
        if (!room || !room.isVoting) return;
        if (room.votedSockets.has(socket.id)) return;

        room.votedSockets.add(socket.id);
        room.votes[cardIndex] = (room.votes[cardIndex] || 0) + 1;

        const totalVotes = room.votedSockets.size || 1;
        const votesPct = room.votes.map(v => Math.round((v / totalVotes) * 100));

        chaosIo.to(code).emit('update_votes', { votesPct });
    });

    socket.on('disconnecting', () => {
        if (socket.roomCode) {
            chaosIo.to(socket.roomCode).emit('chaos_opponent_left');
        }
    });
});
*/

// =========================================================
// 8. SERVER BINDING
// =========================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
