/**
 * Prediction Chess — Server-Logik.
 *
 * Normales Schach. Wer zieht, sagt gleichzeitig den nächsten Zug des Gegners
 * voraus; ein Treffer bringt Münzen, Münzen kaufen Items, die sofort wirken.
 *
 * Der Server ist die Autorität: Brett, Münzen, Effekte, Sichtfeld und
 * Spielende liegen ausschließlich hier. Der Client rendert nur und schlägt vor.
 *
 * Ausgelagert aus server.js, weil dieser Modus deutlich mehr Zustand hat als
 * die anderen — server.js bleibt so lesbar.
 */
'use strict';

const MoveGen = require('./public/shared/move-gen.js');
const Items = require('./public/shared/items.js');

const MOVE_TIME_MS = parseInt(process.env.PREDICTION_MOVE_MS, 10) || 90_000;

// Nur fuer Tests: Startguthaben, damit Kaeufe geprueft werden koennen, ohne
// erst zwanzig Zuege lang richtig raten zu muessen. In Produktion 0.
const START_COINS = parseInt(process.env.PREDICTION_START_COINS, 10) || 0;

module.exports = function attachPredictionChess(deps) {
    const {
        io, safeHandler, sanitizeName, sanitizePfp, sanitizeRoomCode,
        generateRoomCode, generatePlayerId, socketUser, checkRateLimit,
        recordRoomResult, scheduleRoomCleanup, sweepRooms, touch,
        socketRateLimits, DISCONNECT_FORFEIT_MS, ROOM_SWEEP_MS
    } = deps;

    const nsp = io.of('/prediction-chess');
    const rooms = new Map();

    const other = (c) => (c === 'w' ? 'b' : 'w');

    // =================================================================
    // Zustand
    // =================================================================

    function createRoom(code) {
        return {
            code,
            createdAt: Date.now(),
            lastActivity: Date.now(),

            board: MoveGen.createInitialBoard(),
            turn: 'w',
            hasMoved: MoveGen.createHasMoved(),
            enPassantTarget: null,
            captured: { w: [], b: [] },     // eigene Figuren, die verloren gingen
            history: [],

            players: { w: null, b: null },
            ready: { w: false, b: false },
            isGameStarted: false,
            isGameOver: false,
            statsRecorded: false,

            coins: { w: START_COINS, b: START_COINS },
            streak: { w: 0, b: 0 },
            bestStreak: { w: 0, b: 0 },
            hits: { w: 0, b: 0 },
            guesses: { w: 0, b: 0 },
            pending: { w: null, b: null },  // {arrows:[{fromR,fromC,toR,toC}]}
            lastResult: { w: null, b: null },

            effects: [],
            effectSeq: 1,
            castlingBanned: { w: false, b: false },
            boughtThisTurn: { w: false, b: false },
            pendingDouble: { w: false, b: false },  // gekauft, erster Zug steht aus
            doubleSecond: { w: false, b: false },   // zweiter Zug läuft gerade

            moveDeadline: 0,
            disconnectTimers: { w: null, b: null },
            cleanupTimer: null
        };
    }

    function effectsOf(room, owner) {
        return room.effects.filter(e => e.owner === owner);
    }

    function findEffect(room, owner, id) {
        return room.effects.find(e => e.owner === owner && e.id === id) || null;
    }

    function addEffect(room, owner, id, extra) {
        const item = Items.getItem(id);
        const eff = Object.assign({
            uid: room.effectSeq++,
            id,
            owner,
            hidden: false,
            target: null,
            squares: null,
            pliesLeft: item && item.duration ? item.duration : 0,
            chargesLeft: item && item.charges ? item.charges : 0
        }, extra || {});
        room.effects.push(eff);
        return eff;
    }

    function removeEffect(room, eff) {
        const i = room.effects.indexOf(eff);
        if (i !== -1) room.effects.splice(i, 1);
    }

    /** Verbraucht eine Ladung; entfernt den Effekt, wenn nichts mehr übrig ist. */
    function consumeCharge(room, eff) {
        if (!eff) return;
        eff.chargesLeft -= 1;
        if (eff.chargesLeft <= 0) removeEffect(room, eff);
    }

    // =================================================================
    // Regeln: Item-Effekte in Zuggenerator-Optionen übersetzen
    // =================================================================

    /** Rochaderechte inkl. Castling Ban. */
    function hasMovedFor(room, color) {
        if (!room.castlingBanned[color]) return room.hasMoved;
        const hm = Object.assign({}, room.hasMoved);
        if (color === 'w') { hm.wK = true; hm.wR_left = true; hm.wR_right = true; }
        else { hm.bK = true; hm.bR_left = true; hm.bR_right = true; }
        return hm;
    }

    /**
     * Optionen für die Zuggenerierung einer Farbe.
     * Gegnerische Effekte (Shackle, Minefield) behindern, eigene (Cavalry,
     * Pawn Storm) helfen.
     */
    function movementOpts(room, color, extra) {
        const foe = other(color);
        const frozen = room.effects
            .filter(e => e.id === 'freeze' && e.owner === foe && e.target)
            .map(e => e.target);
        const blocked = room.effects
            .filter(e => e.id === 'minefield' && e.owner === foe && e.squares)
            .reduce((acc, e) => acc.concat(e.squares), []);
        const cav = findEffect(room, color, 'cavalry');
        const storm = findEffect(room, color, 'pawn_storm');

        return Object.assign({
            hasMoved: hasMovedFor(room, color),
            enPassantTarget: room.enPassantTarget,
            frozen: frozen.length ? frozen : null,
            blockedTargets: blocked.length ? blocked : null,
            extraPattern: cav && cav.target ? { r: cav.target.r, c: cav.target.c, type: 'knight' } : null,
            pawnDoubleAnywhere: !!storm
        }, extra || {});
    }

    /** Zählt Effektdauern herunter, nachdem `mover` gezogen hat. */
    function tickEffects(room, mover) {
        for (let i = room.effects.length - 1; i >= 0; i--) {
            const eff = room.effects[i];
            const item = Items.getItem(eff.id);
            if (!item || !item.tick) continue;
            const affects =
                item.tick === 'anyMove' ||
                (item.tick === 'ownMove' && eff.owner === mover) ||
                (item.tick === 'enemyMove' && eff.owner !== mover);
            if (!affects) continue;
            eff.pliesLeft -= 1;
            if (eff.pliesLeft <= 0) room.effects.splice(i, 1);
        }
        // Verwaiste Ziele aufräumen: die gefesselte Figur wurde geschlagen.
        for (let i = room.effects.length - 1; i >= 0; i--) {
            const eff = room.effects[i];
            if (eff.id !== 'freeze' || !eff.target) continue;
            const p = room.board[eff.target.r][eff.target.c];
            if (!p || MoveGen.colorOf(p) === eff.owner) room.effects.splice(i, 1);
        }
    }

    function fogEffect(room) {
        return room.effects.find(e => e.id === 'fog') || null;
    }

    /** Brett aus Sicht einer Farbe — bei Nebel werden fremde Figuren entfernt. */
    function boardFor(room, color) {
        if (!fogEffect(room)) return room.board;
        const vis = MoveGen.visibleSquares(room.board, color, movementOpts(room, color));
        const seen = Object.create(null);
        for (const s of vis) seen[s.r + ',' + s.c] = true;
        return room.board.map((row, r) => row.map((p, c) => {
            if (!p) return null;
            if (MoveGen.colorOf(p) === color) return p;
            return seen[r + ',' + c] ? p : null;
        }));
    }

    function visibleListFor(room, color) {
        if (!fogEffect(room)) return null;
        return MoveGen.visibleSquares(room.board, color, movementOpts(room, color));
    }

    // =================================================================
    // Zustands-Pakete für die Clients
    // =================================================================

    /** Effekte, wie der Empfänger sie sehen darf (Cloak blendet Namen aus). */
    function effectsFor(room, viewer) {
        return room.effects.map(e => {
            const mine = e.owner === viewer;
            const hide = e.hidden && !mine;
            return {
                uid: e.uid,
                id: hide ? null : e.id,
                owner: e.owner,
                hidden: hide,
                target: hide ? null : e.target,
                squares: hide ? null : e.squares,
                pliesLeft: e.pliesLeft,
                chargesLeft: e.chargesLeft
            };
        });
    }

    function stateFor(room, color) {
        const fog = fogEffect(room);
        return {
            board: boardFor(room, color),
            turn: room.turn,
            hasMoved: hasMovedFor(room, room.turn),
            enPassantTarget: room.enPassantTarget,
            captured: room.captured,
            coins: room.coins,
            streak: room.streak,
            effects: effectsFor(room, color),
            castlingBanned: room.castlingBanned,
            boughtThisTurn: room.boughtThisTurn[color],
            doubleSecond: room.doubleSecond[color],
            pendingDouble: room.pendingDouble[color],
            hasPrediction: !!room.pending[color],
            moveDeadline: room.moveDeadline,
            fogPlies: fog ? fog.pliesLeft : 0,
            visible: visibleListFor(room, color),
            inCheck: MoveGen.isInCheck(room.board, room.turn, movementOpts(room, room.turn))
        };
    }

    /** Schickt jedem Spieler sein eigenes (ggf. vernebeltes) Zustandspaket. */
    function pushState(room, event, common) {
        ['w', 'b'].forEach(col => {
            const p = room.players[col];
            if (!p || !p.socketId) return;
            const sock = nsp.sockets.get(p.socketId);
            if (!sock) return;
            sock.emit(event, Object.assign({}, common || {}, stateFor(room, col), { you: col }));
        });
    }

    // =================================================================
    // Uhr (90 Sekunden pro Zug) und Spielende
    // =================================================================

    function armMoveTimer(room) {
        room.moveDeadline = Date.now() + MOVE_TIME_MS;
    }

    function endGame(code, winnerColor, reason) {
        const room = rooms.get(code);
        if (!room || room.isGameOver) return;
        room.isGameOver = true;
        room.moveDeadline = 0;
        ['w', 'b'].forEach(col => {
            if (room.disconnectTimers[col]) {
                clearTimeout(room.disconnectTimers[col]);
                room.disconnectTimers[col] = null;
            }
        });
        recordRoomResult(room, 'prediction', winnerColor);
        nsp.to(code).emit('game_over', {
            winnerColor,
            reason,
            summary: {
                coins: room.coins,
                hits: room.hits,
                guesses: room.guesses,
                bestStreak: room.bestStreak
            }
        });
        scheduleRoomCleanup(rooms, code);
    }

    setInterval(() => {
        const now = Date.now();
        for (const [code, room] of rooms) {
            if (!room.isGameStarted || room.isGameOver || !room.moveDeadline) continue;
            if (now >= room.moveDeadline) endGame(code, other(room.turn), 'timeout');
        }
    }, 500).unref();

    setInterval(() => sweepRooms(rooms), ROOM_SWEEP_MS).unref();

    // =================================================================
    // Predictions
    // =================================================================

    function sameMove(a, b) {
        return !!a && !!b &&
            a.fromR === b.fromR && a.fromC === b.fromC &&
            a.toR === b.toR && a.toC === b.toC;
    }

    function readArrow(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const { fromR, fromC, toR, toC } = raw;
        if (!MoveGen.validCoords(fromR, fromC, toR, toC)) return null;
        if (fromR === toR && fromC === toC) return null;
        return { fromR, fromC, toR, toC };
    }

    /**
     * Löst den offenen Tipp von `predictor` gegen den tatsächlichen Zug auf.
     * Wird aufgerufen, BEVOR der Ziehende seinen neuen Tipp ablegt.
     */
    function resolvePrediction(room, predictor, actual) {
        const pend = room.pending[predictor];
        room.pending[predictor] = null;

        const shield = findEffect(room, predictor, 'streak_shield');
        const result = { arrows: pend ? pend.arrows : [], hit: false, skipped: !pend, coins: 0, shielded: false };

        if (!pend) {
            // Kein Tipp abgegeben: die Serie reißt — sonst könnte man eine
            // hohe Streak einfach "parken", indem man aufhört zu tippen.
            if (shield) { consumeCharge(room, shield); result.shielded = true; }
            else room.streak[predictor] = 0;
            return result;
        }

        room.guesses[predictor] += 1;
        result.hit = pend.arrows.some(a => sameMove(a, actual));

        if (result.hit) {
            room.streak[predictor] += 1;
            room.hits[predictor] += 1;
            if (room.streak[predictor] > room.bestStreak[predictor]) {
                room.bestStreak[predictor] = room.streak[predictor];
            }
            const dbl = findEffect(room, predictor, 'double_coins');
            const coins = Items.coinsForHit(room.streak[predictor], !!dbl);
            room.coins[predictor] += coins;
            result.coins = coins;
            if (dbl) consumeCharge(room, dbl);
        } else if (shield) {
            consumeCharge(room, shield);
            result.shielded = true;
        } else {
            room.streak[predictor] = 0;
        }
        return result;
    }

    // =================================================================
    // Items kaufen
    // =================================================================

    /** Behält der Gegner nach einer Brettänderung noch legale Züge? */
    function enemyStillHasMoves(room, boardOverride, effectsPreview) {
        const foe = other(room.turn);
        const saveBoard = room.board;
        const saveEffects = room.effects;
        if (boardOverride) room.board = boardOverride;
        if (effectsPreview) room.effects = effectsPreview;
        let ok;
        try {
            ok = MoveGen.hasAnyLegalMove(room.board, foe, movementOpts(room, foe));
        } finally {
            room.board = saveBoard;
            room.effects = saveEffects;
        }
        return ok;
    }

    /**
     * Führt einen Kauf aus. Gibt {ok, reason?, label?} zurück.
     * Alle Prüfungen laufen hier — der Client darf nichts davon voraussetzen.
     */
    function applyPurchase(room, color, itemId, targets, choice) {
        const item = Items.getItem(itemId);
        if (!item) return { ok: false, reason: 'No such item.' };

        const foe = other(color);
        const myOpts = movementOpts(room, color);

        const ctx = {
            myTurn: room.turn === color,
            inCheck: MoveGen.isInCheck(room.board, color, myOpts),
            enemyInCheck: MoveGen.isInCheck(room.board, foe, movementOpts(room, foe)),
            boughtThisTurn: room.boughtThisTurn[color],
            coins: room.coins[color],
            captured: room.captured[color],
            enemyEffectCount: effectsOf(room, foe).length,
            enemyCanStillCastle: !room.castlingBanned[foe],
            activeIds: effectsOf(room, color).map(e => e.id)
        };
        const gate = Items.canBuy(itemId, ctx);
        if (!gate.ok) return gate;

        // Ziele formal prüfen (identische Regeln wie im Client)
        const slots = item.targets || [];
        const given = Array.isArray(targets) ? targets : [];
        if (given.length !== slots.length) return { ok: false, reason: 'Wrong number of targets.' };
        for (let i = 0; i < slots.length; i++) {
            const v = Items.isValidTarget(slots[i], room.board, color, given[i], room.captured[color]);
            if (!v.ok) return v;
        }

        let label = item.name;

        switch (itemId) {

            case 'swap': {
                const [a, b] = given;
                if (a.r === b.r && a.c === b.c) return { ok: false, reason: 'Pick two different pieces.' };
                const next = room.board.map(row => row.slice());
                const pa = next[a.r][a.c], pb = next[b.r][b.c];
                // Ein Bauer darf nicht auf einer Grundreihe landen — sonst stünde
                // er dort ohne Umwandlung fest.
                const badPawn = (p, r) => p && p.toLowerCase() === 'p' && (r === 0 || r === 7);
                if (badPawn(pa, b.r) || badPawn(pb, a.r)) {
                    return { ok: false, reason: 'A pawn cannot end up on a back rank.' };
                }
                next[a.r][a.c] = pb;
                next[b.r][b.c] = pa;
                if (MoveGen.isInCheck(next, color, myOpts)) {
                    return { ok: false, reason: 'That swap would leave you in check.' };
                }
                room.board = next;
                // Getauschte Könige und Türme gelten als bewegt.
                [[pa, b], [pb, a]].forEach(([p]) => {
                    if (!p) return;
                    const l = p.toLowerCase();
                    if (l === 'k') room.hasMoved[color === 'w' ? 'wK' : 'bK'] = true;
                });
                [[pa, a], [pb, b]].forEach(([p, from]) => {
                    if (!p || p.toLowerCase() !== 'r') return;
                    MoveGen.updateCastlingRights(room.hasMoved, p, from.r, from.c, from.r, from.c, room.board);
                });
                label = item.name;
                break;
            }

            case 'cavalry':
                addEffect(room, color, 'cavalry', { target: { r: given[0].r, c: given[0].c } });
                break;

            case 'pawn_storm':
                addEffect(room, color, 'pawn_storm');
                break;

            case 'double_move':
                room.pendingDouble[color] = true;
                addEffect(room, color, 'double_move', { chargesLeft: 1, pliesLeft: 0 });
                break;

            case 'no_castling':
                room.castlingBanned[foe] = true;
                addEffect(room, color, 'no_castling', { pliesLeft: 0, chargesLeft: 0 });
                break;

            case 'dispel': {
                const gone = effectsOf(room, foe).filter(e => {
                    const it = Items.getItem(e.id);
                    return !it || !it.permanent;
                });
                gone.forEach(e => removeEffect(room, e));
                room.pendingDouble[foe] = false;
                break;
            }

            case 'freeze': {
                const t = { r: given[0].r, c: given[0].c };
                const preview = room.effects.concat([{ uid: -1, id: 'freeze', owner: color, target: t, pliesLeft: 2 }]);
                if (!enemyStillHasMoves(room, null, preview)) {
                    return { ok: false, reason: 'That would leave your opponent with no legal move.' };
                }
                addEffect(room, color, 'freeze', { target: t });
                break;
            }

            case 'minefield': {
                const [a, b] = given;
                if (a.r === b.r && a.c === b.c) return { ok: false, reason: 'Pick two different squares.' };
                const squares = [{ r: a.r, c: a.c }, { r: b.r, c: b.c }];
                const preview = room.effects.concat([{ uid: -1, id: 'minefield', owner: color, squares, pliesLeft: 3 }]);
                if (!enemyStillHasMoves(room, null, preview)) {
                    return { ok: false, reason: 'That would leave your opponent with no legal move.' };
                }
                addEffect(room, color, 'minefield', { squares });
                break;
            }

            case 'recruit': {
                const t = given[0];
                const next = room.board.map(row => row.slice());
                next[t.r][t.c] = color === 'w' ? 'P' : 'p';
                // Ein geschenkter Bauer darf keine Partie sofort beenden.
                const foeOpts = movementOpts(room, foe);
                if (MoveGen.isInCheck(next, foe, foeOpts) && !MoveGen.hasAnyLegalMove(next, foe, foeOpts)) {
                    return { ok: false, reason: 'A recruit may not deliver checkmate.' };
                }
                room.board = next;
                break;
            }

            case 'resurrect': {
                const list = Items.normalizeCaptured(room.captured[color]);
                const idx = given[0].index;
                const piece = list[idx];
                const t = given[1];
                if (!piece) return { ok: false, reason: 'That captured piece does not exist.' };
                if (piece.toLowerCase() === 'p' && t.r === Items.backRank(color)) {
                    return { ok: false, reason: 'A pawn cannot return to your back rank.' };
                }
                const next = room.board.map(row => row.slice());
                next[t.r][t.c] = color === 'w' ? piece.toUpperCase() : piece.toLowerCase();
                if (MoveGen.isInCheck(next, foe, movementOpts(room, foe))) {
                    return { ok: false, reason: 'The revived piece may not give check immediately.' };
                }
                room.board = next;
                room.captured[color].splice(room.captured[color].indexOf(piece), 1);
                label = item.name;
                break;
            }

            case 'upgrade': {
                const t = given[0];
                const piece = room.board[t.r][t.c];
                const options = Items.upgradeOptions(piece);
                if (!options.length) return { ok: false, reason: 'That piece cannot be upgraded.' };
                let pick = options[0];
                if (options.length > 1) {
                    const want = typeof choice === 'string' ? choice.toLowerCase() : '';
                    if (options.indexOf(want) === -1) return { ok: false, reason: 'Pick what it should become.' };
                    pick = want;
                }
                room.board[t.r][t.c] = color === 'w' ? pick.toUpperCase() : pick;
                break;
            }

            case 'second_guess':
            case 'streak_shield':
            case 'double_coins':
                addEffect(room, color, itemId);
                break;

            case 'cloak':
                addEffect(room, color, 'cloak');
                break;

            case 'fog':
                addEffect(room, color, 'fog');
                break;

            default:
                return { ok: false, reason: 'No such item.' };
        }

        // Cloak wirkt auf den NÄCHSTEN Kauf, nicht auf sich selbst.
        const cloak = itemId === 'cloak' ? null : findEffect(room, color, 'cloak');
        let hidden = false;
        if (cloak) {
            hidden = true;
            consumeCharge(room, cloak);
            const justAdded = room.effects.filter(e => e.owner === color && e.id === itemId);
            const last = justAdded[justAdded.length - 1];
            if (last) last.hidden = true;
        }

        room.coins[color] -= item.price;
        room.boughtThisTurn[color] = true;
        return { ok: true, label, hidden };
    }

    // =================================================================
    // Socket-Handler
    // =================================================================

    function seatOf(room, socket) {
        if (room.players.w && room.players.w.socketId === socket.id) return 'w';
        if (room.players.b && room.players.b.socketId === socket.id) return 'b';
        return null;
    }

    function playerPayload(socket, name) {
        const u = socketUser(socket);
        return {
            socketId: socket.id,
            playerId: generatePlayerId(),
            name: sanitizeName(u ? u.displayName : name, 'Player'),
            pfp: sanitizePfp(u ? u.profileImageUrl : ''),
            userId: u ? u.id : null,
            connected: true
        };
    }

    function startIfReady(room, code) {
        if (!room.ready.w || !room.ready.b || room.isGameStarted) return;
        room.isGameStarted = true;
        nsp.to(code).emit('start_match_countdown', { seconds: 3 });
        setTimeout(() => {
            const r = rooms.get(code);
            if (!r || r.isGameOver) return;
            armMoveTimer(r);
            pushState(r, 'match_started', {});
        }, 3000).unref();
    }

    nsp.on('connection', (socket) => {

        socket.on('disconnect', () => { socketRateLimits.delete(socket.id); });

        // ---- Raum anlegen -------------------------------------------
        socket.on('create_prediction_room', safeHandler(socket, 'create_prediction_room', (data) => {
            if (!checkRateLimit(socket.id)) return;
            const code = generateRoomCode();
            const room = createRoom(code);
            const want = data.colorChoice === 'b' ? 'b'
                       : data.colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : 'w';
            room.players[want] = playerPayload(socket, data.playerName);
            rooms.set(code, room);
            socket.join(code);
            socket.emit('prediction_room_created', Object.assign({
                roomCode: code,
                color: want,
                playerId: room.players[want].playerId
            }, stateFor(room, want)));
        }));

        // ---- Beitreten ------------------------------------------------
        socket.on('join_prediction_room', safeHandler(socket, 'join_prediction_room', (data) => {
            if (!checkRateLimit(socket.id)) return;
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room) return socket.emit('error_msg', 'Room not found.');
            const free = !room.players.w ? 'w' : (!room.players.b ? 'b' : null);
            if (!free) return socket.emit('error_msg', 'Room is full.');

            room.players[free] = playerPayload(socket, data.playerName);
            touch(room);
            socket.join(code);

            socket.emit('prediction_room_joined', Object.assign({
                roomCode: code,
                color: free,
                playerId: room.players[free].playerId
            }, stateFor(room, free)));

            nsp.to(code).emit('opponent_info', {
                w: room.players.w ? { name: room.players.w.name, pfp: room.players.w.pfp } : null,
                b: room.players.b ? { name: room.players.b.name, pfp: room.players.b.pfp } : null
            });
        }));

        // ---- Bereit ---------------------------------------------------
        socket.on('player_ready', safeHandler(socket, 'player_ready', (data) => {
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room) return;
            const col = seatOf(room, socket);
            if (!col) return;
            room.ready[col] = true;
            touch(room);
            nsp.to(code).emit('ready_state', room.ready);
            startIfReady(room, code);
        }));

        // ---- Zug + Tipp -----------------------------------------------
        socket.on('request_prediction_move', safeHandler(socket, 'request_prediction_move', (data) => {
            if (!checkRateLimit(socket.id)) return;
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room || room.isGameOver || !room.isGameStarted) return;

            const color = seatOf(room, socket);
            if (!color) return;
            if (room.turn !== color) return socket.emit('error_msg', 'Not your turn.');

            const { fromR, fromC, toR, toC } = data;
            if (!MoveGen.validCoords(fromR, fromC, toR, toC)) {
                return socket.emit('error_msg', 'Illegal move.');
            }
            const piece = room.board[fromR][fromC];
            if (!piece) return socket.emit('error_msg', 'Illegal move.');
            if (MoveGen.colorOf(piece) !== color) return socket.emit('error_msg', 'Not your piece.');

            // Der zweite Zug eines Double Move darf weder schlagen noch Schach geben.
            const isSecond = room.doubleSecond[color];

            const opts = movementOpts(room, color, isSecond ? { noCapture: true, noCheck: true } : null);
            const legal = MoveGen.legalMoves(room.board, fromR, fromC, opts);
            const chosen = legal.find(m => m.r === toR && m.c === toC);
            if (!chosen) return socket.emit('error_msg', 'Illegal move.');

            // Tippen ist Pflicht — geprueft NACH der Zuglegalitaet, damit ein
            // illegaler Zug auch als solcher gemeldet wird. Ausnahme: der zweite
            // Zug eines Double Move, dort laeuft der Tipp aus dem ersten noch.
            const arrows = [];
            const a1 = readArrow(data.prediction);
            if (a1) arrows.push(a1);
            const sg = findEffect(room, color, 'second_guess');
            const a2 = readArrow(data.prediction2);
            if (a2 && sg && !sameMove(a1, a2)) arrows.push(a2);
            if (!isSecond && !arrows.length) {
                return socket.emit('error_msg', "Call your opponent's next move first.");
            }

            // --- Zug ausführen ---------------------------------------
            const res = MoveGen.applyClassicMove(room.board, {
                fromR, fromC, toR, toC, type: chosen.type, promotedTo: data.promotedTo
            }, { enPassantTarget: room.enPassantTarget });

            room.board = res.board;
            room.enPassantTarget = res.enPassantTarget;
            MoveGen.updateCastlingRights(room.hasMoved, piece, fromR, fromC, toR, toC, room.board);
            if (res.captured) {
                const owner = MoveGen.colorOf(res.captured);
                room.captured[owner].push(res.captured.toLowerCase());
            }

            // Cavalry wandert mit der Figur mit.
            const cav = findEffect(room, color, 'cavalry');
            if (cav && cav.target && cav.target.r === fromR && cav.target.c === fromC) {
                cav.target = { r: toR, c: toC };
            }

            const actual = { fromR, fromC, toR, toC };
            room.history.push(actual);

            // --- Tipp des Gegners auflösen, DANN eigenen ablegen ------
            const foe = other(color);
            const resolved = resolvePrediction(room, foe, actual);
            room.lastResult[foe] = resolved;

            if (arrows.length > 1 && sg) consumeCharge(room, sg);
            if (arrows.length) room.pending[color] = { arrows };

            // --- Effekte, Zugrecht, Uhr ------------------------------
            tickEffects(room, color);
            room.boughtThisTurn[color] = false;

            let keepTurn = false;
            if (room.doubleSecond[color]) {
                room.doubleSecond[color] = false;
            } else if (room.pendingDouble[color]) {
                room.pendingDouble[color] = false;
                room.doubleSecond[color] = true;
                const dm = findEffect(room, color, 'double_move');
                if (dm) removeEffect(room, dm);
                keepTurn = true;
            }
            if (!keepTurn) room.turn = foe;
            armMoveTimer(room);
            touch(room);

            pushState(room, 'apply_prediction_move', {
                move: { fromR, fromC, toR, toC, type: res.type, promotedTo: res.promotedTo, rook: res.rook },
                mover: color,
                extraMove: keepTurn,
                predictionResult: { by: foe, arrows: resolved.arrows, hit: resolved.hit, skipped: resolved.skipped, coins: resolved.coins, shielded: resolved.shielded }
            });

            // --- Matt / Patt ------------------------------------------
            const status = MoveGen.gameStatus(room.board, room.turn, movementOpts(room, room.turn));
            if (status === 'checkmate') endGame(code, other(room.turn), 'checkmate');
            else if (status === 'stalemate') endGame(code, null, 'stalemate');
        }));

        // ---- Item kaufen ------------------------------------------------
        socket.on('buy_item', safeHandler(socket, 'buy_item', (data) => {
            if (!checkRateLimit(socket.id)) return;
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room || room.isGameOver || !room.isGameStarted) return;
            const color = seatOf(room, socket);
            if (!color) return;

            const targets = Array.isArray(data.targets) ? data.targets.slice(0, 2) : [];
            const out = applyPurchase(room, color, data.itemId, targets, data.choice);
            if (!out.ok) return socket.emit('error_msg', out.reason || 'Purchase refused.');

            touch(room);
            const item = Items.getItem(data.itemId);

            ['w', 'b'].forEach(col => {
                const p = room.players[col];
                if (!p || !p.socketId) return;
                const sock = nsp.sockets.get(p.socketId);
                if (!sock) return;
                const conceal = out.hidden && col !== color;
                sock.emit('item_purchased', Object.assign({
                    by: color,
                    itemId: conceal ? null : data.itemId,
                    icon: conceal ? '❓' : item.icon,
                    label: conceal ? 'Item used' : item.name,
                    targets: conceal ? [] : targets,
                    hidden: conceal
                }, stateFor(room, col), { you: col }));
            });

            // Ein Item kann den Gegner mattsetzen (z. B. Upgrade zur Dame).
            const status = MoveGen.gameStatus(room.board, room.turn, movementOpts(room, room.turn));
            if (status === 'stalemate') endGame(code, null, 'stalemate');
        }));

        // ---- Aufgeben / Remis --------------------------------------------
        socket.on('resign', safeHandler(socket, 'resign', (data) => {
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room) return;
            const col = seatOf(room, socket);
            if (!col) return;
            endGame(code, other(col), 'resign');
        }));

        socket.on('offer_draw', safeHandler(socket, 'offer_draw', (data) => {
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room || room.isGameOver) return;
            const col = seatOf(room, socket);
            if (!col) return;
            room.drawOfferBy = col;
            socket.to(code).emit('draw_offered', { by: col });
        }));

        socket.on('respond_draw', safeHandler(socket, 'respond_draw', (data) => {
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room || room.isGameOver || !room.drawOfferBy) return;
            const col = seatOf(room, socket);
            // Das eigene Angebot kann man nicht selbst annehmen.
            if (!col || col === room.drawOfferBy) return;
            room.drawOfferBy = null;
            if (data.accepted === true) endGame(code, null, 'draw');
            else socket.to(code).emit('draw_declined', {});
        }));

        // ---- Verbindungsabbruch ------------------------------------------
        socket.on('disconnecting', safeHandler(socket, 'disconnecting', () => {
            for (const code of socket.rooms) {
                const room = rooms.get(code);
                if (!room || room.isGameOver) continue;
                const col = seatOf(room, socket);
                if (!col) continue;
                room.players[col].connected = false;
                room.players[col].socketId = null;
                socket.to(code).emit('opponent_disconnected', { color: col, graceMs: DISCONNECT_FORFEIT_MS });
                if (!room.isGameStarted) continue;
                if (room.disconnectTimers[col]) clearTimeout(room.disconnectTimers[col]);
                room.disconnectTimers[col] = setTimeout(() => {
                    const r = rooms.get(code);
                    if (!r || r.isGameOver) return;
                    if (r.players[col] && r.players[col].connected) return;
                    endGame(code, other(col), 'disconnect');
                }, DISCONNECT_FORFEIT_MS);
                if (room.disconnectTimers[col].unref) room.disconnectTimers[col].unref();
            }
        }));

        // ---- Reconnect ------------------------------------------------------
        socket.on('reconnect_prediction_room', safeHandler(socket, 'reconnect_prediction_room', (data) => {
            const code = sanitizeRoomCode(data.roomCode);
            const room = code && rooms.get(code);
            if (!room) return socket.emit('error_msg', 'Room not found.');
            const col = data.playerColor === 'b' ? 'b' : 'w';
            const seat = room.players[col];
            if (!seat || seat.playerId !== data.playerId) {
                return socket.emit('error_msg', 'Could not restore your seat.');
            }
            if (room.disconnectTimers[col]) {
                clearTimeout(room.disconnectTimers[col]);
                room.disconnectTimers[col] = null;
            }
            seat.connected = true;
            seat.socketId = socket.id;
            socket.join(code);
            socket.emit('prediction_room_reconnected', Object.assign({
                roomCode: code, color: col, playerId: seat.playerId
            }, stateFor(room, col)));
            socket.to(code).emit('opponent_reconnected', { color: col });
        }));
    });

    return { rooms, nsp, endGame };
};
