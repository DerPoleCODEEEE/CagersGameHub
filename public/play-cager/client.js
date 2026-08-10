const chess = new Chess();
let cagerBook = null;
let cagerConfig = null;

// RULES MODAL HANDLERS
const rulesModal = document.getElementById('rules-modal');
const btnShowRules = document.getElementById('btn-show-rules');
const closeRulesBtn = document.getElementById('close-rules-btn');

if (btnShowRules) {
    btnShowRules.onclick = () => rulesModal.style.display = 'flex';
}
if (closeRulesBtn) {
    closeRulesBtn.onclick = () => rulesModal.style.display = 'none';
}
if (rulesModal) {
    rulesModal.onclick = (e) => { if (e.target === rulesModal) rulesModal.style.display = 'none'; };
}

// DYNAMISCHES BOT-STATE
let currentBotId = 'cager';
let currentBotName = 'TheCager';
let currentBotColor = '9b59b6';

// PLAYER & BOT COLOR STATE
let playerColor = 'w';
let botColor = 'b';

// PSYCHOLOGY & GAME STATE
let tiltScore = 0;
let lastEval = 0;
let evalBeforeBotMove = 0;
let lastExpectedOpponentReply = null;
let isGameOver = false;

// CLOCK & TIME CONTROL STATE
let isZenMode = false;
let timeControlSeconds = 180;
let incrementSeconds = 2;
let clocks = { w: 180, b: 180 };
let clockTimer = null;
let gameStarted = false;

// TWITCH DATA & ADMIN CHECK
const twitchName = localStorage.getItem('cager_twitch_name');
const twitchPfp = localStorage.getItem('cager_twitch_pfp') || '';
const isAdmin = (twitchName && twitchName.trim().toLowerCase() === 'schachspielenderpole');

// ADMIN AUTO-PLAY STATE
let autoPlayActive = false;
let testerStockfish = null;
let testerElo = 2000;
let testerDepth = 8;

if (twitchName) document.getElementById('my-name').innerText = twitchName;
if (twitchPfp) {
    const pfp = document.getElementById('my-pfp');
    pfp.src = twitchPfp;
    pfp.classList.remove('hidden');
}

function getSelectedPlayerColor() {
    const select = document.getElementById('color-select');
    if (!select) return 'w';
    const val = select.value;
    if (val === 'random') {
        return Math.random() < 0.5 ? 'w' : 'b';
    }
    return val;
}

// BOT LOCAL SAVE / LOAD HELPERS
function saveBotState() {
    if (!gameStarted || isGameOver) return;
    try {
        const state = {
            fen: chess.fen(),
            clocks,
            currentBotId,
            playerColor,
            botColor,
            isZenMode,
            timeControlSeconds,
            incrementSeconds,
            gameStarted,
            isGameOver,
            chatHistory: document.getElementById('chat-messages').innerHTML
        };
        localStorage.setItem('cager_bot_save_state', JSON.stringify(state));
    } catch (e) {}
}

function loadBotState() {
    try {
        const raw = localStorage.getItem('cager_bot_save_state');
        if (!raw) return false;
        const saved = JSON.parse(raw);
        if (!saved || !saved.fen || saved.isGameOver) return false;

        chess.load(saved.fen);
        clocks = saved.clocks || clocks;
        currentBotId = saved.currentBotId || currentBotId;
        playerColor = saved.playerColor || 'w';
        botColor = saved.botColor || (playerColor === 'w' ? 'b' : 'w');
        isZenMode = !!saved.isZenMode;
        timeControlSeconds = saved.timeControlSeconds || 180;
        incrementSeconds = saved.incrementSeconds || 2;
        gameStarted = !!saved.gameStarted;
        isGameOver = !!saved.isGameOver;

        const boardEl = document.getElementById('board');
        if (boardEl) {
            boardEl.classList.toggle('flipped', playerColor === 'b');
        }

        const chatBox = document.getElementById('chat-messages');
        if (chatBox && saved.chatHistory) {
            chatBox.innerHTML = saved.chatHistory;
        }

        const botSelect = document.getElementById('bot-select');
        if (botSelect) botSelect.value = currentBotId;

        const colorSelect = document.getElementById('color-select');
        if (colorSelect) colorSelect.value = playerColor;

        const timeSelect = document.getElementById('time-select');
        if (timeSelect) timeSelect.value = isZenMode ? 'zen' : timeControlSeconds.toString();

        const incSelect = document.getElementById('inc-select');
        if (incSelect) incSelect.value = incrementSeconds.toString();

        updateTimeSettings();
        renderBoard();
        renderClocks();

        if (gameStarted && !isGameOver) {
            startClock();
        }
        return true;
    } catch (e) {
        return false;
    }
}

function clearBotSaveState() {
    localStorage.removeItem('cager_bot_save_state');
}

// WISSENSCHAFTLICHE MATHEMATIK (Win%)
function cpToWinPct(cp) {
    if (cp === undefined || cp === null) return 50.0;
    const cappedCp = Math.max(-4000, Math.min(4000, cp));
    return 50 + 50 * ((2 / (1 + Math.exp(-0.00368208 * cappedCp))) - 1);
}

// STATS SPEICHERN HELPER
function saveGameResult(mode, result) {
    fetch('/api/stats/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, result, botId: currentBotId })
    })
    .then(res => res.json())
    .then(data => console.log('✅ Stats in DB aktualisiert:', data))
    .catch(err => console.error('❌ Fehler beim Speichern der Stats:', err));
}

function getSquareColor(squareStr) {
    if (!squareStr || squareStr.length < 2) return 'light';
    const file = squareStr.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(squareStr[1], 10);
    return (file + rank) % 2 === 0 ? 'dark' : 'light';
}

function isEndgamePhase(chessObj) {
    let queens = 0;
    let nonPawnMaterial = 0;
    const weights = { n: 3, b: 3, r: 5, q: 9 };
    
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = String.fromCharCode('a'.charCodeAt(0) + c) + (8 - r);
            const piece = chessObj.get(square);
            if (piece) {
                if (piece.type === 'q') queens++;
                if (weights[piece.type]) nonPawnMaterial += weights[piece.type];
            }
        }
    }
    return queens === 0 || nonPawnMaterial <= 25;
}

function getCurrentPhase(chessObj) {
    const moveCount = chessObj.history().length;
    if (isEndgamePhase(chessObj)) return 'endgame';
    if (moveCount <= 12) return 'opening';
    return 'middlegame';
}

// 7 AUFGEFÄCHERTE SCHACHPRINZIPIEN MIT WIN% KORRIDOR
function applySmartPrinciples(candidateMoves, chessObj, profile) {
    if (!candidateMoves || candidateMoves.length === 0) return candidateMoves;

    const bestWinPct = cpToWinPct(candidateMoves[0].stockfishEval);
    const phase = getCurrentPhase(chessObj);
    const pAdh = profile.principlesAdherence || {};

    return candidateMoves.map(cand => {
        const candWinPct = cpToWinPct(cand.stockfishEval);
        const winLoss = Math.max(0, bestWinPct - candWinPct);

        if (winLoss > 5.0) {
            return { ...cand, principlePenalty: 0 };
        }

        let penalty = 0;
        const inCheck = chessObj.in_check();
        const temp = new Chess(chessObj.fen());
        const m = temp.move({ from: cand.from, to: cand.to, promotion: cand.promotion });

        if (m) {
            const fileIdx = m.to.charCodeAt(0) - 'a'.charCodeAt(0);
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
                const turn = chessObj.turn();
                
                const isBackRank = (turn === 'w' && rankIdx === 0) || (turn === 'b' && rankIdx === 7);
                if (['n', 'b'].includes(m.piece) && isBackRank && !m.captured && !inCheck) {
                    penalty += 70 * ((midP.backrankAvoidance || 90) / 100);
                }
                if (m.piece === 'p' && !m.captured && fileIdx >= 5) {
                    const kingSq = turn === 'w' ? 'g1' : 'g8';
                    if (chessObj.get(kingSq) && chessObj.get(kingSq).type === 'k') {
                        penalty += 80 * ((midP.kingShieldSafety || 85) / 100);
                    }
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

        return { ...cand, principlePenalty: penalty };
    });
}

// CAGER STOCKFISH WEB WORKER
let stockfish;
try {
    const workerBlob = new Blob([
        `importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');`
    ], { type: 'application/javascript' });
    stockfish = new Worker(URL.createObjectURL(workerBlob));
} catch (e) {
    console.error("Stockfish initialization failed:", e);
}

let selectedSquare = null;
let validMoves = [];

let currentSearchDepth = 0;
let pvMapAtHighestDepth = {};

function getPieceImgUrl(piece) {
    if (!piece) return '';
    const color = piece.color;
    const type = piece.type.toUpperCase();
    return `https://chessboardjs.com/img/chesspieces/wikipedia/${color}${type}.png`;
}

const CAGER_QUOTES = {
    start: [
        "Howdy! Welcome back to the channel, let's document the climb!",
        "Alright, let's see if we can handle this position today.",
        "Let's go into a Queen's Gambit, keep it clean, classical and solid.",
        "Don't mind me, just providing some unedited commentary as I play!"
    ],
    cager_capture: [
        { text: "And bye-bye! I'll take that pawn with tempo!", piece: 'p' },
        { text: "Nom nom, free material! That piece was standing in my way anyway.", piece: 'not_p' },
        { text: "BANG! We win those, baby! Absolute cinema!" },
        { text: "Sniped! Clean tactical blow right there." }
    ],
    player_capture: [
        { text: "Oof, I did NOT see that check! That is no bueno..." },
        { text: "Ouch! I really don't like where my position is going now." },
        { text: "Oh man, I am getting put in the blender right now..." }
    ],
    cager_check: [
        { text: "Check! Watch your king safety, things are getting spicy!" },
        { text: "Check! Where is your king going now?" }
    ],
    cager_win: [
        "BANG! WE WIN THOSE, BABY! What an absolute comeback!",
        "GG WP! Oh my god, what a battle! That was absolute cinema!"
    ],
    player_win: [
        "GG WP! Man, I got completely outplayed in that endgame!",
        "Respect, great game! You had me completely stuck in the blender."
    ],
    cager_resign: [
        "No way out of this position for me... GG, you had me completely outplayed!",
        "I yield! I am so bad at chess today, GG WP!"
    ]
};

function getRandomQuote(cat, context = {}) {
    const list = CAGER_QUOTES[cat];
    if (!list || list.length === 0) return "GG!";

    const validQuotes = list.filter(q => {
        if (typeof q === 'string') return true;
        if (q.color && context.color && q.color !== context.color) return false;
        if (q.piece && context.piece) {
            if (q.piece === 'p' && context.piece !== 'p') return false;
            if (q.piece === 'not_p' && context.piece === 'p') return false;
        }
        return true;
    });

    const chosen = validQuotes[Math.floor(Math.random() * validQuotes.length)];
    return typeof chosen === 'string' ? chosen : chosen.text;
}

window.changeBot = function() {
    const selectEl = document.getElementById('bot-select');
    if (!selectEl) return;
    
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
    
    if(botNameEl) botNameEl.innerText = `${currentBotName} (BOT)`;
    if(chatWelcomeEl) chatWelcomeEl.innerText = `${currentBotName}:`;
    if(botAvatarEl) botAvatarEl.src = fallbackAvatar;

    const chessComUsername = currentBotName.replace(/\s+/g, '').toLowerCase();
    
    fetch(`https://api.chess.com/pub/player/${chessComUsername}`)
        .then(res => res.json())
        .then(data => {
            if (data && data.avatar) {
                if (botAvatarEl) botAvatarEl.src = data.avatar;
            }
        })
        .catch(err => console.log("Kein Chess.com Bild gefunden, nutze Fallback."));

    Promise.all([
        fetch(`${currentBotId}-config.json`).then(r => r.json()).catch(() => null),
        fetch(`${currentBotId}-book.json`).then(r => r.json()).catch(() => null)
    ]).then(([configData, bookData]) => {
        if (configData) {
            cagerConfig = configData;
            const elo = configData.targetElo || 1500;
            const eloEl = document.getElementById('bot-elo');
            if(eloEl) eloEl.innerText = `${elo} ELO`;
            
            if (stockfish) {
                let skill = Math.round((elo - 1000) / (3000 - 1000) * 20);
                skill = Math.max(0, Math.min(20, skill));
                
                stockfish.postMessage(`setoption name UCI_LimitStrength value true`);
                stockfish.postMessage(`setoption name UCI_Elo value ${elo}`);
                stockfish.postMessage(`setoption name Skill Level value ${skill}`);
            }
        } else {
            cagerConfig = {};
            const eloEl = document.getElementById('bot-elo');
            if(eloEl) eloEl.innerText = `??? ELO`;
        }
        
        if (bookData) {
            cagerBook = bookData.book;
        } else {
            cagerBook = {};
        }

        if (!loadBotState()) {
            const restartBtn = document.getElementById('btn-restart');
            if (restartBtn) restartBtn.click();
        }
    });
};

if (stockfish) {
    stockfish.postMessage('uci');
    stockfish.postMessage('setoption name MultiPV value 5');

    stockfish.onmessage = (e) => {
        const msg = e.data;
        if (msg.includes('multipv') && msg.includes('pv')) {
            parseStockfishPvLine(msg);
        }
        if (msg.startsWith('bestmove')) {
            processSoftmaxDecisionMatrix();
        }
    };
}

function evaluatePvComplexity(fen, pvMoves) {
    const temp = new Chess(fen);
    let sacrifices = 0;
    let quietMoves = 0;
    let nonCheckMoves = 0;
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

    for (let i = 0; i < pvMoves.length; i++) {
        const uci = pvMoves[i];
        if (uci.length < 4) break;

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
    const isSimple = (sacrifices === 0) && (quietMoves === 0) && (nonCheckMoves <= 1);
    return { isSimple, sacrifices, quietMoves };
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

    if (pvIndex !== -1 && pvIndex + 1 < parts.length && multiPvIdx !== -1) {
        const multiPvRank = parseInt(parts[multiPvIdx + 1], 10);
        const pvMoves = parts.slice(pvIndex + 1);
        const moveStr = pvMoves[0];
        const opponentReply = pvMoves.length > 1 ? pvMoves[1] : null;
        let score = 0;

        if (scoreIndex !== -1 && scoreIndex + 1 < parts.length) {
            score = parseInt(parts[scoreIndex + 1], 10);
        } else if (mateIndex !== -1 && mateIndex + 1 < parts.length) {
            const mateIn = parseInt(parts[mateIndex + 1], 10);
            const absMate = Math.abs(mateIn);

            if (mateIn > 0) {
                if (absMate <= 3) score = 20000 - absMate * 100;
                else if (absMate >= 4 && absMate <= 6) {
                    const complexity = evaluatePvComplexity(chess.fen(), pvMoves);
                    score = complexity.isSimple ? (19000 - absMate * 100) : (900 - absMate * 50);
                } else {
                    score = Math.max(700, 1200 - absMate * 40);
                }
            } else {
                score = -20000 + absMate * 100;
            }
        }

        pvMapAtHighestDepth[multiPvRank] = {
            moveStr: moveStr,
            opponentReply: opponentReply,
            stockfishEval: score,
            from: moveStr.substring(0, 2),
            to: moveStr.substring(2, 4),
            promotion: moveStr[4] || 'q'
        };
    }
}

function updateTimeSettings() {
    const val = document.getElementById('time-select').value;
    const incLabel = document.getElementById('inc-label');

    if (val === 'zen') {
        isZenMode = true;
        if (incLabel) incLabel.style.display = 'none';
        document.getElementById('bot-clock').innerText = '∞';
        document.getElementById('player-clock').innerText = '∞';
    } else {
        isZenMode = false;
        if (incLabel) incLabel.style.display = 'flex';
        timeControlSeconds = parseInt(val, 10);
        incrementSeconds = parseInt(document.getElementById('inc-select').value, 10);
        if (!gameStarted) {
            clocks = { w: timeControlSeconds, b: timeControlSeconds };
        }
        renderClocks();
    }
}

function startClock() {
    if (isZenMode || clockTimer || isGameOver) return;
    clockTimer = setInterval(() => {
        if (chess.game_over() || isGameOver) {
            clearInterval(clockTimer);
            clockTimer = null;
            return;
        }
        const turn = chess.turn();
        clocks[turn]--;
        renderClocks();
        saveBotState();

        if (clocks[turn] <= 0) {
            clearInterval(clockTimer);
            clockTimer = null;
            isGameOver = true;
            clearBotSaveState();
            const isPlayerLoss = (turn === playerColor);
            saveGameResult('bot', isPlayerLoss ? 'loss' : 'win');
            const winner = isPlayerLoss ? `${currentBotName} (BOT)` : 'You';
            alert(`Time's up! ${winner} won on time!`);
        }
    }, 1000);
}

function renderClocks() {
    if (isZenMode) return;
    const botBox = document.getElementById('bot-clock');
    const playerBox = document.getElementById('player-clock');

    botBox.innerText = formatTime(clocks[botColor]);
    playerBox.innerText = formatTime(clocks[playerColor]);

    botBox.className = 'clock-box' + (chess.turn() === botColor ? ' active' : '') + (clocks[botColor] <= 15 ? ' danger' : '');
    playerBox.className = 'clock-box' + (chess.turn() === playerColor ? ' active' : '') + (clocks[playerColor] <= 15 ? ' danger' : '');
}

function formatTime(sec) {
    if (sec <= 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

// ENTSCHEIDUNGSMATRIX AUF BASIS VON WIN%
function processSoftmaxDecisionMatrix() {
    const candidates = Object.values(pvMapAtHighestDepth).sort((a, b) => b.stockfishEval - a.stockfishEval);
    pvMapAtHighestDepth = {};
    currentSearchDepth = 0;

    if (candidates.length === 0 || isGameOver) return;

    const currentTurn = chess.turn();
    const colorKey = currentTurn === 'w' ? 'white' : 'black';
    const profile = (cagerConfig && cagerConfig[colorKey]) ? cagerConfig[colorKey] : (cagerConfig || {});
    const psycho = (cagerConfig && cagerConfig.psychologyEngine) ? cagerConfig.psychologyEngine : (cagerConfig || {});
    
    const errorRates = profile.errorRates || { inaccuraciesPercent: 12, mistakesPercent: 5, blundersPercent: 1 };

    const phase = getCurrentPhase(chess);
    const isEndgame = phase === 'endgame';

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
        if (lastM.color !== currentTurn) {
            lastPlayerMoveUCI = lastM.from + lastM.to + (lastM.promotion || '');
        }
    }

    const evalDelta = evalBeforeBotMove - bestMoveEval;
    const opponentFoundPunish = lastExpectedOpponentReply && (lastPlayerMoveUCI === lastExpectedOpponentReply);

    if (evalDelta > 150 && opponentFoundPunish) {
        tiltScore = (psycho.tiltFactorAlpha || 0.20) * tiltScore + (1 - (psycho.tiltFactorAlpha || 0.20)) * (evalDelta * 0.05);
    } else {
        tiltScore *= (psycho.tiltFactorAlpha || 0.20);
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
            if (winLoss <= 15.0 && (Math.random() * 100 < errorRates.mistakesPercent)) {
                return true;
            }

            const isAggressiveIntent = cand.moveStr.includes('+') || ['g4','g5','h4','h5','f4','f5'].includes(cand.to);
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

    const scoredMoves = candidatesWithPrinciples.map((cand, idx) => {
        let cagerScore = cand.stockfishEval - (cand.principlePenalty || 0);
        const tempBoard = new Chess(chess.fen());
        const moveDetails = tempBoard.move({ from: cand.from, to: cand.to, promotion: cand.promotion });
        
        const winLoss = Math.max(0, bestWinPct - cpToWinPct(cand.stockfishEval));
        const isPositionallySound = winLoss <= 4.0;

        if (triggerTunnelVision && idx >= 2) {
            cagerScore += 180; 
        }

        if (moveDetails) {
            if (!isBotWinningMassively) {
                if (moveDetails.san.includes('+') || ['g4','g5','h4','h5','f4','f5'].includes(cand.to)) {
                    if (isPositionallySound) cagerScore += (kingAttackBiasVal / 100) * 80;
                }
                
                if (moveDetails.captured) {
                    if (moveDetails.captured === 'q') cagerScore -= (queenTradeReluctVal / 100) * 180;
                    else if (moveDetails.piece === moveDetails.captured) cagerScore -= ((profile.tradeAvoidanceIndex || 35) / 100) * 50;

                    if (psycho.panicTradeTendency && isLowClockPanic) cagerScore += 90;
                }

                if (moveDetails.piece === 'p' && !moveDetails.captured) {
                    const fileIdx = moveDetails.to.charCodeAt(0) - 'a'.charCodeAt(0);
                    const isFlank = [0, 1, 6, 7].includes(fileIdx);

                    if (isPositionallySound) {
                        if (isFlank) cagerScore += (flankAgg - 50) * 1.2;
                        else cagerScore += (50 - flankAgg) * 1.2;
                    }
                }
            } else {
                if (moveDetails.captured) cagerScore += 60;
                if (moveDetails.san.includes('+')) cagerScore += 40;
            }
        }
        return { ...cand, cagerScore };
    });

    let chosenMove = scoredMoves[0];

    if (isDirectShortMate) {
        chosenMove = scoredMoves.reduce((best, m) => m.cagerScore > best.cagerScore ? m : best, scoredMoves[0]);
    } else {
        const lambda = psycho.timePressureLambda || 0.045;
        const timePanicTerm = isZenMode ? 0 : Math.exp(-lambda * botRemainingTime);
        const minTiltImpact = Math.min(0.03, tiltScore / 5000);
        
        const inaccMultiplier = 1 + ((errorRates.inaccuraciesPercent || 10) / 100);
        const effectiveTemp = (psycho.softmaxTemperature || 0.50) * inaccMultiplier * (1 + minTiltImpact + (timePanicTerm * 1.2));
        
        const maxScore = Math.max(...scoredMoves.map(m => m.cagerScore));
        const expScores = scoredMoves.map(m => Math.exp((m.cagerScore - maxScore) / (effectiveTemp * 40)));
        const sumExp = expScores.reduce((a, b) => a + b, 0);
        const probabilities = expScores.map(e => e / sumExp);

        let rand = Math.random();
        let cumulative = 0;

        for (let i = 0; i < scoredMoves.length; i++) {
            cumulative += probabilities[i];
            if (rand <= cumulative) {
                chosenMove = scoredMoves[i];
                break;
            }
        }
    }

    evalBeforeBotMove = bestMoveEval;
    lastExpectedOpponentReply = chosenMove.opponentReply || null;

    let baseThinkTime = isZenMode ? 400 : Math.max(150, Math.min(800, clocks[currentTurn] * 20));
    if (isComplexPosition && !isLowClockPanic) {
        baseThinkTime += 600; 
    }

    setTimeout(() => makeBotMove(chosenMove), baseThinkTime);
}

function triggerBotTurn() {
    if (chess.game_over() || isGameOver) return;

    const history = chess.history();
    let stateKey = 'start';
    if (history.length > 0) stateKey = 'start_' + history.join('_');

    const currentTurn = chess.turn();
    const colorKey = currentTurn === 'w' ? 'white' : 'black';
    const profile = (cagerConfig && cagerConfig[colorKey]) ? cagerConfig[colorKey] : (cagerConfig || {});
    
    const bookLoyalty = profile.openingBookLoyalty !== undefined ? profile.openingBookLoyalty : 95;

    if ((Math.random() * 100) <= bookLoyalty && cagerBook && cagerBook[stateKey]) {
        const moves = cagerBook[stateKey];
        const entries = Object.entries(moves); 

        if (entries.length > 0) {
            entries.sort((a, b) => b[1] - a[1]);
            const bestMoveEntry = entries[0]; 
            const moveSan = bestMoveEntry[0];
            const moveCount = bestMoveEntry[1];

            if (moveCount >= 2) {
                const m = chess.move(moveSan, { slate: true });
                if (m) {
                    console.log(`📖 Playing Main Book Move: ${moveSan} (Played ${moveCount}x)`);
                    makeBotMove(m);
                    return;
                }
            } else {
                console.log(`⚠️ Book move '${moveSan}' played only 1x. Letting engine calculate.`);
            }
        }
    }

    currentSearchDepth = 0;
    pvMapAtHighestDepth = {};
    if (stockfish) {
        stockfish.postMessage(`position fen ${chess.fen()}`);
        stockfish.postMessage('go movetime 800'); 
    }
}

function makeBotMove(moveObj) {
    if (isGameOver) return;

    let move = moveObj;
    if (typeof moveObj === 'object' && !moveObj.color) {
        move = chess.move(moveObj);
    }

    if (!isZenMode && gameStarted) {
        clocks[botColor] += incrementSeconds;
    }

    renderBoard();
    renderClocks();
    saveBotState();

    if (move) {
        const toColor = getSquareColor(move.to);
        const capturedPiece = move.captured;

        if (move.captured) {
            addChatMessage(currentBotName, getRandomQuote('cager_capture', { color: toColor, piece: capturedPiece }));
        } else if (chess.in_check()) {
            addChatMessage(currentBotName, getRandomQuote('cager_check', { color: toColor }));
        }
    }

    if (checkGameOver()) return;

    if (autoPlayActive && chess.turn() === playerColor && isAdmin) {
        setTimeout(triggerTesterTurn, 300);
    }
}

function createBoardDOM() {
    const boardEl = document.getElementById('board');
    boardEl.innerHTML = '';
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = document.createElement('div');
            square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
            square.dataset.r = r;
            square.dataset.c = c;
            square.onclick = () => handleSquareClick(r, c);
            boardEl.appendChild(square);
        }
    }
}

function renderBoard() {
    const boardEl = document.getElementById('board');
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = boardEl.querySelector(`[data-r="${r}"][data-c="${c}"]`);
            if (!square) continue;
            
            square.innerHTML = '';
            square.classList.remove('selected', 'valid-move', 'capture-move');

            const algebraic = String.fromCharCode('a'.charCodeAt(0) + c) + (8 - r);
            const piece = chess.get(algebraic);

            if (selectedSquare === algebraic) square.classList.add('selected');

            const moveInfo = validMoves.find(m => m.to === algebraic);
            if (moveInfo) {
                if (moveInfo.captured) square.classList.add('capture-move');
                else square.classList.add('valid-move');
            }

            if (piece) {
                const img = document.createElement('img');
                img.className = 'piece';
                img.src = getPieceImgUrl(piece);
                square.appendChild(img);
            }
        }
    }
}

function handleSquareClick(r, c) {
    if (chess.turn() !== playerColor || chess.game_over() || isGameOver || autoPlayActive) return;

    const square = String.fromCharCode('a'.charCodeAt(0) + c) + (8 - r);
    const piece = chess.get(square);

    if (selectedSquare) {
        const move = chess.move({ from: selectedSquare, to: square, promotion: 'q' });
        if (move) {
            if (!gameStarted) {
                gameStarted = true;
                startClock();
            }

            if (!isZenMode) clocks[playerColor] += incrementSeconds;

            selectedSquare = null;
            validMoves = [];
            renderBoard();
            renderClocks();
            saveBotState();

            if (move.captured) addChatMessage('You', getRandomQuote('player_capture'));
            if (checkGameOver()) return;

            setTimeout(triggerBotTurn, 400);
            return;
        }
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

function addChatMessage(sender, text) {
    const box = document.getElementById('chat-messages');
    const msg = document.createElement('div');
    msg.className = `chat-msg ${sender === currentBotName ? 'bot' : ''}`;
    msg.innerHTML = `<b>${sender}:</b> ${text}`;
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
    saveBotState();
}

function checkGameOver() {
    if (chess.in_checkmate()) {
        isGameOver = true;
        if (clockTimer) clearInterval(clockTimer);
        clearBotSaveState();
        
        const isPlayerWin = (chess.turn() === botColor);
        saveGameResult('bot', isPlayerWin ? 'win' : 'loss');
        
        const winner = isPlayerWin ? 'You' : `${currentBotName} (BOT)`;
        addChatMessage(currentBotName, isPlayerWin ? getRandomQuote('player_win') : getRandomQuote('cager_win'));
        
        if (autoPlayActive && isAdmin) {
            setTimeout(() => { if (autoPlayActive) document.getElementById('btn-restart').click(); }, 3000);
        } else {
            alert(`Checkmate! ${winner} wins!`);
        }
        return true;
    }
    
    if (chess.in_draw() || chess.in_stalemate() || chess.in_threefold_repetition()) {
        isGameOver = true;
        if (clockTimer) clearInterval(clockTimer);
        clearBotSaveState();
        saveGameResult('bot', 'draw');
        addChatMessage(currentBotName, "GG! A draw. Fair enough.");
        
        if (autoPlayActive && isAdmin) {
            setTimeout(() => { if (autoPlayActive) document.getElementById('btn-restart').click(); }, 3000);
        } else {
            alert("Draw! Game Over.");
        }
        return true;
    }
    return false;
}

document.getElementById('btn-restart').onclick = () => {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    gameStarted = false;
    isGameOver = false;
    clearBotSaveState();

    playerColor = getSelectedPlayerColor();
    botColor = playerColor === 'w' ? 'b' : 'w';

    const boardEl = document.getElementById('board');
    if (boardEl) {
        boardEl.classList.toggle('flipped', playerColor === 'b');
    }

    chess.reset();
    selectedSquare = null;
    validMoves = [];
    tiltScore = 0;
    evalBeforeBotMove = 0;
    lastExpectedOpponentReply = null;
    updateTimeSettings();
    renderBoard();
    addChatMessage(currentBotName, getRandomQuote('start'));

    if (playerColor === 'b') {
        gameStarted = true;
        startClock();
        setTimeout(triggerBotTurn, 500);
    } else if (autoPlayActive && isAdmin) {
        setTimeout(triggerTesterTurn, 500);
    }
};

document.getElementById('btn-undo').onclick = () => {
    if (isGameOver) return;
    chess.undo();
    chess.undo();
    renderBoard();
    renderClocks();
    saveBotState();
};

document.getElementById('btn-resign').onclick = () => {
    if (isGameOver || chess.game_over()) return;
    if (confirm('Are you sure you want to resign?')) {
        isGameOver = true;
        if (clockTimer) {
            clearInterval(clockTimer);
            clockTimer = null;
        }
        clearBotSaveState();
        saveGameResult('bot', 'loss');
        addChatMessage(currentBotName, getRandomQuote('cager_resign'));
        alert(`You resigned. ${currentBotName} (BOT) wins!`);
    }
};

document.getElementById('btn-pgn').onclick = () => {
    const moves = chess.history();
    if (moves.length === 0) {
        alert('No moves played yet!');
        return;
    }
    chess.header('Event', `${currentBotName} Bot Match`);
    chess.header('Site', 'Chess Hub');
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
        pgnContent = `[Event "${currentBotName} Bot Match"]\n[White "${playerColor === 'w' ? (twitchName || 'You') : `${currentBotName} (BOT)`}"]\n[Black "${playerColor === 'b' ? (twitchName || 'You') : `${currentBotName} (BOT)`}"]\n\n${moveStr.trim()}`;
    }

    const blob = new Blob([pgnContent], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${currentBotId}_match_${Date.now()}.pgn`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
};

if (isAdmin) initAdminPanel();

function initAdminPanel() {
    const panel = document.createElement('div');
    panel.id = 'admin-test-panel';
    panel.style.cssText = `
        position: fixed; bottom: 20px; right: 20px;
        background: #181825; border: 2px solid #f1c40f;
        border-radius: 10px; padding: 12px; z-index: 9999;
        color: #fff; font-family: monospace;
        box-shadow: 0 4px 20px rgba(0,0,0,0.8);
        display: flex; flex-direction: column; gap: 8px; width: 210px;
    `;
    panel.innerHTML = `
        <div style="font-weight:bold; color:#f1c40f; font-size:13px; text-align:center;">🛠️ ADMIN BOT-TESTER</div>
        <label style="font-size:11px; color:#aaa;">Gegner Stärke (Weiß):</label>
        <select id="tester-elo-select" style="background:#313244; color:#fff; border:1px solid #555; padding:4px; border-radius:4px; font-family:monospace;">
            <option value="1200">1200 ELO (Anfänger)</option>
            <option value="1600">1600 ELO (Mittel)</option>
            <option value="2000" selected>2000 ELO (Stark)</option>
            <option value="2300">2300 ELO (Profi)</option>
            <option value="2800">2800 ELO (Max Engine)</option>
        </select>
        <button id="btn-toggle-autoplay" style="background:#27ae60; color:#fff; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold; font-family:monospace;">
            ▶ Auto-Play Starten
        </button>
        <div id="admin-status" style="font-size:10px; color:#a6adc8; text-align:center;">Status: Inaktiv</div>
    `;
    document.body.appendChild(panel);

    try {
        const workerBlob = new Blob([
            `importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');`
        ], { type: 'application/javascript' });
        testerStockfish = new Worker(URL.createObjectURL(workerBlob));
        testerStockfish.postMessage('uci');

        testerStockfish.onmessage = (e) => {
            const msg = e.data;
            if (msg.startsWith('bestmove')) {
                const parts = msg.split(' ');
                const moveStr = parts[1];
                if (moveStr && autoPlayActive && chess.turn() === playerColor && !isGameOver) {
                    makeTesterMove(moveStr);
                }
            }
        };
    } catch (e) { console.error("Tester Stockfish init failed", e); }

    document.getElementById('btn-toggle-autoplay').onclick = () => {
        autoPlayActive = !autoPlayActive;
        const btn = document.getElementById('btn-toggle-autoplay');
        const status = document.getElementById('admin-status');
        const eloSelect = document.getElementById('tester-elo-select');

        if (autoPlayActive) {
            btn.innerText = '⏸ Auto-Play Stoppen';
            btn.style.background = '#e74c3c';
            status.innerText = 'Status: 🟢 Läuft...';
            testerElo = parseInt(eloSelect.value, 10);
            
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

            if (isGameOver || chess.game_over()) document.getElementById('btn-restart').click();
            else if (chess.turn() === playerColor) triggerTesterTurn();
        } else {
            btn.innerText = '▶ Auto-Play Starten';
            btn.style.background = '#27ae60';
            status.innerText = 'Status: Inaktiv';
        }
    };
}

function triggerTesterTurn() {
    if (!autoPlayActive || chess.turn() !== playerColor || isGameOver || chess.game_over()) return;
    if (testerStockfish) {
        testerStockfish.postMessage(`position fen ${chess.fen()}`);
        if (testerDepth) testerStockfish.postMessage(`go depth ${testerDepth}`);
        else testerStockfish.postMessage('go movetime 400');
    }
}

function makeTesterMove(moveStr) {
    if (!autoPlayActive || isGameOver) return;
    const from = moveStr.substring(0, 2);
    const to = moveStr.substring(2, 4);
    const promotion = moveStr[4] || 'q';

    const move = chess.move({ from, to, promotion });
    if (move) {
        if (!gameStarted) { gameStarted = true; startClock(); }
        if (!isZenMode) clocks[playerColor] += incrementSeconds;
        renderBoard();
        renderClocks();
        saveBotState();

        if (checkGameOver()) return;
        setTimeout(triggerBotTurn, 300);
    }
}

// INITIALISIERUNG
createBoardDOM();
updateTimeSettings();

setTimeout(() => {
    if(window.changeBot) window.changeBot();
}, 200);
