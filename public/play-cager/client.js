const chess = new Chess();
let cagerBook = null;
let cagerConfig = null;

// STATS SPEICHERN HELPER
function saveGameResult(mode, result) { // result: 'win', 'loss', 'draw'
    fetch('/api/stats/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, result })
    })
    .then(res => res.json())
    .then(data => console.log('✅ Stats in DB aktualisiert:', data))
    .catch(err => console.error('❌ Fehler beim Speichern der Stats:', err));
}

// PSYCHOLOGY & GAME STATE
let tiltScore = 0;
let lastEval = 0;
let isGameOver = false;

// CLOCK & TIME CONTROL STATE
let isZenMode = false;
let timeControlSeconds = 180;
let incrementSeconds = 2;
let clocks = { w: 180, b: 180 };
let clockTimer = null;
let gameStarted = false;

// STOCKFISH WEB WORKER (CORS-SAFE BLOB PROXY)
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
let multiPvCandidates = [];

const twitchName = localStorage.getItem('cager_twitch_name');
const twitchPfp = localStorage.getItem('cager_twitch_pfp') || '';

if (twitchName) document.getElementById('my-name').innerText = twitchName;
if (twitchPfp) {
    const pfp = document.getElementById('my-pfp');
    pfp.src = twitchPfp;
    pfp.classList.remove('hidden');
}

// CHESSBOARD PIECE ASSETS
function getPieceImgUrl(piece) {
    if (!piece) return '';
    const color = piece.color;
    const type = piece.type.toUpperCase();
    return `https://chessboardjs.com/img/chesspieces/wikipedia/${color}${type}.png`;
}

const CAGER_QUOTES = {
    start: [
        "Let's go! Good luck & have fun!",
        "Show me what you got!",
        "Alright, let's see if you can handle the Cager style!",
        "Time for some speed chess! Game on!",
        "Welcome! May the best player win.",
        "Don't blink! Let me see your best moves!"
    ],
    cager_capture: [
        "And bye-bye! That piece is mine!",
        "Thanks for the gift!",
        "Nom nom, free material!",
        "I'll take that, thank you very much!",
        "You dropped something!",
        "Sniped! Clean tactical blow.",
        "That piece was standing in my way anyway!"
    ],
    player_capture: [
        "Ouch! Didn't see that coming...",
        "Nice capture, fair enough.",
        "Hey, that was my favorite piece!",
        "Oof, brutal vision from you!",
        "A temporary setback, no worries!",
        "Ouch! You're playing really sharp today."
    ],
    cager_check: [
        "Check! Where are you going?",
        "King in trouble!",
        "Check! Watch your king safety!",
        "Your king is feeling the heat!",
        "Knock knock! King safety inspection!",
        "Check! Things are getting dangerous..."
    ],
    cager_win: [
        "GG! That was a wild game!",
        "Victory for Cager!",
        "GG! That tactical frenzy went my way!",
        "Good game! Loved the aggression in that match.",
        "GG! Rematch anytime!",
        "What a battle! GG WP!"
    ],
    player_win: [
        "GG WP! Well played!",
        "Respect, great game!",
        "Ouch, clean mate! Outplayed completely.",
        "GG! Masterclass performance from you!",
        "I got outplayed! Great win!",
        "Well played! You caught me off guard."
    ],
    cager_resign: [
        "GG! Thanks for the match!",
        "No way out of this position for me, GG!",
        "Respect! I yield.",
        "GG! You had me completely outplayed there."
    ]
};

// CONFIG & BOOK LOADING
Promise.all([
    fetch('cager-config.json').then(r => r.json()).catch(() => null),
    fetch('cager-book.json').then(r => r.json()).catch(() => null)
]).then(([configData, bookData]) => {
    if (configData) {
        cagerConfig = configData;
        document.getElementById('bot-elo').innerText = `${configData.targetElo || 2132} ELO`;
        if (stockfish) stockfish.postMessage(`setoption name UCI_Elo value ${configData.targetElo || 2132}`);
    }
    if (bookData) {
        cagerBook = bookData.book;
    }
});

// STOCKFISH SETUP
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

function parseStockfishPvLine(line) {
    const parts = line.split(' ');
    const pvIndex = parts.indexOf('pv');
    const scoreIndex = parts.indexOf('cp');

    if (pvIndex !== -1 && pvIndex + 1 < parts.length) {
        const moveStr = parts[pvIndex + 1];
        let score = 0;
        if (scoreIndex !== -1 && scoreIndex + 1 < parts.length) {
            score = parseInt(parts[scoreIndex + 1], 10);
        }
        multiPvCandidates.push({
            moveStr: moveStr,
            stockfishEval: score,
            from: moveStr.substring(0, 2),
            to: moveStr.substring(2, 4),
            promotion: moveStr[4] || 'q'
        });
    }
}

// TIME CONTROL LOGIC
function updateTimeSettings() {
    const val = document.getElementById('time-select').value;
    const incLabel = document.getElementById('inc-label');

    if (val === 'zen') {
        isZenMode = true;
        incLabel.style.display = 'none';
        document.getElementById('bot-clock').innerText = '∞';
        document.getElementById('player-clock').innerText = '∞';
    } else {
        isZenMode = false;
        incLabel.style.display = 'flex';
        timeControlSeconds = parseInt(val, 10);
        incrementSeconds = parseInt(document.getElementById('inc-select').value, 10);
        clocks = { w: timeControlSeconds, b: timeControlSeconds };
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

        if (clocks[turn] <= 0) {
            clearInterval(clockTimer);
            clockTimer = null;
            isGameOver = true;
            const winner = turn === 'w' ? 'TheCager (BOT)' : 'You';
            alert(`Time's up! ${winner} won on time!`);
        }
    }, 1000);
}

function renderClocks() {
    if (isZenMode) return;

    const botColor = 'b';
    const playerColor = 'w';

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

// SOFTMAX & PSYCHOLOGY ENGINE
function processSoftmaxDecisionMatrix() {
    if (multiPvCandidates.length === 0 || isGameOver) return;

    const candidates = [...multiPvCandidates];
    multiPvCandidates = [];

    const currentTurn = chess.turn();
    const profile = (cagerConfig && cagerConfig[currentTurn === 'w' ? 'white' : 'black']) || {};
    const psycho = (cagerConfig && cagerConfig.psychologyEngine) || { softmaxTemperature: 0.82, tiltFactorAlpha: 0.78, timePressureLambda: 0.045 };

    const bestMoveEval = candidates[0].stockfishEval;
    const evalDelta = lastEval - bestMoveEval;
    if (evalDelta > 100) {
        tiltScore = psycho.tiltFactorAlpha * tiltScore + (1 - psycho.tiltFactorAlpha) * evalDelta;
    } else {
        tiltScore *= psycho.tiltFactorAlpha;
    }
    lastEval = bestMoveEval;

    const botRemainingTime = clocks[currentTurn];
    const lambda = psycho.timePressureLambda || 0.045;
    const timePanicTerm = isZenMode ? 0 : Math.exp(-lambda * botRemainingTime);

    const scoredMoves = candidates.map(cand => {
        let cagerScore = cand.stockfishEval;
        const tempBoard = new Chess(chess.fen());
        const moveDetails = tempBoard.move({ from: cand.from, to: cand.to, promotion: cand.promotion });

        if (moveDetails) {
            if (moveDetails.san.includes('+') || ['g4','g5','h4','h5','f4','f5'].includes(cand.to)) {
                cagerScore += ((profile.kingAttackBias || 35) / 100) * 110;
            }
            if (moveDetails.captured) {
                if (moveDetails.captured === 'q') {
                    cagerScore -= ((profile.queenTradeReluctance || 80) / 100) * 220;
                } else if (moveDetails.piece === moveDetails.captured) {
                    cagerScore -= ((profile.tradeAvoidanceIndex || 35) / 100) * 70;
                }
            }
            if (['a4','a5','h4','h5'].includes(cand.to) && moveDetails.piece === 'p') {
                cagerScore += ((profile.flankPawnAggression || 24) / 100) * 80;
            }
            const fromRank = parseInt(cand.from[1]);
            const toRank = parseInt(cand.to[1]);
            if ((currentTurn === 'w' && toRank < fromRank) || (currentTurn === 'b' && toRank > fromRank)) {
                cagerScore -= ((profile.geometricBlindSpotSensitivity || 10) / 100) * 50;
            }
        }
        return { ...cand, cagerScore };
    });

    const effectiveTemp = psycho.softmaxTemperature * (1 + (tiltScore / 300) + (timePanicTerm * 1.8));
    const maxScore = Math.max(...scoredMoves.map(m => m.cagerScore));
    
    const expScores = scoredMoves.map(m => Math.exp((m.cagerScore - maxScore) / (effectiveTemp * 50)));
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    const probabilities = expScores.map(e => e / sumExp);

    let rand = Math.random();
    let cumulative = 0;
    let chosenMove = scoredMoves[0];

    for (let i = 0; i < scoredMoves.length; i++) {
        cumulative += probabilities[i];
        if (rand <= cumulative) {
            chosenMove = scoredMoves[i];
            break;
        }
    }

    const thinkTime = isZenMode ? 600 : Math.max(150, Math.min(1000, botRemainingTime * 30));
    setTimeout(() => makeBotMove(chosenMove), thinkTime);
}

function triggerBotTurn() {
    if (chess.game_over() || isGameOver) return;

    const history = chess.history();
    let stateKey = 'start';
    if (history.length > 0) stateKey = 'start_' + history.join('_');

    const currentTurn = chess.turn();
    const profile = (cagerConfig && cagerConfig[currentTurn === 'w' ? 'white' : 'black']) || {};
    const bookLoyalty = profile.openingBookLoyalty || 70;

    if ((Math.random() * 100) < bookLoyalty && cagerBook && cagerBook[stateKey]) {
        const moves = cagerBook[stateKey];
        const keys = Object.keys(moves);
        if (keys.length > 0) {
            const best = keys.reduce((a, b) => moves[a] > moves[b] ? a : b);
            const m = chess.move(best, { slate: true });
            if (m) {
                makeBotMove(m);
                return;
            }
        }
    }

    multiPvCandidates = [];
    if (stockfish) {
        stockfish.postMessage(`position fen ${chess.fen()}`);
        stockfish.postMessage('go movetime 600');
    }
}

function makeBotMove(moveObj) {
    if (isGameOver) return;

    let move = moveObj;
    if (typeof moveObj === 'object' && !moveObj.color) {
        move = chess.move(moveObj);
    }

    if (!isZenMode && gameStarted) {
        clocks['b'] += incrementSeconds;
    }

    renderBoard();
    renderClocks();

    if (move) {
        if (move.captured) addChatMessage('TheCager', getRandomQuote('cager_capture'));
        else if (chess.in_check()) addChatMessage('TheCager', getRandomQuote('cager_check'));
    }

    checkGameOver();
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
    if (chess.turn() !== 'w' || chess.game_over() || isGameOver) return;

    const square = String.fromCharCode('a'.charCodeAt(0) + c) + (8 - r);
    const piece = chess.get(square);

    if (selectedSquare) {
        const move = chess.move({ from: selectedSquare, to: square, promotion: 'q' });
        if (move) {
            if (!gameStarted) {
                gameStarted = true;
                startClock();
            }

            if (!isZenMode) clocks['w'] += incrementSeconds;

            selectedSquare = null;
            validMoves = [];
            renderBoard();
            renderClocks();

            if (move.captured) addChatMessage('TheCager', getRandomQuote('player_capture'));
            if (checkGameOver()) return;

            setTimeout(triggerBotTurn, 400);
            return;
        }
    }

    if (piece && piece.color === 'w') {
        selectedSquare = square;
        validMoves = chess.moves({ square, verbose: true });
    } else {
        selectedSquare = null;
        validMoves = [];
    }
    renderBoard();
}

function getRandomQuote(cat) {
    const list = CAGER_QUOTES[cat];
    return list[Math.floor(Math.random() * list.length)];
}

function addChatMessage(sender, text) {
    const box = document.getElementById('chat-messages');
    const msg = document.createElement('div');
    msg.className = `chat-msg ${sender === 'TheCager' ? 'bot' : ''}`;
    msg.innerHTML = `<b>${sender}:</b> ${text}`;
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
}

function checkGameOver() {
    if (chess.in_checkmate()) {
        isGameOver = true;
        if (clockTimer) clearInterval(clockTimer);
        const winner = chess.turn() === 'w' ? 'TheCager' : 'You';
        addChatMessage('TheCager', winner === 'TheCager' ? getRandomQuote('cager_win') : getRandomQuote('player_win'));
        alert(`Checkmate! ${winner} wins!`);
        return true;
    }
    return false;
}

// RESTART
document.getElementById('btn-restart').onclick = () => {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    gameStarted = false;
    isGameOver = false;
    chess.reset();
    selectedSquare = null;
    validMoves = [];
    tiltScore = 0;
    updateTimeSettings();
    renderBoard();
    addChatMessage('TheCager', getRandomQuote('start'));
};

// UNDO
document.getElementById('btn-undo').onclick = () => {
    if (isGameOver) return;
    chess.undo();
    chess.undo();
    renderBoard();
    renderClocks();
};

// RESIGN (AUFGEBEN)
document.getElementById('btn-resign').onclick = () => {
    if (isGameOver || chess.game_over()) return;

    if (confirm('Are you sure you want to resign?')) {
        isGameOver = true;
        if (clockTimer) {
            clearInterval(clockTimer);
            clockTimer = null;
        }
        addChatMessage('TheCager', getRandomQuote('cager_resign'));
        alert('You resigned. TheCager (BOT) wins!');
    }
};

// DOWNLOAD PGN
document.getElementById('btn-pgn').onclick = () => {
    const moves = chess.history();
    if (moves.length === 0) {
        alert('No moves played yet!');
        return;
    }

    chess.header('Event', 'TheCager Bot Match');
    chess.header('Site', 'TheCager Game Hub');
    chess.header('Date', new Date().toISOString().split('T')[0].replace(/-/g, '.'));
    chess.header('White', twitchName || 'You');
    chess.header('Black', 'TheCager (BOT)');

    let pgnContent = chess.pgn();
    if (!pgnContent) {
        let moveStr = '';
        moves.forEach((m, idx) => {
            if (idx % 2 === 0) moveStr += `${(idx / 2) + 1}. `;
            moveStr += `${m} `;
        });
        pgnContent = `[Event "TheCager Bot Match"]\n[White "${twitchName || 'You'}"]\n[Black "TheCager (BOT)"]\n\n${moveStr.trim()}`;
    }

    const blob = new Blob([pgnContent], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cager_match_${Date.now()}.pgn`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
};

createBoardDOM();
updateTimeSettings();
renderBoard();
