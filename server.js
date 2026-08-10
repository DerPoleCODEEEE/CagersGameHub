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
// 5. CAGERS QUICK CHESS LOGIK & GLOBAL CHAT
// =========================================================
const rooms = new Map();
const hubChatHistory = [];

function generateRoomCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function generatePlayerId() { return Math.random().toString(36).substring(2, 12); }

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
    // --- GLOBAL HUB CHAT EVENTS ---
    socket.emit('hub_chat_history', hubChatHistory);

    socket.on('send_hub_chat', ({ text, user }) => {
        if (!text || !user || !user.name) return;
        const cleanText = text.trim().substring(0, 150);
        if (!cleanText) return;

        const newMsg = {
            name: user.name,
            pfp: user.pfp || '',
            text: cleanText,
            timestamp: Date.now()
        };

        hubChatHistory.push(newMsg);
        if (hubChatHistory.length > 50) hubChatHistory.shift();

        io.emit('receive_hub_chat', newMsg);
    });

    // --- QUICK CHESS ROOM EVENTS ---
    socket.on('create_room', ({ playerName, mode, pfp }) => {
        const roomCode = generateRoomCode();
        const playerId = generatePlayerId();
        rooms.set(roomCode, {
            mode: mode || 'class',
            players: { w: { socketId: socket.id, playerId, name: playerName, pfp: pfp || '', ready: false, connected: true }, b: null },
            board: JSON.parse(JSON.stringify(INITIAL_CHESS_BOARD)),
            typeCooldowns: null, 
            singleCooldowns: null,
            hasMoved: { 'wK': false, 'wR_left': false, 'wR_right': false, 'bK': false, 'bR_left': false, 'bR_right': false },
            enPassantTarget: null,
            isGameStarted: false,
            isGameOver: false,
            disconnectTimers: { w: null, b: null }
        });
        socket.join(roomCode);
        socket.emit('room_created', { roomCode, playerId, color: 'w', mode });
    });

    socket.on('join_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = rooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        if (room.players.b && room.players.b.connected) return socket.emit('error_msg', 'Room is full!');
        
        const playerId = generatePlayerId();
        room.players.b = { socketId: socket.id, playerId, name: playerName, pfp: pfp || '', ready: false, connected: true };
        socket.join(code);
        
        socket.emit('room_joined', { 
            roomCode: code, playerId, color: 'b', mode: room.mode, 
            opponentName: room.players.w.name, opponentPfp: room.players.w.pfp 
        });
        socket.to(code).emit('opponent_joined', { opponentName: playerName, opponentPfp: pfp });
    });

    socket.on('reconnect_room', ({ roomCode, playerId, playerColor }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = rooms.get(code);
        if (!room || !room.players[playerColor]) return socket.emit('error_msg', 'Room or session expired!');
        
        const player = room.players[playerColor];
        if (player.playerId !== playerId) return socket.emit('error_msg', 'Invalid session credentials!');

        player.socketId = socket.id;
        player.connected = true;

        if (room.disconnectTimers[playerColor]) {
            clearTimeout(room.disconnectTimers[playerColor]);
            room.disconnectTimers[playerColor] = null;
        }

        socket.join(code);
        const oppColor = playerColor === 'w' ? 'b' : 'w';
        const opponent = room.players[oppColor];

        socket.emit('room_reconnected', {
            roomCode: code,
            playerId,
            color: playerColor,
            mode: room.mode,
            board: room.board,
            typeCooldowns: room.typeCooldowns,
            singleCooldowns: room.singleCooldowns,
            isGameStarted: room.isGameStarted,
            isGameOver: room.isGameOver,
            opponentName: opponent ? opponent.name : '',
            opponentPfp: opponent ? opponent.pfp : '',
            playersReady: [
                { color: 'w', ready: room.players.w ? room.players.w.ready : false },
                { color: 'b', ready: room.players.b ? room.players.b.ready : false }
            ]
        });

        socket.to(code).emit('opponent_reconnected', { color: playerColor });
    });

    socket.on('player_ready', ({ roomCode, playerId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        if (room.players.w && room.players.w.playerId === playerId) room.players.w.ready = true;
        if (room.players.b && room.players.b.playerId === playerId) room.players.b.ready = true;
        
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
            room.isGameStarted = true;
            io.to(roomCode).emit('start_match_countdown', { typeCooldowns: room.typeCooldowns, singleCooldowns: room.singleCooldowns });
        }
    });

    socket.on('select_square', ({ roomCode, r, c }) => socket.to(roomCode).emit('opponent_select_square', { r, c }));
    
    socket.on('request_move', (moveData) => {
        const room = rooms.get(moveData.roomCode);
        if (!room || !room.board || room.isGameOver) return;

        const color = (room.players.w && room.players.w.socketId === socket.id) ? 'w' : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
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

        if (room.board[toR][toC] && room.board[toR][toC].toLowerCase() === 'k') {
            room.isGameOver = true;
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
        socket.rooms.forEach(code => {
            const room = rooms.get(code);
            if (!room) return;

            let discColor = null;
            if (room.players.w && room.players.w.socketId === socket.id) discColor = 'w';
            if (room.players.b && room.players.b.socketId === socket.id) discColor = 'b';

            if (discColor && !room.isGameOver) {
                room.players[discColor].connected = false;
                socket.to(code).emit('opponent_disconnected', { color: discColor, countdownSeconds: 30 });

                room.disconnectTimers[discColor] = setTimeout(() => {
                    if (room && !room.players[discColor].connected && !room.isGameOver) {
                        room.isGameOver = true;
                        const winnerColor = discColor === 'w' ? 'b' : 'w';
                        io.to(code).emit('game_over', { winnerColor, reason: 'disconnect' });
                    }
                }, 30000);
            }
        });
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
        const playerId = generatePlayerId();
        let hostColor = colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice;
        const limitFusions = maxFusions || 3;
        const roomData = {
            players: {
                w: hostColor === 'w' ? { socketId: socket.id, playerId, name: playerName, pfp, ready: false, connected: true } : null,
                b: hostColor === 'b' ? { socketId: socket.id, playerId, name: playerName, pfp, ready: false, connected: true } : null
            },
            board: createInitialMutantBoard(),
            turn: 'w',
            timeControl: { minutes: totalTime || 3, increment: increment || 2 },
            clocks: { w: (totalTime || 3) * 60, b: (totalTime || 3) * 60 },
            maxFusions: limitFusions,
            fusionsLeft: { w: limitFusions, b: limitFusions },
            lastTurnTimestamp: null,
            hostColor,
            isGameStarted: false,
            isGameOver: false,
            disconnectTimers: { w: null, b: null }
        };
        mutantRooms.set(roomCode, roomData);
        socket.join(roomCode);
        socket.emit('mutant_room_created', { 
            roomCode, playerId, color: hostColor, playerName, pfp,
            timeControl: roomData.timeControl, clocks: roomData.clocks,
            maxFusions: roomData.maxFusions, fusionsLeft: roomData.fusionsLeft
        });
    });

    socket.on('join_mutant_room', ({ roomCode, playerName, pfp }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return socket.emit('error_msg', 'Room not found!');
        
        let joinerColor = room.players.w ? 'b' : 'w';
        if (room.players[joinerColor] && room.players[joinerColor].connected) return socket.emit('error_msg', 'Room is full!');
        
        const playerId = generatePlayerId();
        room.players[joinerColor] = { socketId: socket.id, playerId, name: playerName, pfp, ready: false, connected: true };
        socket.join(code);
        const oppColor = joinerColor === 'w' ? 'b' : 'w';
        const opponent = room.players[oppColor];
        
        socket.emit('mutant_room_joined', {
            roomCode: code, playerId, color: joinerColor,
            opponentName: opponent ? opponent.name : '', opponentPfp: opponent ? opponent.pfp : '',
            timeControl: room.timeControl, clocks: room.clocks,
            maxFusions: room.maxFusions, fusionsLeft: room.fusionsLeft
        });
        socket.to(code).emit('mutant_opponent_joined', { opponentName: playerName, opponentPfp: pfp });
    });

    socket.on('reconnect_mutant_room', ({ roomCode, playerId, playerColor }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room || !room.players[playerColor]) return socket.emit('error_msg', 'Room or session expired!');

        const player = room.players[playerColor];
        if (player.playerId !== playerId) return socket.emit('error_msg', 'Invalid session credentials!');

        player.socketId = socket.id;
        player.connected = true;

        if (room.disconnectTimers[playerColor]) {
            clearTimeout(room.disconnectTimers[playerColor]);
            room.disconnectTimers[playerColor] = null;
        }

        socket.join(code);
        const oppColor = playerColor === 'w' ? 'b' : 'w';
        const opponent = room.players[oppColor];

        socket.emit('mutant_room_reconnected', {
            roomCode: code,
            playerId,
            color: playerColor,
            board: room.board,
            turn: room.turn,
            clocks: room.clocks,
            fusionsLeft: room.fusionsLeft,
            maxFusions: room.maxFusions,
            isGameStarted: room.isGameStarted,
            isGameOver: room.isGameOver,
            opponentName: opponent ? opponent.name : '',
            opponentPfp: opponent ? opponent.pfp : '',
            playersReady: [
                { color: 'w', ready: room.players.w ? room.players.w.ready : false, name: room.players.w ? room.players.w.name : '' },
                { color: 'b', ready: room.players.b ? room.players.b.ready : false, name: room.players.b ? room.players.b.name : '' }
            ]
        });

        socket.to(code).emit('mutant_opponent_reconnected', { color: playerColor });
    });

    socket.on('player_ready', ({ roomCode }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room) return;
        
        if (room.players.w && room.players.w.socketId === socket.id) room.players.w.ready = true;
        if (room.players.b && room.players.b.socketId === socket.id) room.players.b.ready = true;
        
        const playersReady = [
            { color: 'w', ready: room.players.w ? room.players.w.ready : false, name: room.players.w ? room.players.w.name : '' },
            { color: 'b', ready: room.players.b ? room.players.b.ready : false, name: room.players.b ? room.players.b.name : '' }
        ];
        mutantIo.to(code).emit('ready_update', { playersReady });
        
        if (room.players.w && room.players.b && room.players.w.ready && room.players.b.ready) {
            room.lastTurnTimestamp = Date.now();
            room.isGameStarted = true;
            mutantIo.to(code).emit('start_match_countdown', { clocks: room.clocks, maxFusions: room.maxFusions, fusionsLeft: room.fusionsLeft });
        }
    });

    socket.on('request_mutant_move', ({ roomCode, fromR, fromC, toR, toC, moveInfo, promotedTo }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;
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
            room.isGameOver = true;
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
                room.isGameOver = true;
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
        if (!room || room.isGameOver) return;
        room.isGameOver = true;
        const winnerColor = loserColor === 'w' ? 'b' : 'w';
        mutantIo.to(code).emit('game_over', { winnerColor, reason: 'time' });
    });

    socket.on('resign_game', ({ roomCode }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (!room || room.isGameOver) return;
        const resigningColor = (room.players.w && room.players.w.socketId === socket.id) ? 'w' : ((room.players.b && room.players.b.socketId === socket.id) ? 'b' : null);
        if (!resigningColor) return;
        room.isGameOver = true;
        const winnerColor = resigningColor === 'w' ? 'b' : 'w';
        mutantIo.to(code).emit('game_over', { winnerColor, reason: 'resign' });
    });

    socket.on('offer_draw', ({ roomCode }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        socket.to(code).emit('draw_offered');
    });

    socket.on('respond_draw', ({ roomCode, accepted }) => {
        const code = roomCode ? roomCode.toUpperCase() : '';
        const room = mutantRooms.get(code);
        if (accepted && room) {
            room.isGameOver = true;
            mutantIo.to(code).emit('game_over', { winnerColor: null, reason: 'draw' });
        } else {
            socket.to(code).emit('draw_declined');
        }
    });

    socket.on('disconnecting', () => {
        socket.rooms.forEach(code => {
            const room = mutantRooms.get(code);
            if (!room) return;

            let discColor = null;
            if (room.players.w && room.players.w.socketId === socket.id) discColor = 'w';
            if (room.players.b && room.players.b.socketId === socket.id) discColor = 'b';

            if (discColor && !room.isGameOver) {
                room.players[discColor].connected = false;
                socket.to(code).emit('mutant_opponent_disconnected', { color: discColor, countdownSeconds: 30 });

                room.disconnectTimers[discColor] = setTimeout(() => {
                    if (room && !room.players[discColor].connected && !room.isGameOver) {
                        room.isGameOver = true;
                        const winnerColor = discColor === 'w' ? 'b' : 'w';
                        mutantIo.to(code).emit('game_over', { winnerColor, reason: 'disconnect' });
                    }
                }, 30000);
            }
        });
    });
});

// =========================================================
// 8. SERVER BINDING
// =========================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
