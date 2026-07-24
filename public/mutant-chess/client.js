const socket = io('/mutant-chess');

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

socket.on('connect', () => {
    const splash = document.getElementById('splash-screen');
    if (splash) splash.style.display = 'none';
});

// TWITCH DATA
const twitchName = localStorage.getItem('cager_twitch_name');
const twitchPfp = localStorage.getItem('cager_twitch_pfp') || '';

if (twitchName && twitchName !== 'undefined' && twitchName !== 'null') {
    document.getElementById('player-name').value = twitchName;
    document.getElementById('player-name').disabled = true;
}

// SLIDER INPUTS
const timeRange = document.getElementById('time-range');
const incRange = document.getElementById('inc-range');
const fusionRange = document.getElementById('fusion-range');

const timeVal = document.getElementById('time-val');
const incVal = document.getElementById('inc-val');
const fusionVal = document.getElementById('fusion-val');

timeRange.oninput = () => timeVal.innerText = timeRange.value;
incRange.oninput = () => incVal.innerText = incRange.value;
fusionRange.oninput = () => fusionVal.innerText = fusionRange.value;

// STANDARD CHESS PIECES (ONLINE WIKIMEDIA SVGs)
const PIECES = {
    'P': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg' },
    'N': { img: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg' },
    'B': { img: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg' },
    'R': { img: 'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg' },
    'Q': { img: 'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg' },
    'K': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg' },
    'p': { img: 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg' },
    'n': { img: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg' },
    'b': { img: 'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg' },
    'r': { img: 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg' },
    'q': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg' },
    'k': { img: 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg' }
};

let roomCode = null, playerColor = null;
let myName = '', opponentName = '', opponentPfp = '';
let selectedSquare = null;
let validMoves = [], isGameOver = false, isBoardDomCreated = false;
let isGameStarted = false;
let currentTurn = 'w';
let moveCount = 1;

let clocks = { w: 180, b: 180 };
let clockTimer = null;
let enPassantTarget = null;
let pendingPromotion = null;
let hasMoved = { wK: false, wR_left: false, wR_right: false, bK: false, bR_left: false, bR_right: false };

let maxFusions = 3;
let fusionsLeft = { w: 3, b: 3 };

let board = [
    [['r'], ['n'], ['b'], ['q'], ['k'], ['b'], ['n'], ['r']],
    [['p'], ['p'], ['p'], ['p'], ['p'], ['p'], ['p'], ['p']],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [['P'], ['P'], ['P'], ['P'], ['P'], ['P'], ['P'], ['P']],
    [['R'], ['N'], ['B'], ['Q'], ['K'], ['B'], ['N'], ['R']]
];

const menuScreen = document.getElementById('menu-screen'), lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen'), errorMsg = document.getElementById('error-msg');
const boardEl = document.getElementById('board');
const btnReady = document.getElementById('btn-ready'), statusBanner = document.getElementById('status-banner');
const statusBannerText = document.getElementById('status-banner-text');
const historyList = document.getElementById('history-list');

const bottomClockEl = document.getElementById('bottom-clock');
const topClockEl = document.getElementById('top-clock');

const bottomFusionDots = document.getElementById('bottom-fusion-dots');
const topFusionDots = document.getElementById('top-fusion-dots');

function getPieceColor(pieceArr) {
    if (!pieceArr || !pieceArr.length) return null;
    return pieceArr[0][0] === pieceArr[0][0].toUpperCase() ? 'w' : 'b';
}

function toAlgebraic(r, c) {
    const colStr = String.fromCharCode('a'.charCodeAt(0) + c);
    const rowStr = (8 - r).toString();
    return colStr + rowStr;
}

function formatTime(seconds) {
    const sec = Math.max(0, Math.floor(seconds));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

document.getElementById('btn-create').onclick = () => {
    myName = document.getElementById('player-name').value.trim() || 'Player 1';
    const colorChoice = document.getElementById('color-choice').value;
    const totalTime = parseInt(timeRange.value, 10);
    const increment = parseInt(incRange.value, 10);
    const maxF = parseInt(fusionRange.value, 10);

    socket.emit('create_mutant_room', { 
        playerName: myName, pfp: twitchPfp, colorChoice, totalTime, increment, maxFusions: maxF 
    });
};

document.getElementById('btn-join').onclick = () => {
    myName = document.getElementById('player-name').value.trim() || 'Player 2';
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) return showError('Please enter a room code!');
    socket.emit('join_mutant_room', { roomCode: code, playerName: myName, pfp: twitchPfp });
};

document.getElementById('btn-leave-lobby').onclick = leaveGame;
document.getElementById('btn-leave-game').onclick = leaveGame;

document.getElementById('btn-resign').onclick = () => {
    if (confirm("Are you sure you want to resign?")) {
        socket.emit('resign_game', { roomCode });
    }
};

document.getElementById('btn-offer-draw').onclick = () => {
    socket.emit('offer_draw', { roomCode });
    alert("Draw offer sent!");
};

document.getElementById('btn-accept-draw').onclick = () => {
    document.getElementById('draw-modal').style.display = 'none';
    socket.emit('respond_draw', { roomCode, accepted: true });
};

document.getElementById('btn-decline-draw').onclick = () => {
    document.getElementById('draw-modal').style.display = 'none';
    socket.emit('respond_draw', { roomCode, accepted: false });
};

btnReady.onclick = () => {
    socket.emit('player_ready', { roomCode });
    btnReady.innerText = 'READY!'; btnReady.classList.add('is-ready'); btnReady.disabled = true;
};

function leaveGame() { location.reload(); }
function showError(msg) { errorMsg.innerText = msg; }

socket.on('mutant_room_created', (data) => {
    roomCode = data.roomCode; playerColor = data.color;
    if (data.clocks) clocks = data.clocks;
    if (data.maxFusions) maxFusions = data.maxFusions;
    if (data.fusionsLeft) fusionsLeft = data.fusionsLeft;
    menuScreen.classList.add('hidden'); lobbyScreen.classList.remove('hidden');
    document.getElementById('display-room-code').innerText = roomCode;
});

socket.on('mutant_room_joined', (data) => {
    roomCode = data.roomCode; playerColor = data.color;
    opponentName = data.opponentName; opponentPfp = data.opponentPfp;
    if (data.clocks) clocks = data.clocks;
    if (data.maxFusions) maxFusions = data.maxFusions;
    if (data.fusionsLeft) fusionsLeft = data.fusionsLeft;
    startGame();
});

socket.on('mutant_opponent_joined', (data) => { 
    opponentName = data.opponentName; opponentPfp = data.opponentPfp; 
    startGame(); 
});

socket.on('mutant_opponent_left', () => {
    statusBanner.classList.remove('hidden');
    statusBannerText.innerText = "Opponent has left the game!";
});

socket.on('ready_update', ({ playersReady }) => {
    statusBanner.classList.remove('hidden');
    playersReady.forEach(p => {
        if (p.ready) {
            const displayName = p.color === playerColor ? myName : (opponentName || p.name || 'Opponent');
            statusBannerText.innerText = `${displayName} is Ready!`;
        }
    });
});

socket.on('start_match_countdown', (data) => {
    if (data && data.clocks) clocks = data.clocks;
    if (data && data.fusionsLeft) fusionsLeft = data.fusionsLeft;
    if (data && data.maxFusions) maxFusions = data.maxFusions;

    isGameStarted = false;
    statusBanner.classList.remove('hidden');
    let secondsLeft = 5;
    statusBannerText.innerText = `Match starting in ${secondsLeft}s!`;
    
    const interval = setInterval(() => {
        secondsLeft--;
        if (secondsLeft > 0) {
            statusBannerText.innerText = `Match starting in ${secondsLeft}s!`;
        } else {
            clearInterval(interval);
            statusBannerText.innerText = `BATTLE STARTED! GO!`;
            isGameStarted = true;
            startClockTicker();
            setTimeout(() => statusBanner.classList.add('hidden'), 1500);
        }
    }, 1000);
});

socket.on('apply_mutant_move', (moveData) => {
    if (moveData.clocks) clocks = moveData.clocks;
    if (moveData.fusionsLeft) fusionsLeft = moveData.fusionsLeft;
    executeMove(moveData.fromR, moveData.fromC, moveData.toR, moveData.toC, moveData.moveInfo, moveData.board, moveData.nextTurn);
});

socket.on('draw_offered', () => {
    document.getElementById('draw-modal').style.display = 'flex';
});

socket.on('draw_declined', () => {
    alert("Opponent declined the draw offer!");
});

socket.on('game_over', ({ winnerColor, reason }) => {
    isGameOver = true;
    clearInterval(clockTimer);
    
    let result = 'draw';
    if (winnerColor === null) {
        result = 'draw';
    } else if (winnerColor === playerColor) {
        result = 'win';
    } else {
        result = 'loss';
    }

    // STATS IN DATABASE SPEICHERN
    saveGameResult('mutant', result);

    let text = "";
    if (winnerColor === null) {
        text = "Draw! (Agreed Draw)";
    } else if (winnerColor === playerColor) {
        text = reason === 'time' ? "Victory by time out!" : (reason === 'resign' ? "Opponent resigned!" : "Victory! Enemy King destroyed!");
    } else {
        text = reason === 'time' ? "Defeat! Time ran out!" : (reason === 'resign' ? "You resigned." : "Defeat! Your King was destroyed!");
    }

    document.getElementById('winner-text').innerText = text;
    document.getElementById('game-over').style.display = 'flex';
});

socket.on('error_msg', (msg) => showError(msg));

function renderFusionDots() {
    if (!bottomFusionDots || !topFusionDots) return;
    
    const myFusions = fusionsLeft[playerColor];
    const oppColor = playerColor === 'w' ? 'b' : 'w';
    const oppFusions = fusionsLeft[oppColor];

    bottomFusionDots.innerHTML = '';
    topFusionDots.innerHTML = '';

    for (let i = 0; i < maxFusions; i++) {
        const myDot = document.createElement('div');
        myDot.className = `fusion-dot ${i >= myFusions ? 'used' : ''}`;
        bottomFusionDots.appendChild(myDot);

        const oppDot = document.createElement('div');
        oppDot.className = `fusion-dot ${i >= oppFusions ? 'used' : ''}`;
        topFusionDots.appendChild(oppDot);
    }
}

function startGame() {
    menuScreen.classList.add('hidden'); lobbyScreen.classList.add('hidden'); gameScreen.classList.remove('hidden');
    document.getElementById('my-role-tag').innerText = playerColor === 'w' ? 'WHITE' : 'BLACK';
    
    document.getElementById('bottom-player-name').innerText = myName + ' (You)';
    document.getElementById('top-player-name').innerText = opponentName || 'Opponent';
    
    const bottomPfpEl = document.getElementById('bottom-pfp');
    if (twitchPfp) { bottomPfpEl.src = twitchPfp; bottomPfpEl.classList.remove('hidden'); }
    
    const topPfpEl = document.getElementById('top-pfp');
    if (opponentPfp) { topPfpEl.src = opponentPfp; topPfpEl.classList.remove('hidden'); }

    if (playerColor === 'b') boardEl.classList.add('flipped');
    createBoardDOMOnce(); renderBoard(); updateTurnDisplay(); updateClockDisplay(); renderFusionDots();
}

function startClockTicker() {
    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
        if (!isGameStarted || isGameOver) return;
        
        clocks[currentTurn] = Math.max(0, clocks[currentTurn] - 0.1);
        updateClockDisplay();

        if (clocks[currentTurn] <= 0) {
            clearInterval(clockTimer);
            socket.emit('time_out', { roomCode, loserColor: currentTurn });
        }
    }, 100);
}

function updateClockDisplay() {
    const myClockVal = clocks[playerColor];
    const oppColor = playerColor === 'w' ? 'b' : 'w';
    const oppClockVal = clocks[oppColor];

    bottomClockEl.innerText = formatTime(myClockVal);
    topClockEl.innerText = formatTime(oppClockVal);

    if (currentTurn === playerColor) {
        bottomClockEl.classList.add('active');
        topClockEl.classList.remove('active');
    } else {
        topClockEl.classList.add('active');
        bottomClockEl.classList.remove('active');
    }
}

function updateTurnDisplay() {
    const turnTag = document.getElementById('turn-display-tag');
    if (currentTurn === playerColor) {
        turnTag.innerText = "YOUR TURN!";
        turnTag.style.color = "#2ecc71";
    } else {
        turnTag.innerText = "OPPONENT'S TURN...";
        turnTag.style.color = "#e74c3c";
    }
}

function createBoardDOMOnce() {
    if (isBoardDomCreated) return;
    boardEl.innerHTML = '';
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = document.createElement('div');
            square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
            square.dataset.r = r; square.dataset.c = c;
            
            const container = document.createElement('div');
            container.className = 'piece-container hidden';
            
            const mainImg = document.createElement('img');
            mainImg.className = 'piece-img main';
            mainImg.referrerPolicy = "no-referrer";
            container.appendChild(mainImg);

            const overlayImg = document.createElement('img');
            overlayImg.className = 'piece-img overlay hidden';
            overlayImg.referrerPolicy = "no-referrer";
            container.appendChild(overlayImg);

            square.appendChild(container);
            square.onclick = () => handleSquareClick(r, c);
            boardEl.appendChild(square);
        }
    }
    isBoardDomCreated = true;
}

function getValidMoves(r, c) {
    const pieceArr = board[r][c];
    if (!pieceArr) return [];

    const pColor = getPieceColor(pieceArr);
    if (pColor !== playerColor || currentTurn !== playerColor) return [];

    let moves = [];
    const canMerge = fusionsLeft[playerColor] > 0;
    const isPieceFused = pieceArr.some(p => p.includes('_fused'));

    pieceArr.forEach(typeChar => {
        const charLower = typeChar.toLowerCase().replace('_fused', '');
        const dir = pColor === 'w' ? -1 : 1;
        const startRow = pColor === 'w' ? 6 : 1;

        const addSliding = (dirs) => {
            for (let [dr, dc] of dirs) {
                let nr = r + dr, nc = c + dc;
                while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                    const target = board[nr][nc];
                    if (!target) {
                        moves.push({ r: nr, c: nc, type: 'normal' });
                    } else {
                        if (getPieceColor(target) !== pColor) {
                            moves.push({ r: nr, c: nc, type: 'capture' });
                        } else if (canMerge && !isPieceFused && pieceArr.length + target.length <= 2) {
                            const targetFused = target.some(p => p.includes('_fused'));
                            if (!targetFused) {
                                const combined = [...pieceArr, ...target].map(p => p.toLowerCase().replace('_fused', ''));
                                const hasSameType = new Set(combined).size !== combined.length;
                                const isRedundantQueen = combined.includes('q') && (combined.includes('b') || combined.includes('r') || combined.includes('p'));
                                const isKingPawn = combined.includes('k') && combined.includes('p');
                                
                                if (!hasSameType && !isRedundantQueen && !isKingPawn) {
                                    moves.push({ r: nr, c: nc, type: 'merge' });
                                }
                            }
                        }
                        break;
                    }
                    nr += dr; nc += dc;
                }
            }
        };

        switch (charLower) {
            case 'p':
                if (r + dir >= 0 && r + dir < 8 && !board[r + dir][c]) {
                    moves.push({ r: r + dir, c, type: 'normal' });
                    if (r === startRow && !board[r + dir * 2][c]) moves.push({ r: r + dir * 2, c, type: 'normal' });
                }
                for (let dc of [-1, 1]) {
                    let targetR = r + dir, targetC = c + dc;
                    if (targetR >= 0 && targetR < 8 && targetC >= 0 && targetC < 8) {
                        const target = board[targetR][targetC];
                        if (target) {
                            if (getPieceColor(target) !== pColor) {
                                moves.push({ r: targetR, c: targetC, type: 'capture' });
                            } else if (canMerge && !isPieceFused && pieceArr.length + target.length <= 2) {
                                const targetFused = target.some(p => p.includes('_fused'));
                                if (!targetFused) {
                                    const combined = [...pieceArr, ...target].map(p => p.toLowerCase().replace('_fused', ''));
                                    const hasSameType = new Set(combined).size !== combined.length;
                                    const isRedundantQueen = combined.includes('q') && (combined.includes('b') || combined.includes('r') || combined.includes('p'));
                                    const isKingPawn = combined.includes('k') && combined.includes('p');

                                    if (!hasSameType && !isRedundantQueen && !isKingPawn) {
                                        moves.push({ r: targetR, c: targetC, type: 'merge' });
                                    }
                                }
                            }
                        } else if (enPassantTarget && enPassantTarget.color !== pColor && enPassantTarget.r === targetR && enPassantTarget.c === targetC) {
                            moves.push({ r: targetR, c: targetC, type: 'en_passant' });
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
                    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                        const target = board[nr][nc];
                        if (!target) {
                            moves.push({ r: nr, c: nc, type: 'normal' });
                        } else if (getPieceColor(target) !== pColor) {
                            moves.push({ r: nr, c: nc, type: 'capture' });
                        } else if (canMerge && !isPieceFused && pieceArr.length + target.length <= 2) {
                            const targetFused = target.some(p => p.includes('_fused'));
                            if (!targetFused) {
                                const combined = [...pieceArr, ...target].map(p => p.toLowerCase().replace('_fused', ''));
                                const hasSameType = new Set(combined).size !== combined.length;
                                const isRedundantQueen = combined.includes('q') && (combined.includes('b') || combined.includes('r') || combined.includes('p'));
                                const isKingPawn = combined.includes('k') && combined.includes('p');

                                if (!hasSameType && !isRedundantQueen && !isKingPawn) {
                                    moves.push({ r: nr, c: nc, type: 'merge' });
                                }
                            }
                        }
                    }
                }
                break;

            case 'k':
                for (let [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                    let nr = r + dr, nc = c + dc;
                    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                        const target = board[nr][nc];
                        if (!target) {
                            moves.push({ r: nr, c: nc, type: 'normal' });
                        } else if (getPieceColor(target) !== pColor) {
                            moves.push({ r: nr, c: nc, type: 'capture' });
                        } else if (canMerge && !isPieceFused && pieceArr.length + target.length <= 2) {
                            const targetFused = target.some(p => p.includes('_fused'));
                            if (!targetFused) {
                                const combined = [...pieceArr, ...target].map(p => p.toLowerCase().replace('_fused', ''));
                                const hasSameType = new Set(combined).size !== combined.length;
                                const isRedundantQueen = combined.includes('q') && (combined.includes('b') || combined.includes('r') || combined.includes('p'));
                                const isKingPawn = combined.includes('k') && combined.includes('p');

                                if (!hasSameType && !isRedundantQueen && !isKingPawn) {
                                    moves.push({ r: nr, c: nc, type: 'merge' });
                                }
                            }
                        }
                    }
                }
                const kRow = pColor === 'w' ? 7 : 0;
                const kKey = pColor === 'w' ? 'wK' : 'bK';
                const rookChar = pColor === 'w' ? 'R' : 'r';

                if (r === kRow && c === 4 && !hasMoved[kKey]) {
                    const rRight = pColor === 'w' ? 'wR_right' : 'bR_right';
                    if (!hasMoved[rRight] && board[kRow][7] && board[kRow][7].includes(rookChar) && !board[kRow][5] && !board[kRow][6]) {
                        moves.push({ r: kRow, c: 6, type: 'castle' });
                    }
                    const rLeft = pColor === 'w' ? 'wR_left' : 'bR_left';
                    if (!hasMoved[rLeft] && board[kRow][0] && board[kRow][0].includes(rookChar) && !board[kRow][1] && !board[kRow][2] && !board[kRow][3]) {
                        moves.push({ r: kRow, c: 2, type: 'castle' });
                    }
                }
                break;
        }
    });

    const uniqueMap = new Map();
    moves.forEach(m => uniqueMap.set(`${m.r}-${m.c}`, m));
    return Array.from(uniqueMap.values());
}

function handleSquareClick(r, c) {
    if (!isGameStarted || isGameOver || currentTurn !== playerColor || pendingPromotion) return;
    const clickedPiece = board[r][c];

    if (selectedSquare) {
        let moveInfo = validMoves.find(m => m.r === r && m.c === c);
        if (moveInfo) {
            const movingPiece = board[selectedSquare.r][selectedSquare.c];

            if (movingPiece && movingPiece.length === 1 && movingPiece[0].toLowerCase() === 'p' && (r === 0 || r === 7)) {
                triggerPromotion(selectedSquare.r, selectedSquare.c, r, c, moveInfo);
                return;
            }

            sendMoveToServer(selectedSquare.r, selectedSquare.c, r, c, moveInfo, null);
            selectedSquare = null; validMoves = []; renderBoard(); return;
        }
    }

    if (clickedPiece && getPieceColor(clickedPiece) === playerColor) {
        selectedSquare = { r, c };
        validMoves = getValidMoves(r, c);
        renderBoard();
        return;
    }

    selectedSquare = null; validMoves = []; renderBoard();
}

function triggerPromotion(fromR, fromC, toR, toC, moveInfo) {
    pendingPromotion = { fromR, fromC, toR, toC, moveInfo };
    const modal = document.getElementById('promotion-modal');
    const box = document.getElementById('promo-options');
    box.innerHTML = '';

    const promoPieces = playerColor === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b'];
    promoPieces.forEach(p => {
        const img = document.createElement('img');
        img.className = 'promo-piece';
        img.referrerPolicy = "no-referrer";
        img.src = PIECES[p].img;
        img.onclick = () => {
            modal.style.display = 'none';
            pendingPromotion = null;
            sendMoveToServer(fromR, fromC, toR, toC, moveInfo, p);
            selectedSquare = null; validMoves = []; renderBoard();
        };
        box.appendChild(img);
    });
    modal.style.display = 'flex';
}

function sendMoveToServer(fromR, fromC, toR, toC, moveInfo, promotedTo) {
    socket.emit('request_mutant_move', {
        roomCode, fromR, fromC, toR, toC, moveInfo, promotedTo
    });
}

function addMoveToHistory(fromR, fromC, toR, toC, movingPiece, targetPiece, moveType) {
    const dest = toAlgebraic(toR, toC);
    const start = toAlgebraic(fromR, fromC);
    let str = "";

    const formatPieces = (arr) => arr.map(p => p.replace('_fused', '').toUpperCase()).join('+');

    if (moveType === 'castle') {
        str = toC === 6 ? "O-O" : "O-O-O";
    } else if (moveType === 'merge') {
        const movingStr = formatPieces(movingPiece);
        const targetStr = formatPieces(targetPiece);
        str = `${movingStr}+${targetStr}@${dest}`;
    } else {
        const isMutant = movingPiece.length > 1;
        const pStr = isMutant ? `(${formatPieces(movingPiece)})` : movingPiece[0].replace('_fused', '').toUpperCase();
        
        if (moveType === 'capture' || moveType === 'en_passant') {
            str = `${pStr}x${dest}`;
        } else {
            str = `${pStr}${start}-${dest}`;
        }
    }

    const row = document.createElement('div');
    row.className = 'history-row';
    row.innerText = `${moveCount}. ${str}`;
    historyList.appendChild(row);
    historyList.scrollTop = historyList.scrollHeight;
    moveCount++;
}

function executeMove(fromR, fromC, toR, toC, moveInfo, newBoard, nextTurn) {
    const movingPiece = board[fromR][fromC];
    const targetPiece = board[toR][toC];
    if (!movingPiece) return;

    if (movingPiece.includes('K')) hasMoved.wK = true;
    if (movingPiece.includes('k')) hasMoved.bK = true;
    if (movingPiece.includes('R') && fromR === 7 && fromC === 0) hasMoved.wR_left = true;
    if (movingPiece.includes('R') && fromR === 7 && fromC === 7) hasMoved.wR_right = true;
    if (movingPiece.includes('r') && fromR === 0 && fromC === 0) hasMoved.bR_left = true;
    if (movingPiece.includes('r') && fromR === 0 && fromC === 7) hasMoved.bR_right = true;

    if (movingPiece.some(p => p.toLowerCase().replace('_fused', '') === 'p') && Math.abs(toR - fromR) === 2) {
        enPassantTarget = { r: (fromR + toR) / 2, c: fromC, color: getPieceColor(movingPiece) };
    } else {
        enPassantTarget = null;
    }

    addMoveToHistory(fromR, fromC, toR, toC, movingPiece, targetPiece, moveInfo ? moveInfo.type : 'normal');

    board = newBoard;
    currentTurn = nextTurn;
    updateTurnDisplay();
    updateClockDisplay();
    renderFusionDots();
    renderBoard();
}

function renderBoard() {
    if (!isBoardDomCreated) return;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = boardEl.querySelector(`.square[data-r="${r}"][data-c="${c}"]`); if (!square) continue;
            
            square.classList.toggle('selected', !!(selectedSquare && selectedSquare.r === r && selectedSquare.c === c));
            
            let moveInfo = validMoves.find(m => m.r === r && m.c === c);
            square.classList.toggle('valid-move', !!(moveInfo && (moveInfo.type === 'normal' || moveInfo.type === 'castle')));
            square.classList.toggle('capture-move', !!(moveInfo && (moveInfo.type === 'capture' || moveInfo.type === 'en_passant')));
            square.classList.toggle('merge-move', !!(moveInfo && moveInfo.type === 'merge'));

            let pieceArr = board[r][c];
            let container = square.querySelector('.piece-container');
            let mainImg = square.querySelector('.piece-img.main');
            let overlayImg = square.querySelector('.piece-img.overlay');

            if (pieceArr && pieceArr.length > 0) {
                container.classList.remove('hidden');

                const isFusedQueen = pieceArr.some(p => p.includes('_fused'));
                container.classList.toggle('fused-piece-bg', isFusedQueen);

                if (pieceArr.length === 1) {
                    const pieceChar = pieceArr[0].replace('_fused', '');
                    mainImg.src = PIECES[pieceChar].img;
                    overlayImg.classList.add('hidden');
                } else if (pieceArr.length > 1) {
                    const hasKing = pieceArr.some(p => p.toLowerCase() === 'k');
                    let mainChar, overlayChar;

                    if (hasKing) {
                        mainChar = pieceArr.find(p => p.toLowerCase() === 'k');
                        overlayChar = pieceArr.find(p => p.toLowerCase() !== 'k');
                    } else {
                        mainChar = pieceArr[0];
                        overlayChar = pieceArr[1];
                    }

                    mainImg.src = PIECES[mainChar.replace('_fused', '')].img;
                    overlayImg.src = PIECES[overlayChar.replace('_fused', '')].img;
                    overlayImg.classList.remove('hidden');
                }
            } else {
                container.classList.add('hidden');
                container.classList.remove('fused-piece-bg');
            }
        }
    }
}
