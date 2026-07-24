const chess = new Chess();
let cagerBook = null;
let cagerConfig = null;

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

// STATS SPEICHERN HELPER
function saveGameResult(mode, result) {
    fetch('/api/stats/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, result })
    })
    .then(res => res.json())
    .then(data => console.log('✅ Stats in DB aktualisiert:', data))
    .catch(err => console.error('❌ Fehler beim Speichern der Stats:', err));
}

// HELPER: Erkennt ob ein Feld (z.B. "e4" oder "f7") hell oder dunkel ist
function getSquareColor(squareStr) {
    if (!squareStr || squareStr.length < 2) return 'light';
    const file = squareStr.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(squareStr[1], 10);
    return (file + rank) % 2 === 0 ? 'dark' : 'light';
}

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

// CONTEXT-AWARE CAGER QUOTES
const CAGER_QUOTES = {
    start: [
        "Howdy! Welcome back to the channel, let's document the climb!",
        "Alright, let's see if we can handle this position today.",
        "Let's go into a Queen's Gambit, keep it clean, classical and solid.",
        "Don't mind me, just providing some unedited commentary as I play!",
        "How's your day going? Thanks for sticking around for the game!",
        "It is raining hard outside right now... but I like the weather like this.",
        "Alright, let's get our pieces out to natural squares. Game on!",
        "We're playing against a solid opponent today. Time to focus!"
    ],
    cager_capture: [
        { text: "And bye-bye! I'll take that pawn with tempo!", piece: 'p' },
        { text: "Nom nom, free material! That piece was standing in my way anyway.", piece: 'not_p' },
        { text: "BANG! We win those, baby! Absolute cinema!" },
        { text: "Sniped! Clean tactical blow right there." },
        { text: "Thanks for the gift! I'm totally fine with trading here." },
        { text: "Taking here comes with an immediate threat. Let's push!" },
        { text: "Look at that, now his knight is completely out of moves!" }
    ],
    player_capture: [
        { text: "Oof, I did NOT see that check! That is no bueno..." },
        { text: "Ouch! I really don't like where my position is going now." },
        { text: "Oh man, I am getting put in the blender right now..." },
        { text: "Wait, did I just blunder something? Shoot, my position is getting tangled!" },
        { text: "Double, double, double dog damn! That is terrifying!" },
        { text: "Yikes! Those pawns of yours are absolute demons!" },
        { text: "Frankly, I'm terrified! Time to play some stubborn defense." }
    ],
    cager_check: [
        { text: "Check! Watch your king safety, things are getting spicy!" },
        { text: "Check! Where is your king going now?" },
        { text: "Check! Now you have to respond to my immediate threat!" },
        { text: "Knock knock! Giving a check on the light squares!", color: 'light' },
        { text: "Check on the dark squares! Keeping the pressure on!", color: 'dark' },
        { text: "Check! That gives me a lot of juicy counterplay!" }
    ],
    cager_win: [
        "BANG! WE WIN THOSE, BABY! What an absolute comeback!",
        "GG WP! Oh my god, what a battle! That was absolute cinema!",
        "GG! I don't care how it happened, a win is a win! Let's go!",
        "GG! That comeback victory felt so hyped! Rematch anytime!",
        "Oh man, games like these will give you arrhythmia! GG WP!",
        "GG! Please consider liking the video, I need that sweet dopamine!"
    ],
    player_win: [
        "GG WP! Man, I got completely outplayed in that endgame!",
        "Respect, great game! You had me completely stuck in the blender.",
        "GG! Clean mate, you played that recovery masterfully!",
        "Ouch! I threw the game away and you punished it instantly. GG!",
        "Sad day for all the Cager enthusiasts out there... GG WP!"
    ],
    cager_resign: [
        "No way out of this position for me... GG, you had me completely outplayed!",
        "GG! I'm completely losing here, respect for the solid play.",
        "I yield! I am so bad at chess today, GG WP!",
        "I double dog dare you to blunder... ah, you didn't. Alright, I resign! GG!"
    ]
};

// SMART QUOTE PICKER
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

// BEWERTUNG DER MATT-KOMPLEXITÄT (MENSCHLICHE EVALUATION)
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

            // Erkennung von Figurenopfern (Höhere Figur greift niedere Figur an / schlägt ab)
            if (isCapture && pieceBefore && targetBefore) {
                const attackerVal = values[pieceBefore.type] || 0;
                const victimVal = values[targetBefore.type] || 0;
                if (attackerVal > victimVal + 1) {
                    sacrifices++;
                }
            }
        }
    }

    // Ein Matt in 4-6 ist EINFACH wenn: Keine Schweren Opfer UND alle Züge sind Schachgebot oder direkte Schlagfälle
    const isSimple = (sacrifices === 0) && (quietMoves === 0) && (nonCheckMoves <= 1);
    return { isSimple, sacrifices, quietMoves };
}

// PARSE STOCKFISH PV LINE MIT NEUER MATT-KOMPLEXITÄT
function parseStockfishPvLine(line) {
    const parts = line.split(' ');
    const pvIndex = parts.indexOf('pv');
    const scoreIndex = parts.indexOf('cp');
    const mateIndex = parts.indexOf('mate');

    if (pvIndex !== -1 && pvIndex + 1 < parts.length) {
        const pvMoves = parts.slice(pvIndex + 1);
        const moveStr = pvMoves[0];
        let score = 0;

        if (scoreIndex !== -1 && scoreIndex + 1 < parts.length) {
            score = parseInt(parts[scoreIndex + 1], 10);
        } else if (mateIndex !== -1 && mateIndex + 1 < parts.length) {
            const mateIn = parseInt(parts[mateIndex + 1], 10);
            const absMate = Math.abs(mateIn);

            if (mateIn > 0) { // Gewinner-Matt für Cager
                if (absMate <= 3) {
                    // MATT IN 1-3: Sieht Cager IMMER (100% Zwingend)
                    score = 20000 - absMate * 100;
                } else if (absMate >= 4 && absMate <= 6) {
                    // MATT IN 4-6: Nur wenn es EINFACH ist (Schachs/Einfache Züge, keine Opfer)
                    const complexity = evaluatePvComplexity(chess.fen(), pvMoves);
                    if (complexity.isSimple) {
                        score = 19000 - absMate * 100; // Sehr hohe Bewertung -> Bot vollstreckt
                    } else {
                        score = 900 - absMate * 50; // Komplexe Opfer-Sequenz -> In normale +9.0 Eval umwandeln
                    }
                } else {
                    // MATT IN 7+: Zu tief zum Matt-Rechnen -> Als starker Positioneller Vorteil bewerten (+7.0 bis +9.0)
                    score = Math.max(700, 1200 - absMate * 40);
                }
            } else { // Verlierer-Matt für Cager
                score = -20000 + absMate * 100;
            }
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
            
            const isPlayerLoss = (turn === 'w');
            saveGameResult('bot', isPlayerLoss ? 'loss' : 'win');
            
            const winner = isPlayerLoss ? 'TheCager (BOT)' : 'You';
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

// SMART EVAL GUARD & HUMAN MATT CONVERSION
function processSoftmaxDecisionMatrix() {
    if (multiPvCandidates.length === 0 || isGameOver) return;

    const candidates = [...multiPvCandidates];
    multiPvCandidates = [];

    const currentTurn = chess.turn();
    const profile = (cagerConfig && cagerConfig[currentTurn === 'w' ? 'white' : 'black']) || {};
    const psycho = (cagerConfig && cagerConfig.psychologyEngine) || { softmaxTemperature: 0.65, tiltFactorAlpha: 0.78, timePressureLambda: 0.045 };

    const bestMoveEval = candidates[0].stockfishEval;
    
    // PERSPEKTIVE: Liegt Bot klar vorne oder sieht er ein direktes einfaches Matt?
    const botEval = currentTurn === 'b' ? -bestMoveEval : bestMoveEval;
    const isDirectShortMate = Math.abs(bestMoveEval) >= 18000;
    const isBotWinningMassively = botEval > 450 || isDirectShortMate;

    const worstEvalInPv = candidates[candidates.length - 1].stockfishEval;
    const evalSpread = Math.abs(bestMoveEval - worstEvalInPv);
    const isComplexPosition = evalSpread > 180 || chess.in_check();

    const evalDelta = lastEval - bestMoveEval;
    if (evalDelta > 100) {
        tiltScore = psycho.tiltFactorAlpha * tiltScore + (1 - psycho.tiltFactorAlpha) * evalDelta;
    } else {
        tiltScore *= psycho.tiltFactorAlpha;
    }
    lastEval = bestMoveEval;

    // 1. EVAL GUARD FILTER
    const safeCandidates = candidates.filter(cand => {
        const evalLoss = bestMoveEval - cand.stockfishEval;

        // Bei direkt gesehenem einfachen Matt (<=3 Züge oder einfaches 4-6) MUSS der beste Zug genommen werden!
        if (isDirectShortMate) return evalLoss === 0;

        // HARTER BAN: Max 250 cp Verlust
        if (evalLoss > 250) return false;

        if (evalLoss > 80) {
            const isAggressiveIntent = cand.moveStr.includes('+') || ['g4','g5','h4','h5','f4','f5'].includes(cand.to);
            const isHighTiltOrTimePanic = tiltScore > 160 || (clocks[currentTurn] < 15 && !isZenMode);

            if (!isComplexPosition && !isHighTiltOrTimePanic) return false;
            if (!isAggressiveIntent && !isHighTiltOrTimePanic) return false;
        }

        return true;
    });

    const finalCandidates = safeCandidates.length > 0 ? safeCandidates : [candidates[0]];

    // 2. STIL & CONVERSION BEWERTUNG
    const scoredMoves = finalCandidates.map(cand => {
        let cagerScore = cand.stockfishEval;
        const tempBoard = new Chess(chess.fen());
        const moveDetails = tempBoard.move({ from: cand.from, to: cand.to, promotion: cand.promotion });

        if (moveDetails) {
            if (!isBotWinningMassively) {
                if (moveDetails.san.includes('+') || ['g4','g5','h4','h5','f4','f5'].includes(cand.to)) {
                    cagerScore += ((profile.kingAttackBias || 35) / 100) * 80;
                }
                if (moveDetails.captured) {
                    if (moveDetails.captured === 'q') {
                        cagerScore -= ((profile.queenTradeReluctance || 80) / 100) * 180;
                    } else if (moveDetails.piece === moveDetails.captured) {
                        cagerScore -= ((profile.tradeAvoidanceIndex || 35) / 100) * 50;
                    }
                }
            } else {
                // ABWICKLUNG IM GEWINNSTELLUNGS-MODUS:
                if (moveDetails.captured) cagerScore += 60;
                if (moveDetails.san.includes('+')) cagerScore += 40;
            }
        }
        return { ...cand, cagerScore };
    });

    // 3. SELEKTION
    let chosenMove = scoredMoves[0];

    if (isDirectShortMate) {
        chosenMove = scoredMoves.reduce((best, m) => m.cagerScore > best.cagerScore ? m : best, scoredMoves[0]);
    } else {
        const botRemainingTime = clocks[currentTurn];
        const lambda = psycho.timePressureLambda || 0.045;
        const timePanicTerm = isZenMode ? 0 : Math.exp(-lambda * botRemainingTime);

        const effectiveTemp = (psycho.softmaxTemperature || 0.65) * (1 + (tiltScore / 400) + (timePanicTerm * 1.2));
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

    const thinkTime = isZenMode ? 400 : Math.max(150, Math.min(800, clocks[currentTurn] * 20));
    setTimeout(() => makeBotMove(chosenMove), thinkTime);
}

function triggerBotTurn() {
    if (chess.game_over() || isGameOver) return;

    const history = chess.history();
    let stateKey = 'start';
    if (history.length > 0) stateKey = 'start_' + history.join('_');

    const currentTurn = chess.turn();
    const profile = (cagerConfig && cagerConfig[currentTurn === 'w' ? 'white' : 'black']) || {};
    
    const bookLoyalty = profile.openingBookLoyalty || 95;

    if ((Math.random() * 100) <= bookLoyalty && cagerBook && cagerBook[stateKey]) {
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
        stockfish.postMessage('go movetime 650');
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
        const toColor = getSquareColor(move.to);
        const capturedPiece = move.captured;

        if (move.captured) {
            addChatMessage('TheCager', getRandomQuote('cager_capture', { color: toColor, piece: capturedPiece }));
        } else if (chess.in_check()) {
            addChatMessage('TheCager', getRandomQuote('cager_check', { color: toColor }));
        }
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
        
        const isPlayerWin = chess.turn() === 'b';
        saveGameResult('bot', isPlayerWin ? 'win' : 'loss');
        
        const winner = isPlayerWin ? 'You' : 'TheCager';
        addChatMessage('TheCager', isPlayerWin ? getRandomQuote('player_win') : getRandomQuote('cager_win'));
        alert(`Checkmate! ${winner} wins!`);
        return true;
    }
    
    if (chess.in_draw() || chess.in_stalemate() || chess.in_threefold_repetition()) {
        isGameOver = true;
        if (clockTimer) clearInterval(clockTimer);
        saveGameResult('bot', 'draw');
        addChatMessage('TheCager', "GG! A draw. Fair enough.");
        alert("Draw! Game Over.");
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

// RESIGN
document.getElementById('btn-resign').onclick = () => {
    if (isGameOver || chess.game_over()) return;

    if (confirm('Are you sure you want to resign?')) {
        isGameOver = true;
        if (clockTimer) {
            clearInterval(clockTimer);
            clockTimer = null;
        }
        
        saveGameResult('bot', 'loss');
        
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
