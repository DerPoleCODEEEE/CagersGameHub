/* eslint-env browser */
/* global Chess */
/**
 * VS Cager Bot — Client.
 *
 * Struktur:
 *   1. State & Persistenz
 *   2. Engine-Anbindung (Stockfish im Worker)
 *   3. Entscheidungsmatrix (Win%, Prinzipien, Tilt, Softmax)
 *   4. Brett & UI
 *
 * Der Bot-Modus läuft vollständig im Browser; der Server nimmt nur das
 * Endergebnis entgegen (stark rate-limitiert).
 */
(function () {
    'use strict';

    const DU = window.DomUtils;

    // chess.js kommt von einem fremden CDN. Fällt das aus (Ausfall, Adblocker,
    // strengere CSP), warf `new Chess()` vorher eine ReferenceError und die
    // KOMPLETTE Seite blieb tot — ohne jeden Hinweis für den Nutzer.
    if (typeof Chess !== 'function') {
        const warn = document.createElement('div');
        warn.className = 'result-banner';
        warn.setAttribute('role', 'alert');
        warn.textContent = 'Die Schach-Bibliothek konnte nicht geladen werden. ' +
            'Bitte Seite neu laden oder Adblocker/Netzwerksperre prüfen.';
        (document.body || document.documentElement).appendChild(warn);
        console.error('chess.js konnte nicht geladen werden — Bot-Modus deaktiviert.');
        return;
    }

    const chess = new Chess();

    let cagerBook = null;
    let cagerConfig = null;

    // =====================================================================
    // 1. STATE
    // =====================================================================
    let currentBotId = 'cager';
    let currentBotName = 'TheCager';
    let currentBotColor = '9b59b6';

    let playerColor = 'w';
    let botColor = 'b';

    let tiltScore = 0;
    let evalBeforeBotMove = 0;
    let lastExpectedOpponentReply = null;
    let isGameOver = false;

    let isZenMode = false;
    let timeControlSeconds = 180;
    let incrementSeconds = 2;
    let clocks = { w: 180, b: 180 };
    let clockTimer = null;
    let gameStarted = false;
    let lowTimeWarned = { w: false, b: false };

    let selectedSquare = null;
    let validMoves = [];

    let currentSearchDepth = 0;
    let pvMapAtHighestDepth = {};
    let searchFen = null;
    /** Verhindert, dass Undo/Restart mitten in einer laufenden Suche stören. */
    let isEngineThinking = false;
    /** Zähler: jede Suche/Zugplanung bekommt eine Generation. Kommt ein
     *  Ergebnis aus einer alten Generation an, wird es verworfen. */
    let moveGeneration = 0;

    // Alle schwebenden Timer — vorher wurden sie nie gecancelt, wodurch ein
    // für die alte Stellung berechneter Bot-Zug nach "New Game" auf dem
    // frischen Brett landete.
    let botMoveTimeout = null;
    let botTurnTimeout = null;
    let testerTimeout = null;

    let twitchName = null, twitchPfp = '';
    try {
        twitchName = localStorage.getItem('cager_twitch_name');
        twitchPfp = DU.safeImageUrl(localStorage.getItem('cager_twitch_pfp'), '');
    } catch (e) { /* ignore */ }

    const isAdmin = !!(twitchName && twitchName.trim().toLowerCase() === 'schachspielenderpole');

    let autoPlayActive = false;
    let testerStockfish = null;
    let testerStockfishUrl = null;
    let testerElo = 2000;
    let testerDepth = 8;

    /** Chat als Datenmodell statt HTML-Blob (vorher eine Stored-XSS-Senke). */
    let chatLog = [];
    const CHAT_MAX = 60;

    const SAVE_KEY = 'cager_bot_save_state';
    let saveDirty = false;
    let lastSaveAt = 0;
    const SAVE_MIN_INTERVAL_MS = 4000;

    // =====================================================================
    // MODALS & KOPFBEREICH
    // =====================================================================
    const rulesModalEl = document.getElementById('rules-modal');
    const rulesModal = DU.makeAccessibleModal(rulesModalEl);
    const btnShowRules = document.getElementById('btn-show-rules');
    const closeRulesBtn = document.getElementById('close-rules-btn');
    if (btnShowRules) btnShowRules.addEventListener('click', () => rulesModal.open());
    if (closeRulesBtn) closeRulesBtn.addEventListener('click', () => rulesModal.close());
    if (rulesModalEl) rulesModalEl.addEventListener('click', (e) => { if (e.target === rulesModalEl) rulesModal.close(); });

    if (twitchName) document.getElementById('my-name').textContent = twitchName;
    if (twitchPfp) {
        const pfp = document.getElementById('my-pfp');
        pfp.src = twitchPfp;
        pfp.classList.remove('hidden');
    }

    function getSelectedPlayerColor() {
        const select = document.getElementById('color-select');
        if (!select) return 'w';
        const val = select.value;
        if (val === 'random') return Math.random() < 0.5 ? 'w' : 'b';
        return val === 'b' ? 'b' : 'w';
    }

    // =====================================================================
    // PERSISTENZ
    // =====================================================================
    function peekSavedBotId() {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) return null;
            const saved = JSON.parse(raw);
            return (saved && !saved.isGameOver && saved.currentBotId) ? saved.currentBotId : null;
        } catch (e) { return null; }
    }

    function saveBotState(force) {
        if (!gameStarted || isGameOver) return;
        const now = Date.now();
        if (!force && now - lastSaveAt < SAVE_MIN_INTERVAL_MS) { saveDirty = true; return; }
        lastSaveAt = now;
        saveDirty = false;
        try {
            localStorage.setItem(SAVE_KEY, JSON.stringify({
                v: 2,
                fen: chess.fen(),
                pgnMoves: chess.history(),
                clocks,
                currentBotId,
                playerColor,
                botColor,
                isZenMode,
                timeControlSeconds,
                incrementSeconds,
                gameStarted,
                isGameOver,
                chatLog: chatLog.slice(-CHAT_MAX)
            }));
        } catch (e) {
            // Quota erreicht: Chat kürzen und ein zweites Mal versuchen,
            // statt den Fehler still zu schlucken (vorher: leeres catch).
            console.warn('Speichern fehlgeschlagen, kürze Chatverlauf:', e && e.name);
            chatLog = chatLog.slice(-10);
            try {
                localStorage.setItem(SAVE_KEY, JSON.stringify({
                    v: 2, fen: chess.fen(), clocks, currentBotId, playerColor, botColor,
                    isZenMode, timeControlSeconds, incrementSeconds, gameStarted, isGameOver,
                    chatLog
                }));
            } catch (e2) {
                console.warn('Auto-Save deaktiviert (Speicher voll).');
            }
        }
    }

    function loadBotState() {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) return false;
            const saved = JSON.parse(raw);
            if (!saved || !saved.fen || saved.isGameOver) return false;
            if (!chess.load(saved.fen)) return false;

            clocks = saved.clocks || clocks;
            playerColor = saved.playerColor === 'b' ? 'b' : 'w';
            botColor = playerColor === 'w' ? 'b' : 'w';
            isZenMode = !!saved.isZenMode;
            timeControlSeconds = saved.timeControlSeconds || 180;
            incrementSeconds = saved.incrementSeconds !== undefined ? saved.incrementSeconds : 2;
            gameStarted = !!saved.gameStarted;
            isGameOver = false;

            const boardEl = document.getElementById('board');
            if (boardEl) boardEl.classList.toggle('flipped', playerColor === 'b');

            chatLog = Array.isArray(saved.chatLog) ? saved.chatLog.slice(-CHAT_MAX) : [];
            renderChat();

            const colorSelect = document.getElementById('color-select');
            if (colorSelect) colorSelect.value = playerColor;
            const timeSelect = document.getElementById('time-select');
            if (timeSelect) timeSelect.value = isZenMode ? 'zen' : String(timeControlSeconds);
            const incSelect = document.getElementById('inc-select');
            if (incSelect) incSelect.value = String(incrementSeconds);

            updateTimeSettings();
            renderBoard();
            renderClocks();

            if (gameStarted && !isGameOver) {
                startClock();
                // Ist der Bot am Zug, muss er nach dem Reload weiterspielen.
                if (chess.turn() === botColor && !chess.game_over()) {
                    scheduleBotTurn(600);
                }
            }
            return true;
        } catch (e) {
            console.warn('Spielstand konnte nicht geladen werden:', e);
            return false;
        }
    }

    function clearBotSaveState() {
        try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    }

    // =====================================================================
    // TIMER-VERWALTUNG
    // =====================================================================
    /** Bricht alles ab, was noch für die alte Stellung geplant war. */
    function cancelPendingBotWork() {
        moveGeneration++;
        if (botMoveTimeout) { clearTimeout(botMoveTimeout); botMoveTimeout = null; }
        if (botTurnTimeout) { clearTimeout(botTurnTimeout); botTurnTimeout = null; }
        if (testerTimeout) { clearTimeout(testerTimeout); testerTimeout = null; }
        if (isEngineThinking && stockfish) {
            try { stockfish.postMessage('stop'); } catch (e) { /* ignore */ }
        }
        isEngineThinking = false;
        pvMapAtHighestDepth = {};
        currentSearchDepth = 0;
    }

    function stopClock() {
        if (clockTimer) clearInterval(clockTimer);
        // Vorher wurde clockTimer nicht auf null gesetzt; startClock() returnte
        // danach sofort und die Uhr blieb auf jedem Pfad tot.
        clockTimer = null;
    }

    function scheduleBotTurn(delay) {
        if (botTurnTimeout) clearTimeout(botTurnTimeout);
        const gen = moveGeneration;
        botTurnTimeout = setTimeout(() => {
            botTurnTimeout = null;
            if (gen !== moveGeneration) return;
            triggerBotTurn();
        }, delay);
    }

    window.addEventListener('beforeunload', () => {
        cancelPendingBotWork();
        stopClock();
        if (stockfish) { try { stockfish.terminate(); } catch (e) {} }
        if (testerStockfish) { try { testerStockfish.terminate(); } catch (e) {} }
        if (stockfishUrl) URL.revokeObjectURL(stockfishUrl);
        if (testerStockfishUrl) URL.revokeObjectURL(testerStockfishUrl);
    });

    // =====================================================================
    // MATHEMATIK
    // =====================================================================
    function cpToWinPct(cp) {
        if (cp === undefined || cp === null) return 50.0;
        const cappedCp = Math.max(-4000, Math.min(4000, cp));
        return 50 + 50 * ((2 / (1 + Math.exp(-0.00368208 * cappedCp))) - 1);
    }

    function saveGameResult(result) {
        // Nur noch der Bot-Modus darf Ergebnisse melden; der Server lehnt
        // alles andere ab und begrenzt die Rate.
        fetch('/api/stats/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'bot', result })
        })
            .then(res => res.json())
            .then(data => { if (!data || !data.success) console.warn('Stats:', data); })
            .catch(err => console.warn('Stats konnten nicht gespeichert werden:', err));
    }

    function getSquareColor(squareStr) {
        if (!squareStr || squareStr.length < 2) return 'light';
        const file = squareStr.charCodeAt(0) - 97;
        const rank = parseInt(squareStr[1], 10);
        return (file + rank) % 2 === 0 ? 'dark' : 'light';
    }

    // isEndgamePhase lief 64x get() — und das zweimal pro Zug. Memo pro FEN.
    let phaseMemoFen = null, phaseMemoVal = null;

    function isEndgamePhase(chessObj) {
        let queens = 0;
        let nonPawnMaterial = 0;
        const weights = { n: 3, b: 3, r: 5, q: 9 };
        const rows = chessObj.board();
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = rows[r][c];
                if (!piece) continue;
                if (piece.type === 'q') queens++;
                if (weights[piece.type]) nonPawnMaterial += weights[piece.type];
            }
        }
        return queens === 0 || nonPawnMaterial <= 25;
    }

    function getCurrentPhase(chessObj) {
        const fen = chessObj.fen();
        if (fen === phaseMemoFen) return phaseMemoVal;
        const moveCount = chessObj.history().length;
        let phase;
        if (isEndgamePhase(chessObj)) phase = 'endgame';
        else if (moveCount <= 12) phase = 'opening';
        else phase = 'middlegame';
        phaseMemoFen = fen;
        phaseMemoVal = phase;
        return phase;
    }

    // =====================================================================
    // SCHACHPRINZIPIEN
    // =====================================================================
    function applySmartPrinciples(candidateMoves, chessObj, profile) {
        if (!candidateMoves || candidateMoves.length === 0) return candidateMoves;

        const bestWinPct = cpToWinPct(candidateMoves[0].stockfishEval);
        const phase = getCurrentPhase(chessObj);
        const pAdh = profile.principlesAdherence || {};
        const inCheck = chessObj.in_check();
        const baseFen = chessObj.fen();
        const turn = chessObj.turn();

        return candidateMoves.map(cand => {
            const candWinPct = cpToWinPct(cand.stockfishEval);
            const winLoss = Math.max(0, bestWinPct - candWinPct);
            if (winLoss > 5.0) return Object.assign({}, cand, { principlePenalty: 0 });

            let penalty = 0;
            const temp = new Chess(baseFen);
            const m = temp.move({ from: cand.from, to: cand.to, promotion: cand.promotion });

            if (m) {
                const fileIdx = m.to.charCodeAt(0) - 97;
                const rankIdx = parseInt(m.to[1], 10) - 1;

                if (phase === 'opening') {
                    const openP = pAdh.opening || {};
                    if (m.piece === 'k' && !m.san.includes('O-O') && !inCheck) {
                        penalty += 120 * ((openP.castleDiscipline || 95) / 100);
                    }
                    if (m.piece === 'q' && !m.captured && !inCheck) {
                        penalty += 90 * ((openP.earlyQueenAvoidance || 88) / 100);
                    }
                }

                if (phase === 'middlegame') {
                    const midP = pAdh.middlegame || {};
                    const isBackRank = (turn === 'w' && rankIdx === 0) || (turn === 'b' && rankIdx === 7);
                    if (['n', 'b'].includes(m.piece) && isBackRank && !m.captured && !inCheck) {
                        penalty += 70 * ((midP.backrankAvoidance || 90) / 100);
                    }
                    if (m.piece === 'p' && !m.captured && fileIdx >= 5) {
                        const kingSq = turn === 'w' ? 'g1' : 'g8';
                        const k = chessObj.get(kingSq);
                        if (k && k.type === 'k') penalty += 80 * ((midP.kingShieldSafety || 85) / 100);
                    }
                    if (m.piece === 'n' && [0, 7].includes(fileIdx) && !m.captured && !inCheck) {
                        penalty += 40 * ((midP.knightCentralization || 78) / 100);
                    }
                }

                if (phase === 'endgame') {
                    const endP = pAdh.endgame || {};
                    if (m.piece === 'k' && [0, 7].includes(fileIdx) && !inCheck) {
                        penalty += 50 * ((endP.kingCentralization || 94) / 100);
                    }
                    if (m.piece === 'r' && [2, 3, 4, 5].includes(fileIdx)) {
                        penalty -= 40 * ((endP.rookActivity || 80) / 100);
                    }
                }
            }
            return Object.assign({}, cand, { principlePenalty: penalty });
        });
    }

    // =====================================================================
    // 2. ENGINE
    // =====================================================================
    const STOCKFISH_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';

    let stockfish = null;
    let stockfishUrl = null;
    let engineFailed = false;

    function createEngineWorker() {
        const blob = new Blob([`importScripts('${STOCKFISH_SRC}');`], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        return { worker: new Worker(url), url };
    }

    try {
        const created = createEngineWorker();
        stockfish = created.worker;
        stockfishUrl = created.url;
    } catch (e) {
        engineFailed = true;
        console.error('Stockfish initialization failed:', e);
    }

    /** Sichtbarer Hinweis, statt eines Bretts, das einfach nie zieht. */
    function reportEngineFailure() {
        engineFailed = true;
        addChatMessage(currentBotName, '⚠️ Engine konnte nicht geladen werden — bitte Seite neu laden oder Adblocker/CSP prüfen.');
    }

    if (stockfish) {
        stockfish.onerror = (e) => { console.error('Stockfish-Worker Fehler:', e); reportEngineFailure(); };
        stockfish.postMessage('uci');
        stockfish.postMessage('setoption name MultiPV value 5');

        stockfish.onmessage = (e) => {
            const msg = typeof e.data === 'string' ? e.data : '';
            if (!msg) return;
            if (msg.includes('multipv') && msg.includes(' pv ')) {
                parseStockfishPvLine(msg);
            } else if (msg.startsWith('bestmove')) {
                isEngineThinking = false;
                processSoftmaxDecisionMatrix();
            }
        };
    } else {
        setTimeout(reportEngineFailure, 500);
    }

    /**
     * Bewertet, wie "einfach" eine Mattführung ist. Läuft jetzt nur noch
     * einmal pro Kandidat bei `bestmove` — vorher pro info-Zeile, also
     * potenziell über hundert Mal pro Zug (spürbare Jank-Spitzen).
     */
    function evaluatePvComplexity(fen, pvMoves) {
        const temp = new Chess(fen);
        let sacrifices = 0, quietMoves = 0, nonCheckMoves = 0;
        const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

        for (let i = 0; i < pvMoves.length; i++) {
            const uci = pvMoves[i];
            if (typeof uci !== 'string' || uci.length < 4) break;
            const from = uci.substring(0, 2);
            const to = uci.substring(2, 4);
            const promotion = uci[4] || 'q';
            const isCagersTurn = (i % 2 === 0);

            const pieceBefore = temp.get(from);
            const targetBefore = temp.get(to);
            const m = temp.move({ from, to, promotion });
            if (!m) break;

            if (isCagersTurn) {
                const isCheck = m.san.includes('+') || m.san.includes('#');
                const isCapture = !!m.captured;
                if (!isCheck) nonCheckMoves++;
                if (!isCheck && !isCapture) quietMoves++;
                if (isCapture && pieceBefore && targetBefore) {
                    const attackerVal = values[pieceBefore.type] || 0;
                    const victimVal = values[targetBefore.type] || 0;
                    if (attackerVal > victimVal + 1) sacrifices++;
                }
            }
        }
        return {
            isSimple: (sacrifices === 0) && (quietMoves === 0) && (nonCheckMoves <= 1),
            sacrifices, quietMoves
        };
    }

    function parseStockfishPvLine(line) {
        const parts = line.split(' ');
        const depthIdx = parts.indexOf('depth');
        const pvIndex = parts.indexOf('pv');
        const multiPvIdx = parts.indexOf('multipv');
        const scoreIndex = parts.indexOf('cp');
        const mateIndex = parts.indexOf('mate');

        if (depthIdx !== -1 && depthIdx + 1 < parts.length) {
            const depth = parseInt(parts[depthIdx + 1], 10);
            if (depth > currentSearchDepth) {
                currentSearchDepth = depth;
                pvMapAtHighestDepth = {};
            }
        }

        if (pvIndex === -1 || pvIndex + 1 >= parts.length || multiPvIdx === -1) return;

        const multiPvRank = parseInt(parts[multiPvIdx + 1], 10);
        const pvMoves = parts.slice(pvIndex + 1);
        const moveStr = pvMoves[0];
        if (!moveStr || moveStr.length < 4) return;

        const opponentReply = pvMoves.length > 1 ? pvMoves[1] : null;
        let score = 0;
        let deferredMate = null;

        if (scoreIndex !== -1 && scoreIndex + 1 < parts.length) {
            score = parseInt(parts[scoreIndex + 1], 10) || 0;
        } else if (mateIndex !== -1 && mateIndex + 1 < parts.length) {
            const mateIn = parseInt(parts[mateIndex + 1], 10);
            const absMate = Math.abs(mateIn);
            if (mateIn > 0) {
                if (absMate <= 3) {
                    score = 20000 - absMate * 100;
                } else if (absMate <= 6) {
                    // Auswertung wird bis `bestmove` aufgeschoben.
                    score = 19000 - absMate * 100;
                    deferredMate = { absMate, pvMoves: pvMoves.slice(0, 12) };
                } else {
                    score = Math.max(700, 1200 - absMate * 40);
                }
            } else {
                score = -20000 + absMate * 100;
            }
        }

        pvMapAtHighestDepth[multiPvRank] = {
            moveStr,
            opponentReply,
            stockfishEval: score,
            deferredMate,
            from: moveStr.substring(0, 2),
            to: moveStr.substring(2, 4),
            promotion: moveStr[4] || 'q'
        };
    }

    /** Löst die aufgeschobenen Matt-Bewertungen auf (max. 5 Aufrufe pro Zug). */
    function resolveDeferredMates(candidates) {
        if (!searchFen) return candidates;
        candidates.forEach(cand => {
            if (!cand.deferredMate) return;
            const { absMate, pvMoves } = cand.deferredMate;
            const complexity = evaluatePvComplexity(searchFen, pvMoves);
            cand.stockfishEval = complexity.isSimple
                ? (19000 - absMate * 100)
                : (900 - absMate * 50);
            cand.deferredMate = null;
        });
        return candidates;
    }

    // =====================================================================
    // ZITATE
    // =====================================================================
    const CAGER_QUOTES = {
        start: [
            "Howdy! Welcome back to the channel, let's document the climb!",
            "Alright, let's see if we can handle this position today.",
            "Let's go into a Queen's Gambit, keep it clean, classical and solid.",
            "Don't mind me, just providing some unedited commentary as I play!"
        ],
        cager_capture: [
            { text: "And bye-bye! I'll take that pawn with tempo!", piece: 'p' },
            { text: 'Nom nom, free material! That piece was standing in my way anyway.', piece: 'not_p' },
            { text: 'BANG! We win those, baby! Absolute cinema!' },
            { text: 'Sniped! Clean tactical blow right there.' }
        ],
        player_capture: [
            { text: 'Oof, I did NOT see that check! That is no bueno...' },
            { text: "Ouch! I really don't like where my position is going now." },
            { text: 'Oh man, I am getting put in the blender right now...' }
        ],
        cager_check: [
            { text: 'Check! Watch your king safety, things are getting spicy!' },
            { text: 'Check! Where is your king going now?' }
        ],
        cager_win: [
            'BANG! WE WIN THOSE, BABY! What an absolute comeback!',
            'GG WP! Oh my god, what a battle! That was absolute cinema!'
        ],
        player_win: [
            'GG WP! Man, I got completely outplayed in that endgame!',
            'Respect, great game! You had me completely stuck in the blender.'
        ],
        cager_resign: [
            'No way out of this position for me... GG, you had me completely outplayed!',
            'I yield! I am so bad at chess today, GG WP!'
        ]
    };

    function getRandomQuote(cat, context) {
        context = context || {};
        const list = CAGER_QUOTES[cat];
        if (!list || list.length === 0) return 'GG!';

        const validQuotes = list.filter(q => {
            if (typeof q === 'string') return true;
            if (q.color && context.color && q.color !== context.color) return false;
            if (q.piece && context.piece) {
                if (q.piece === 'p' && context.piece !== 'p') return false;
                if (q.piece === 'not_p' && context.piece === 'p') return false;
            }
            return true;
        });
        if (!validQuotes.length) return 'GG!';
        const chosen = validQuotes[Math.floor(Math.random() * validQuotes.length)];
        return typeof chosen === 'string' ? chosen : chosen.text;
    }

    // =====================================================================
    // BOT-AUSWAHL
    // =====================================================================
    /**
     * @param {object} opts
     * @param {boolean} opts.restoreState  Gespeicherte Partie laden (nur beim Start)
     */
    function changeBot(opts) {
        opts = opts || {};
        const selectEl = document.getElementById('bot-select');
        if (!selectEl) return Promise.resolve();

        cancelPendingBotWork();

        currentBotId = selectEl.value;
        currentBotName = selectEl.options[selectEl.selectedIndex].text;

        let hash = 0;
        for (let i = 0; i < currentBotName.length; i++) {
            hash = currentBotName.charCodeAt(i) + ((hash << 5) - hash);
        }
        currentBotColor = Math.abs(hash).toString(16).substring(0, 6).padStart(6, '0');
        const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentBotName)}&background=${currentBotColor}&color=fff&bold=true`;

        const botNameEl = document.getElementById('bot-name');
        const chatWelcomeEl = document.getElementById('chat-welcome-name');
        const botAvatarEl = document.getElementById('bot-avatar');

        if (botNameEl) botNameEl.textContent = `${currentBotName} (BOT)`;
        if (chatWelcomeEl) chatWelcomeEl.textContent = `${currentBotName}:`;
        if (botAvatarEl) botAvatarEl.src = fallbackAvatar;

        const chessComUsername = currentBotName.replace(/\s+/g, '').toLowerCase();
        fetch(`https://api.chess.com/pub/player/${encodeURIComponent(chessComUsername)}`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data && data.avatar && botAvatarEl) botAvatarEl.src = DU.safeImageUrl(data.avatar, fallbackAvatar);
            })
            .catch(() => { /* Fallback-Avatar bleibt */ });

        return Promise.all([
            fetch(`${currentBotId}-config.json`).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${currentBotId}-book.json`).then(r => r.ok ? r.json() : null).catch(() => null)
        ]).then(([configData, bookData]) => {
            const eloEl = document.getElementById('bot-elo');
            if (configData) {
                cagerConfig = configData;
                const elo = configData.targetElo || 1500;
                if (eloEl) eloEl.textContent = `${elo} ELO`;
                if (stockfish) {
                    const skill = Math.max(0, Math.min(20, Math.round((elo - 1000) / 2000 * 20)));
                    stockfish.postMessage('setoption name UCI_LimitStrength value true');
                    stockfish.postMessage(`setoption name UCI_Elo value ${elo}`);
                    stockfish.postMessage(`setoption name Skill Level value ${skill}`);
                }
            } else {
                cagerConfig = {};
                if (eloEl) eloEl.textContent = '??? ELO';
                console.warn(`${currentBotId}-config.json fehlt — Bot spielt ohne Persönlichkeitsprofil.`);
            }

            cagerBook = (bookData && bookData.book) ? bookData.book : {};
            if (!bookData) console.warn(`${currentBotId}-book.json fehlt — Bot spielt ohne Eröffnungsbuch.`);

            // Vorher überschrieb loadBotState() hier die gerade getroffene
            // Auswahl: Anzeige = Bot B, gespielt wurde Bot A.
            if (opts.restoreState) {
                if (!loadBotState()) restartGame();
            } else {
                clearBotSaveState();
                restartGame();
            }
        });
    }

    // =====================================================================
    // 3. ENTSCHEIDUNGSMATRIX
    // =====================================================================
    function processSoftmaxDecisionMatrix() {
        const gen = moveGeneration;
        let candidates = Object.values(pvMapAtHighestDepth).sort((a, b) => b.stockfishEval - a.stockfishEval);
        pvMapAtHighestDepth = {};
        currentSearchDepth = 0;

        if (candidates.length === 0 || isGameOver) return;
        if (chess.turn() !== botColor) return;   // Stellung hat sich geändert

        candidates = resolveDeferredMates(candidates)
            .sort((a, b) => b.stockfishEval - a.stockfishEval);

        const currentTurn = chess.turn();
        const colorKey = currentTurn === 'w' ? 'white' : 'black';
        const profile = (cagerConfig && cagerConfig[colorKey]) ? cagerConfig[colorKey] : (cagerConfig || {});
        const psycho = (cagerConfig && cagerConfig.psychologyEngine) ? cagerConfig.psychologyEngine : (cagerConfig || {});
        const errorRates = profile.errorRates || { inaccuraciesPercent: 12, mistakesPercent: 5, blundersPercent: 1 };

        const phase = getCurrentPhase(chess);

        let flankAgg = profile.flankPawnAggression !== undefined ? profile.flankPawnAggression : 50;
        if (phase === 'opening' && profile.flankPawnAggressionOpening !== undefined) flankAgg = profile.flankPawnAggressionOpening;
        else if (phase === 'middlegame' && profile.flankPawnAggressionMiddlegame !== undefined) flankAgg = profile.flankPawnAggressionMiddlegame;
        else if (phase === 'endgame' && profile.flankPawnAggressionEndgame !== undefined) flankAgg = profile.flankPawnAggressionEndgame;

        let kingAttackBiasVal = profile.kingAttackBias !== undefined ? profile.kingAttackBias : 35;
        if (phase === 'middlegame' && profile.kingAttackBiasMiddlegame !== undefined) kingAttackBiasVal = profile.kingAttackBiasMiddlegame;
        if (phase === 'endgame' && profile.kingAttackBiasEndgame !== undefined) kingAttackBiasVal = profile.kingAttackBiasEndgame;

        let queenTradeReluctVal = profile.queenTradeReluctance !== undefined ? profile.queenTradeReluctance : 80;
        if (phase === 'middlegame' && profile.queenTradeReluctanceMiddlegame !== undefined) queenTradeReluctVal = profile.queenTradeReluctanceMiddlegame;
        if (phase === 'endgame' && profile.queenTradeReluctanceEndgame !== undefined) queenTradeReluctVal = profile.queenTradeReluctanceEndgame;

        const bestMoveEval = candidates[0].stockfishEval;
        const bestWinPct = cpToWinPct(bestMoveEval);
        const isDirectShortMate = Math.abs(bestMoveEval) >= 18000;
        const isBotWinningMassively = bestWinPct > 95.0 || isDirectShortMate;
        const isComplexPosition = (candidates.length >= 2 && (bestWinPct - cpToWinPct(candidates[1].stockfishEval) < 4.0)) || chess.in_check();

        const history = chess.history({ verbose: true });
        let lastPlayerMoveUCI = null;
        if (history.length > 0) {
            const lastM = history[history.length - 1];
            if (lastM.color !== currentTurn) lastPlayerMoveUCI = lastM.from + lastM.to + (lastM.promotion || '');
        }

        const evalDelta = evalBeforeBotMove - bestMoveEval;
        const opponentFoundPunish = lastExpectedOpponentReply && (lastPlayerMoveUCI === lastExpectedOpponentReply);
        const alpha = psycho.tiltFactorAlpha || 0.20;

        if (evalDelta > 150 && opponentFoundPunish) {
            tiltScore = alpha * tiltScore + (1 - alpha) * (evalDelta * 0.05);
        } else {
            tiltScore *= alpha;
        }

        let isMinefield = false;
        if (candidates.length >= 3 && Math.abs(bestMoveEval) < 500) {
            if (bestMoveEval - candidates[2].stockfishEval > 250) isMinefield = true;
        }
        const tunnelVal = psycho.tunnelVisionPercent !== undefined ? psycho.tunnelVisionPercent : errorRates.blundersPercent;
        const triggerTunnelVision = isMinefield && (Math.random() * 100 < tunnelVal);

        const safeCandidates = candidates.filter((cand, index) => {
            const winLoss = Math.max(0, bestWinPct - cpToWinPct(cand.stockfishEval));
            if (isDirectShortMate) return (bestMoveEval - cand.stockfishEval) === 0;
            if (triggerTunnelVision && index >= 2 && winLoss <= 25.0) return true;
            if (winLoss > 18.0) return false;

            if (winLoss > 6.0) {
                if (winLoss <= 15.0 && (Math.random() * 100 < errorRates.mistakesPercent)) return true;
                const isAggressiveIntent = cand.moveStr.includes('+') || ['g4', 'g5', 'h4', 'h5', 'f4', 'f5'].includes(cand.to);
                const isHighTiltOrTimePanic = tiltScore > 400 || (clocks[currentTurn] < 12 && !isZenMode);
                if (!isComplexPosition && !isHighTiltOrTimePanic) return false;
                if (!isAggressiveIntent && !isHighTiltOrTimePanic) return false;
            }
            return true;
        });

        const finalCandidates = safeCandidates.length > 0 ? safeCandidates : [candidates[0]];
        const candidatesWithPrinciples = applySmartPrinciples(finalCandidates, chess, profile);

        const botRemainingTime = clocks[currentTurn];
        const isLowClockPanic = !isZenMode && botRemainingTime < 30;
        const baseFen = chess.fen();

        const scoredMoves = candidatesWithPrinciples.map((cand, idx) => {
            let cagerScore = cand.stockfishEval - (cand.principlePenalty || 0);
            const tempBoard = new Chess(baseFen);
            const moveDetails = tempBoard.move({ from: cand.from, to: cand.to, promotion: cand.promotion });

            const winLoss = Math.max(0, bestWinPct - cpToWinPct(cand.stockfishEval));
            const isPositionallySound = winLoss <= 4.0;

            if (triggerTunnelVision && idx >= 2) cagerScore += 180;

            if (moveDetails) {
                if (!isBotWinningMassively) {
                    if (moveDetails.san.includes('+') || ['g4', 'g5', 'h4', 'h5', 'f4', 'f5'].includes(cand.to)) {
                        if (isPositionallySound) cagerScore += (kingAttackBiasVal / 100) * 80;
                    }
                    if (moveDetails.captured) {
                        if (moveDetails.captured === 'q') cagerScore -= (queenTradeReluctVal / 100) * 180;
                        else if (moveDetails.piece === moveDetails.captured) cagerScore -= ((profile.tradeAvoidanceIndex || 35) / 100) * 50;
                        if (psycho.panicTradeTendency && isLowClockPanic) cagerScore += 90;
                    }
                    if (moveDetails.piece === 'p' && !moveDetails.captured) {
                        const fileIdx = moveDetails.to.charCodeAt(0) - 97;
                        const isFlank = [0, 1, 6, 7].includes(fileIdx);
                        if (isPositionallySound) {
                            cagerScore += isFlank ? (flankAgg - 50) * 1.2 : (50 - flankAgg) * 1.2;
                        }
                    }
                } else {
                    if (moveDetails.captured) cagerScore += 60;
                    if (moveDetails.san.includes('+')) cagerScore += 40;
                }
            }
            return Object.assign({}, cand, { cagerScore });
        });

        let chosenMove = scoredMoves[0];

        if (isDirectShortMate) {
            chosenMove = scoredMoves.reduce((best, m) => (m.cagerScore > best.cagerScore ? m : best), scoredMoves[0]);
        } else {
            const lambda = psycho.timePressureLambda || 0.045;
            const timePanicTerm = isZenMode ? 0 : Math.exp(-lambda * botRemainingTime);
            const minTiltImpact = Math.min(0.03, tiltScore / 5000);
            const inaccMultiplier = 1 + ((errorRates.inaccuraciesPercent || 10) / 100);
            const effectiveTemp = (psycho.softmaxTemperature || 0.50) * inaccMultiplier * (1 + minTiltImpact + (timePanicTerm * 1.2));

            const maxScore = Math.max.apply(null, scoredMoves.map(m => m.cagerScore));
            const expScores = scoredMoves.map(m => Math.exp((m.cagerScore - maxScore) / (effectiveTemp * 40)));
            const sumExp = expScores.reduce((a, b) => a + b, 0);
            const probabilities = expScores.map(e => e / sumExp);

            let rand = Math.random();
            let cumulative = 0;
            for (let i = 0; i < scoredMoves.length; i++) {
                cumulative += probabilities[i];
                if (rand <= cumulative) { chosenMove = scoredMoves[i]; break; }
            }
        }

        evalBeforeBotMove = bestMoveEval;
        lastExpectedOpponentReply = chosenMove.opponentReply || null;

        let baseThinkTime = isZenMode ? 400 : Math.max(150, Math.min(800, clocks[currentTurn] * 20));
        if (isComplexPosition && !isLowClockPanic) baseThinkTime += 600;

        if (botMoveTimeout) clearTimeout(botMoveTimeout);
        botMoveTimeout = setTimeout(() => {
            botMoveTimeout = null;
            // Generationsprüfung: nach Restart/Undo ist der Zug ungültig.
            if (gen !== moveGeneration) return;
            makeBotMove(chosenMove);
        }, baseThinkTime);
    }

    function triggerBotTurn() {
        if (chess.game_over() || isGameOver) return;
        if (chess.turn() !== botColor) return;

        const history = chess.history();
        const stateKey = history.length > 0 ? 'start_' + history.join('_') : 'start';

        const colorKey = chess.turn() === 'w' ? 'white' : 'black';
        const profile = (cagerConfig && cagerConfig[colorKey]) ? cagerConfig[colorKey] : (cagerConfig || {});
        const bookLoyalty = profile.openingBookLoyalty !== undefined ? profile.openingBookLoyalty : 95;

        if ((Math.random() * 100) <= bookLoyalty && cagerBook && cagerBook[stateKey]) {
            // Gewichtete Auswahl statt "immer der meistgespielte Zug" — sonst
            // spielt der Bot trotz openingBookLoyalty jede Partie dieselbe Linie.
            const entries = Object.entries(cagerBook[stateKey]).filter(e => e[1] >= 2);
            const total = entries.reduce((sum, e) => sum + e[1], 0);
            if (total > 0) {
                let pick = Math.random() * total;
                let moveSan = entries[0][0];
                for (const [san, count] of entries) {
                    pick -= count;
                    if (pick <= 0) { moveSan = san; break; }
                }
                const m = chess.move(moveSan, { sloppy: true });   // vorher Tippfehler: { slate: true }
                if (m) { makeBotMove(m); return; }
            }
        }

        if (!stockfish) { reportEngineFailure(); return; }

        currentSearchDepth = 0;
        pvMapAtHighestDepth = {};
        searchFen = chess.fen();
        isEngineThinking = true;
        stockfish.postMessage(`position fen ${searchFen}`);
        stockfish.postMessage('go movetime 800');
    }

    function makeBotMove(moveObj) {
        if (isGameOver) return;

        let move = moveObj;
        if (moveObj && typeof moveObj === 'object' && !moveObj.color) {
            move = chess.move({ from: moveObj.from, to: moveObj.to, promotion: moveObj.promotion });
            if (!move) {
                // Stellung passt nicht mehr (z.B. nach Undo) — sauber abbrechen,
                // statt weiterzulaufen und das Spiel hängen zu lassen.
                console.warn('Bot-Zug verworfen (Stellung hat sich geändert).');
                return;
            }
        }
        if (!move) return;

        if (!isZenMode && gameStarted) clocks[botColor] += incrementSeconds;

        renderBoard();
        renderClocks();
        saveBotState(true);

        if (window.Sfx) {
            window.Sfx.playMove({
                captured: !!move.captured,
                promoted: !!move.promotion,
                check: chess.in_check(),
                type: move.flags && move.flags.includes('k') ? 'castle'
                    : move.flags && move.flags.includes('q') ? 'castle' : 'normal'
            });
        }

        const toColor = getSquareColor(move.to);
        if (move.captured) {
            addChatMessage(currentBotName, getRandomQuote('cager_capture', { color: toColor, piece: move.captured }));
        } else if (chess.in_check()) {
            addChatMessage(currentBotName, getRandomQuote('cager_check', { color: toColor }));
        }

        if (checkGameOver()) return;

        if (autoPlayActive && chess.turn() === playerColor && isAdmin) {
            if (testerTimeout) clearTimeout(testerTimeout);
            const gen = moveGeneration;
            testerTimeout = setTimeout(() => {
                testerTimeout = null;
                if (gen === moveGeneration) triggerTesterTurn();
            }, 300);
        }
    }

    // =====================================================================
    // UHREN
    // =====================================================================
    function updateTimeSettings() {
        const val = document.getElementById('time-select').value;
        const incLabel = document.getElementById('inc-label');

        if (val === 'zen') {
            isZenMode = true;
            if (incLabel) incLabel.style.display = 'none';
            document.getElementById('bot-clock').textContent = '∞';
            document.getElementById('player-clock').textContent = '∞';
        } else {
            isZenMode = false;
            if (incLabel) incLabel.style.display = 'flex';
            timeControlSeconds = parseInt(val, 10);
            incrementSeconds = parseInt(document.getElementById('inc-select').value, 10);
            if (!gameStarted) clocks = { w: timeControlSeconds, b: timeControlSeconds };
            renderClocks();
        }
    }

    function startClock() {
        if (isZenMode || clockTimer || isGameOver) return;
        clockTimer = setInterval(() => {
            if (chess.game_over() || isGameOver) { stopClock(); return; }

            const turn = chess.turn();
            clocks[turn]--;
            renderClocks();

            if (clocks[turn] <= 15 && clocks[turn] > 0 && !lowTimeWarned[turn]) {
                lowTimeWarned[turn] = true;
                if (turn === playerColor && window.Sfx) window.Sfx.play('low-time');
            }
            if (clocks[turn] > 20) lowTimeWarned[turn] = false;

            // Speichern nicht mehr im Sekundentakt (vorher wurde dabei jedes
            // Mal der komplette Chat-HTML-Blob serialisiert).
            if (saveDirty || Date.now() - lastSaveAt > SAVE_MIN_INTERVAL_MS) saveBotState();

            if (clocks[turn] <= 0) {
                stopClock();
                cancelPendingBotWork();
                isGameOver = true;
                clearBotSaveState();
                const isPlayerLoss = (turn === playerColor);
                saveGameResult(isPlayerLoss ? 'loss' : 'win');
                const winner = isPlayerLoss ? `${currentBotName} (BOT)` : 'You';
                if (window.Sfx) window.Sfx.play('game-end');
                showResult(`Time's up! ${winner} won on time!`);
            }
        }, 1000);
    }

    function renderClocks() {
        if (isZenMode) return;
        const botBox = document.getElementById('bot-clock');
        const playerBox = document.getElementById('player-clock');

        botBox.textContent = formatTime(clocks[botColor]);
        playerBox.textContent = formatTime(clocks[playerColor]);

        botBox.className = 'clock-box' + (chess.turn() === botColor ? ' active' : '') + (clocks[botColor] <= 15 ? ' danger' : '');
        playerBox.className = 'clock-box' + (chess.turn() === playerColor ? ' active' : '') + (clocks[playerColor] <= 15 ? ' danger' : '');
    }

    function formatTime(sec) {
        if (sec <= 0) return '00:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    // =====================================================================
    // 4. BRETT & UI
    // =====================================================================
    const boardEl = document.getElementById('board');
    const squareNodes = [];
    const pieceImgNodes = [];

    function getPieceImgUrl(piece) {
        if (!piece) return '';
        return `https://chessboardjs.com/img/chesspieces/wikipedia/${piece.color}${piece.type.toUpperCase()}.png`;
    }

    function createBoardDOM() {
        DU.clear(boardEl);
        boardEl.setAttribute('role', 'grid');
        boardEl.setAttribute('aria-label', 'Schachbrett');

        for (let r = 0; r < 8; r++) {
            squareNodes[r] = []; pieceImgNodes[r] = [];
            for (let c = 0; c < 8; c++) {
                const square = document.createElement('div');
                square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.r = r;
                square.dataset.c = c;
                square.setAttribute('role', 'gridcell');

                // Persistente <img>-Node statt innerHTML-Neuaufbau pro Frame.
                const img = document.createElement('img');
                img.className = 'piece hidden';
                img.alt = '';
                square.appendChild(img);

                square.addEventListener('click', () => handleSquareClick(r, c));
                DU.makeKeyboardActivatable(square, () => handleSquareClick(r, c), squareLabel(r, c));

                boardEl.appendChild(square);
                squareNodes[r][c] = square;
                pieceImgNodes[r][c] = img;
            }
        }
    }

    const PIECE_NAMES = { p: 'Bauer', n: 'Springer', b: 'Läufer', r: 'Turm', q: 'Dame', k: 'König' };

    function algebraicOf(r, c) { return String.fromCharCode(97 + c) + (8 - r); }

    function squareLabel(r, c) {
        const alg = algebraicOf(r, c);
        const piece = chess.get(alg);
        if (!piece) return `${alg}, leer`;
        return `${alg}, ${piece.color === 'w' ? 'Weiß' : 'Schwarz'} ${PIECE_NAMES[piece.type] || piece.type}`;
    }

    function renderBoard() {
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const square = squareNodes[r][c];
                const img = pieceImgNodes[r][c];
                if (!square || !img) continue;

                const algebraic = algebraicOf(r, c);
                const piece = chess.get(algebraic);

                square.classList.toggle('selected', selectedSquare === algebraic);
                const moveInfo = validMoves.find(m => m.to === algebraic);
                square.classList.toggle('capture-move', !!(moveInfo && moveInfo.captured));
                square.classList.toggle('valid-move', !!(moveInfo && !moveInfo.captured));

                if (piece) {
                    const src = getPieceImgUrl(piece);
                    if (img.getAttribute('src') !== src) img.src = src;
                    img.classList.remove('hidden');
                } else {
                    img.classList.add('hidden');
                }
                square.setAttribute('aria-label', squareLabel(r, c));
            }
        }
    }

    function handleSquareClick(r, c) {
        if (chess.turn() !== playerColor || chess.game_over() || isGameOver || autoPlayActive) return;

        const square = algebraicOf(r, c);
        const piece = chess.get(square);

        if (selectedSquare) {
            const move = chess.move({ from: selectedSquare, to: square, promotion: 'q' });
            if (move) {
                if (!gameStarted) { gameStarted = true; startClock(); }
                if (!isZenMode) clocks[playerColor] += incrementSeconds;

                selectedSquare = null;
                validMoves = [];
                renderBoard();
                renderClocks();
                saveBotState(true);

                if (window.Sfx) {
                    window.Sfx.playMove({
                        captured: !!move.captured,
                        promoted: !!move.promotion,
                        check: chess.in_check(),
                        type: (move.flags && (move.flags.includes('k') || move.flags.includes('q'))) ? 'castle' : 'normal'
                    });
                }

                if (move.captured) addChatMessage('You', getRandomQuote('player_capture'));
                if (checkGameOver()) return;

                scheduleBotTurn(400);
                return;
            }
            if (window.Sfx && (!piece || piece.color !== playerColor)) window.Sfx.play('illegal', { volume: 0.4 });
        }

        if (piece && piece.color === playerColor) {
            selectedSquare = square;
            validMoves = chess.moves({ square, verbose: true });
        } else {
            selectedSquare = null;
            validMoves = [];
        }
        renderBoard();
    }

    // =====================================================================
    // CHAT
    // =====================================================================
    function renderChat() {
        const box = document.getElementById('chat-messages');
        if (!box) return;
        DU.clear(box);
        chatLog.forEach(entry => box.appendChild(buildChatNode(entry)));
        box.scrollTop = box.scrollHeight;
    }

    function buildChatNode(entry) {
        const msg = DU.el('div', { class: `chat-msg ${entry.bot ? 'bot' : ''}` });
        msg.appendChild(DU.el('b', null, entry.sender + ':'));
        // textContent statt innerHTML — der Verlauf wandert durch localStorage.
        msg.appendChild(document.createTextNode(' ' + entry.text));
        return msg;
    }

    function addChatMessage(sender, text) {
        const box = document.getElementById('chat-messages');
        const entry = { sender, text, bot: sender === currentBotName };
        chatLog.push(entry);
        if (chatLog.length > CHAT_MAX) chatLog.shift();
        if (box) {
            box.appendChild(buildChatNode(entry));
            box.scrollTop = box.scrollHeight;
        }
        saveBotState();
    }

    // =====================================================================
    // SPIELENDE
    // =====================================================================
    const resultBanner = document.getElementById('result-banner');
    if (resultBanner) {
        resultBanner.addEventListener('click', () => resultBanner.classList.add('hidden'));
    }

    function showResult(text) {
        addChatMessage(currentBotName, text);
        const banner = resultBanner;
        if (banner) {
            banner.textContent = text + '  (klicken zum Schließen)';
            banner.classList.remove('hidden');
        } else {
            // Fallback, falls das Markup den Banner nicht hat.
            setTimeout(() => alert(text), 50);
        }
    }

    function checkGameOver() {
        if (chess.in_checkmate()) {
            isGameOver = true;
            cancelPendingBotWork();
            stopClock();
            clearBotSaveState();

            const isPlayerWin = (chess.turn() === botColor);
            saveGameResult(isPlayerWin ? 'win' : 'loss');
            addChatMessage(currentBotName, isPlayerWin ? getRandomQuote('player_win') : getRandomQuote('cager_win'));
            if (window.Sfx) window.Sfx.play('game-end');

            if (autoPlayActive && isAdmin) {
                setTimeout(() => { if (autoPlayActive) restartGame(); }, 3000);
            } else {
                showResult(`Checkmate! ${isPlayerWin ? 'You' : currentBotName + ' (BOT)'} wins!`);
            }
            return true;
        }

        if (chess.in_draw() || chess.in_stalemate() || chess.in_threefold_repetition()) {
            isGameOver = true;
            cancelPendingBotWork();
            stopClock();
            clearBotSaveState();
            saveGameResult('draw');
            if (window.Sfx) window.Sfx.play('game-end');

            if (autoPlayActive && isAdmin) {
                setTimeout(() => { if (autoPlayActive) restartGame(); }, 3000);
            } else {
                showResult('Draw! Game Over.');
            }
            return true;
        }
        return false;
    }

    // =====================================================================
    // BUTTONS
    // =====================================================================
    function restartGame() {
        cancelPendingBotWork();
        stopClock();
        gameStarted = false;
        isGameOver = false;
        clearBotSaveState();

        const banner = document.getElementById('result-banner');
        if (banner) banner.classList.add('hidden');

        playerColor = getSelectedPlayerColor();
        botColor = playerColor === 'w' ? 'b' : 'w';
        if (boardEl) boardEl.classList.toggle('flipped', playerColor === 'b');

        chess.reset();
        selectedSquare = null;
        validMoves = [];
        tiltScore = 0;
        evalBeforeBotMove = 0;
        lastExpectedOpponentReply = null;
        lowTimeWarned = { w: false, b: false };
        phaseMemoFen = null;

        updateTimeSettings();
        renderBoard();
        renderClocks();
        addChatMessage(currentBotName, getRandomQuote('start'));
        if (window.Sfx) window.Sfx.play('game-start');

        if (playerColor === 'b') {
            gameStarted = true;
            startClock();
            scheduleBotTurn(500);
        } else if (autoPlayActive && isAdmin) {
            if (testerTimeout) clearTimeout(testerTimeout);
            const gen = moveGeneration;
            testerTimeout = setTimeout(() => {
                testerTimeout = null;
                if (gen === moveGeneration) triggerTesterTurn();
            }, 500);
        }
    }

    document.getElementById('btn-restart').addEventListener('click', restartGame);

    document.getElementById('btn-undo').addEventListener('click', () => {
        if (isGameOver) return;
        // Vorher: blind zweimal undo(). Ohne Guards führte das zu einer
        // hängenden Partie ("Bot am Zug", ohne dass je ein Zug kam).
        if (chess.history().length < 2) {
            addChatMessage(currentBotName, 'Da gibt es noch nichts zurückzunehmen.');
            return;
        }
        cancelPendingBotWork();

        chess.undo();
        chess.undo();
        // Nach zwei Halbzügen ist wieder der Spieler dran; falls nicht
        // (Bot eröffnete), noch einen zurück.
        if (chess.turn() !== playerColor && chess.history().length > 0) chess.undo();

        selectedSquare = null;
        validMoves = [];
        phaseMemoFen = null;
        renderBoard();
        renderClocks();
        saveBotState(true);
    });

    document.getElementById('btn-resign').addEventListener('click', () => {
        if (isGameOver || chess.game_over()) return;
        if (!confirm('Are you sure you want to resign?')) return;
        isGameOver = true;
        cancelPendingBotWork();
        stopClock();
        clearBotSaveState();
        saveGameResult('loss');
        addChatMessage(currentBotName, getRandomQuote('cager_resign'));
        if (window.Sfx) window.Sfx.play('game-end');
        showResult(`You resigned. ${currentBotName} (BOT) wins!`);
    });

    document.getElementById('btn-pgn').addEventListener('click', () => {
        const moves = chess.history();
        if (moves.length === 0) { showResult('No moves played yet!'); return; }

        chess.header('Event', `${currentBotName} Bot Match`);
        chess.header('Site', 'Cagers Game Hub');
        chess.header('Date', new Date().toISOString().split('T')[0].replace(/-/g, '.'));
        chess.header('White', playerColor === 'w' ? (twitchName || 'You') : `${currentBotName} (BOT)`);
        chess.header('Black', playerColor === 'b' ? (twitchName || 'You') : `${currentBotName} (BOT)`);

        let pgnContent = chess.pgn();
        if (!pgnContent) {
            let moveStr = '';
            moves.forEach((m, idx) => {
                if (idx % 2 === 0) moveStr += `${(idx / 2) + 1}. `;
                moveStr += `${m} `;
            });
            pgnContent = moveStr.trim();
        }

        const blob = new Blob([pgnContent], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${currentBotId}_match_${Date.now()}.pgn`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    });

    // Vorher Inline-onchange im HTML (verhinderte eine CSP ohne 'unsafe-inline').
    const botSelect = document.getElementById('bot-select');
    if (botSelect) botSelect.addEventListener('change', () => changeBot({ restoreState: false }));
    ['time-select', 'inc-select'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateTimeSettings);
    });

    // =====================================================================
    // ADMIN-PANEL (nur lokaler Testhelfer)
    // =====================================================================
    function initAdminPanel() {
        const panel = DU.el('div', { id: 'admin-test-panel' });
        panel.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#181825;border:2px solid #f1c40f;' +
            'border-radius:10px;padding:12px;z-index:9999;color:#fff;font-family:monospace;' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.8);display:flex;flex-direction:column;gap:8px;width:210px;';

        const title = DU.el('div', null, '🛠️ ADMIN BOT-TESTER');
        title.style.cssText = 'font-weight:bold;color:#f1c40f;font-size:13px;text-align:center;';
        panel.appendChild(title);

        const label = DU.el('label', { for: 'tester-elo-select' }, 'Gegner Stärke:');
        label.style.cssText = 'font-size:11px;color:#aaa;';
        panel.appendChild(label);

        const select = DU.el('select', { id: 'tester-elo-select' });
        select.style.cssText = 'background:#313244;color:#fff;border:1px solid #555;padding:4px;border-radius:4px;font-family:monospace;';
        [['1200', '1200 ELO (Anfänger)'], ['1600', '1600 ELO (Mittel)'], ['2000', '2000 ELO (Stark)'],
         ['2300', '2300 ELO (Profi)'], ['2800', '2800 ELO (Max Engine)']].forEach(([v, t]) => {
            const o = DU.el('option', { value: v }, t);
            if (v === '2000') o.selected = true;
            select.appendChild(o);
        });
        panel.appendChild(select);

        const btn = DU.el('button', { type: 'button', id: 'btn-toggle-autoplay' }, '▶ Auto-Play Starten');
        btn.style.cssText = 'background:#27ae60;color:#fff;border:none;padding:8px;border-radius:4px;cursor:pointer;font-weight:bold;font-family:monospace;';
        panel.appendChild(btn);

        const status = DU.el('div', { id: 'admin-status' }, 'Status: Inaktiv');
        status.style.cssText = 'font-size:10px;color:#a6adc8;text-align:center;';
        panel.appendChild(status);

        document.body.appendChild(panel);

        try {
            const created = createEngineWorker();
            testerStockfish = created.worker;
            testerStockfishUrl = created.url;
            testerStockfish.postMessage('uci');
            testerStockfish.onmessage = (e) => {
                const msg = typeof e.data === 'string' ? e.data : '';
                if (!msg.startsWith('bestmove')) return;
                const moveStr = msg.split(' ')[1];
                if (moveStr && autoPlayActive && chess.turn() === playerColor && !isGameOver) {
                    makeTesterMove(moveStr);
                }
            };
        } catch (e) { console.error('Tester Stockfish init failed', e); }

        btn.addEventListener('click', () => {
            autoPlayActive = !autoPlayActive;
            if (autoPlayActive) {
                btn.textContent = '⏸ Auto-Play Stoppen';
                btn.style.background = '#e74c3c';
                status.textContent = 'Status: 🟢 Läuft...';
                testerElo = parseInt(select.value, 10);

                let testerSkill = 10;
                if (testerElo <= 1200) { testerSkill = 0; testerDepth = 2; }
                else if (testerElo <= 1600) { testerSkill = 4; testerDepth = 4; }
                else if (testerElo <= 2000) { testerSkill = 9; testerDepth = 8; }
                else if (testerElo <= 2300) { testerSkill = 14; testerDepth = 12; }
                else { testerSkill = 20; testerDepth = null; }

                if (testerStockfish) {
                    testerStockfish.postMessage(`setoption name Skill Level value ${testerSkill}`);
                    testerStockfish.postMessage('setoption name UCI_LimitStrength value true');
                    testerStockfish.postMessage(`setoption name UCI_Elo value ${testerElo}`);
                }

                if (isGameOver || chess.game_over()) restartGame();
                else if (chess.turn() === playerColor) triggerTesterTurn();
            } else {
                btn.textContent = '▶ Auto-Play Starten';
                btn.style.background = '#27ae60';
                status.textContent = 'Status: Inaktiv';
            }
        });
    }

    function triggerTesterTurn() {
        if (!autoPlayActive || chess.turn() !== playerColor || isGameOver || chess.game_over()) return;
        if (!testerStockfish) return;
        testerStockfish.postMessage(`position fen ${chess.fen()}`);
        if (testerDepth) testerStockfish.postMessage(`go depth ${testerDepth}`);
        else testerStockfish.postMessage('go movetime 400');
    }

    function makeTesterMove(moveStr) {
        if (!autoPlayActive || isGameOver) return;
        const move = chess.move({
            from: moveStr.substring(0, 2),
            to: moveStr.substring(2, 4),
            promotion: moveStr[4] || 'q'
        });
        if (!move) return;

        if (!gameStarted) { gameStarted = true; startClock(); }
        if (!isZenMode) clocks[playerColor] += incrementSeconds;
        renderBoard();
        renderClocks();
        saveBotState(true);

        if (checkGameOver()) return;
        scheduleBotTurn(300);
    }

    // =====================================================================
    // INITIALISIERUNG
    // =====================================================================
    createBoardDOM();
    updateTimeSettings();
    if (window.Sfx) window.Sfx.mountFloatingToggle();
    if (isAdmin) initAdminPanel();

    // Erst den gespeicherten Bot ermitteln, DANN dessen Config laden —
    // sonst zeigte die UI Bot B und gespielt wurde unter Bot A.
    const savedBotId = peekSavedBotId();
    if (savedBotId && botSelect) {
        const exists = Array.from(botSelect.options).some(o => o.value === savedBotId);
        if (exists) botSelect.value = savedBotId;
    }
    changeBot({ restoreState: true });
})();
