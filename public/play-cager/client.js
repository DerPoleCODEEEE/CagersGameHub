const chess = new Chess();
let cagerBook = null;
let cagerConfig = null;

// PSYCHOLOGY ENGINE STATE
let tiltScore = 0;
let lastEval = 0;

// Stockfish Web Worker
const stockfish = new Worker('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');

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

const PIECES = {
    'p': 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg',
    'n': 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg',
    'b': 'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg',
    'r': 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg',
    'q': 'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg',
    'k': 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg',
    'P': 'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg',
    'N': 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg',
    'B': 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg',
    'R': 'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg',
    'Q': 'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg',
    'K': 'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg'
};

const CAGER_QUOTES = {
    start: ["Moin Moin! Viel Erfolg!", "Auf geht's! Zeig was du kannst!"],
    cager_capture: ["Aand tschüss! Die Figur gehört jetzt mir!", "Danke für das Geschenk!"],
    player_capture: ["Oha, den hab ich gar nicht gesehen...", "Aua! Starker Zug."],
    cager_check: ["Schach! Wo willst du hin?", "König in Gefahr!"],
    cager_win: ["GG! Das war 'ne wilde Partie!", "Sieg für Cager!"],
    player_win: ["GG WP! Das hast du stark gespielt!", "Respekt, gut gemacht!"]
};

// CONFIG & BOOK LADEN
Promise.all([
    fetch('cager-config.json').then(r => r.json()).catch(() => null),
    fetch('cager-book.json').then(r => r.json()).catch(() => null)
]).then(([configData, bookData]) => {
    if (configData) {
        cagerConfig = configData;
        document.getElementById('bot-elo').innerText = `${configData.targetElo || 2132} ELO`;
        stockfish.postMessage(`setoption name UCI_Elo value ${configData.targetElo || 2132}`);
        updateSidebarStats();
    }
    if (bookData) {
        cagerBook = bookData.book;
    }
});

// STOCKFISH MULTI-PV ENGINE SETUP
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

// SOFTMAX & VECTOR DECISION ENGINE
function processSoftmaxDecisionMatrix() {
    if (multiPvCandidates.length === 0) return;

    const candidates = [...multiPvCandidates];
    multiPvCandidates = [];

    const currentTurn = chess.turn(); // 'w' oder 'b'
    const profile = (cagerConfig && cagerConfig[currentTurn === 'w' ? 'white' : 'black']) || {};
    const psycho = (cagerConfig && cagerConfig.psychologyEngine) || { softmaxTemperature: 0.82, tiltFactorAlpha: 0.78 };

    // Update Tilt Status
    const bestMoveEval = candidates[0].stockfishEval;
    const evalDelta = lastEval - bestMoveEval;
    if (evalDelta > 100) {
        tiltScore = psycho.tiltFactorAlpha * tiltScore + (1 - psycho.tiltFactorAlpha) * evalDelta;
    } else {
        tiltScore *= psycho.tiltFactorAlpha;
    }
    lastEval = bestMoveEval;

    // Evaluierung aller Kandidaten mit Vektor-Boni
    const scoredMoves = candidates.map(cand => {
        let cagerScore = cand.stockfishEval;
        const tempBoard = new Chess(chess.fen());
        const moveDetails = tempBoard.move({ from: cand.from, to: cand.to, promotion: cand.promotion });

        if (moveDetails) {
            // 1. Königs-Angriffslust
            if (moveDetails.san.includes('+') || ['g4','g5','h4','h5','f4','f5'].includes(cand.to)) {
                cagerScore += ((profile.kingAttackBias || 35) / 100) * 110;
            }
            // 2. Damentausch & Tausch-Vermeidung
            if (moveDetails.captured) {
                if (moveDetails.captured === 'q') {
                    cagerScore -= ((profile.queenTradeReluctance || 80) / 100) * 220;
                } else if (moveDetails.piece === moveDetails.captured) {
                    cagerScore -= ((profile.tradeAvoidanceIndex || 35) / 100) * 70;
                }
            }
            // 3. Randbauern Push
            if (['a4','a5','h4','h5'].includes(cand.to) && moveDetails.piece === 'p') {
                cagerScore += ((profile.flankPawnAggression || 24) / 100) * 80;
            }
            // 4. Blind-Spot Malus (Rückwärtszüge)
            const fromRank = parseInt(cand.from[1]);
            const toRank = parseInt(cand.to[1]);
            if ((currentTurn === 'w' && toRank < fromRank) || (currentTurn === 'b' && toRank > fromRank)) {
                cagerScore -= ((profile.geometricBlindSpotSensitivity || 10) / 100) * 50;
            }
        }
        return { ...cand, cagerScore };
    });

    // SOFTMAX WAHRSCHEINLICHKEITS-DISTRIBUTION
    const effectiveTemp = psycho.softmaxTemperature * (1 + tiltScore / 300);
    const maxScore = Math.max(...scoredMoves.map(m => m.cagerScore));
    
    const expScores = scoredMoves.map(m => Math.exp((m.cagerScore - maxScore) / (effectiveTemp * 50)));
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    const probabilities = expScores.map(e => e / sumExp);

    // Zufallsauswahl nach Softmax-Gewichtung
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

    // Simulierte menschliche Bedenkzeit
    const thinkTime = Math.floor(Math.random() * 400) + 400;
    setTimeout(() => makeBotMove(chosenMove), thinkTime);
}

function triggerBotTurn() {
    if (chess.game_over()) return;

    updateSidebarStats();

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
    stockfish.postMessage(`position fen ${chess.fen()}`);
    stockfish.postMessage('go movetime 600');
}

function makeBotMove(moveObj) {
    let move = moveObj;
    if (typeof moveObj === 'object' && !moveObj.color) {
        move = chess.move(moveObj);
    }

    renderBoard();

    if (move) {
        if (move.captured) addChatMessage('TheCager', getRandomQuote('cager_capture'));
        else if (chess.in_check()) addChatMessage('TheCager', getRandomQuote('cager_check'));
    }

    checkGameOver();
}

function updateSidebarStats() {
    if (!cagerConfig) return;
    const isWhite = chess.turn() === 'w';
    const profile = isWhite ? cagerConfig.white : cagerConfig.black;

    document.getElementById('active-color-tag').innerText = isWhite ? 'WEISS' : 'SCHWARZ';
    
    document.getElementById('val-book').innerText = `${profile.openingBookLoyalty}%`;
    document.getElementById('bar-book').style.width = `${profile.openingBookLoyalty}%`;

    document.getElementById('val-attack').innerText = `${profile.kingAttackBias}%`;
    document.getElementById('bar-attack').style.width = `${profile.kingAttackBias}%`;

    document.getElementById('val-sac').innerText = `${profile.sacrificeWillingness}%`;
    document.getElementById('bar-sac').style.width = `${profile.sacrificeWillingness}%`;

    document.getElementById('val-trade').innerText = `${profile.tradeAvoidanceIndex}%`;
    document.getElementById('bar-trade').style.width = `${profile.tradeAvoidanceIndex}%`;
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
                const key = piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
                img.src = PIECES[key];
                square.appendChild(img);
            }
        }
    }
}

function handleSquareClick(r, c) {
    if (chess.turn() !== 'w' || chess.game_over()) return;

    const square = String.fromCharCode('a'.charCodeAt(0) + c) + (8 - r);
    const piece = chess.get(square);

    if (selectedSquare) {
        const move = chess.move({ from: selectedSquare, to: square, promotion: 'q' });
        if (move) {
            selectedSquare = null;
            validMoves = [];
            renderBoard();

            if (move.captured) addChatMessage('TheCager', getRandomQuote('player_capture'));
            if (checkGameOver()) return;

            setTimeout(triggerBotTurn, 500);
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
        const winner = chess.turn() === 'w' ? 'TheCager' : 'Du';
        addChatMessage('TheCager', winner === 'TheCager' ? getRandomQuote('cager_win') : getRandomQuote('player_win'));
        alert(`Schachmatt! ${winner} gewinnt!`);
        return true;
    }
    return false;
}

document.getElementById('btn-restart').onclick = () => {
    chess.reset();
    selectedSquare = null;
    validMoves = [];
    tiltScore = 0;
    renderBoard();
    addChatMessage('TheCager', getRandomQuote('start'));
};

document.getElementById('btn-undo').onclick = () => {
    chess.undo();
    chess.undo();
    renderBoard();
};

createBoardDOM();
renderBoard();
