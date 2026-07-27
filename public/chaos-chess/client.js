const socket = io('/chaos-chess');

let roomCode = null, playerColor = null;
let myName = 'Player', opponentName = 'Opponent';
let cardIntervalSetting = 6;

let board = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
];

let isGameStarted = false;
let currentTurn = 'w';
let selectedSquare = null;
let validMoves = [];
let pendingPromotion = null;

const PIECES = {
    'P': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg' },
    'R': { img: 'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg' },
    'N': { img: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg' },
    'B': { img: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg' },
    'Q': { img: 'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg' },
    'K': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg' },
    'p': { img: 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg' },
    'r': { img: 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg' },
    'n': { img: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg' },
    'b': { img: 'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg' },
    'q': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg' },
    'k': { img: 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg' }
};

// Intervall-Slider
const intervalRange = document.getElementById('card-interval-range');
if(intervalRange) {
    intervalRange.oninput = () => {
        document.getElementById('interval-val').innerText = intervalRange.value;
    };
}

document.getElementById('btn-create').onclick = () => {
    myName = document.getElementById('player-name').value || 'Player 1';
    cardIntervalSetting = parseInt(intervalRange.value) || 6;
    socket.emit('create_chaos_room', { playerName: myName, cardInterval: cardIntervalSetting });
};

document.getElementById('btn-join').onclick = () => {
    myName = document.getElementById('player-name').value || 'Player 2';
    const code = document.getElementById('room-code-input').value;
    socket.emit('join_chaos_room', { roomCode: code, playerName: myName });
};

document.getElementById('btn-ready').onclick = () => {
    socket.emit('player_ready', { roomCode });
    document.getElementById('btn-ready').disabled = true;
    document.getElementById('btn-ready').innerText = "WAITING...";
};

socket.on('chaos_room_created', (data) => {
    roomCode = data.roomCode; playerColor = data.color;
    document.getElementById('menu-screen').classList.add('hidden');
    document.getElementById('lobby-screen').classList.remove('hidden');
    document.getElementById('display-room-code').innerText = roomCode;
});

socket.on('chaos_room_joined', (data) => {
    roomCode = data.roomCode; playerColor = data.color;
    opponentName = data.opponentName;
    startGame();
});

socket.on('chaos_opponent_joined', (data) => {
    opponentName = data.opponentName;
    startGame();
});

socket.on('start_match', (data) => {
    isGameStarted = true;
    if(data && data.board) board = data.board;
    document.getElementById('btn-ready').classList.add('hidden');
    renderBoard();
});

socket.on('apply_chaos_move', (data) => {
    board = data.board;
    currentTurn = data.nextTurn;
    
    document.getElementById('turn-display-tag').innerText = currentTurn === playerColor ? "YOUR TURN" : "OPPONENT";
    document.getElementById('turn-display-tag').style.color = currentTurn === playerColor ? "#2ecc71" : "#e74c3c";

    // Progress Bar
    const interval = data.cardInterval || 6;
    const progressPct = Math.min(100, ((data.moveCount % interval) / interval) * 100);
    document.getElementById('chaos-progress-fill').style.width = `${progressPct}%`;

    // Aktiver Effekt Box
    updateActiveEffectUI(data.activeEffect);

    if (data.isGameOver) {
        alert("GAME OVER! Ein König wurde geschlagen!");
    }

    renderBoard();
});

// START DER KARTENAUSWAHL
socket.on('start_card_selection', ({ cards, duration }) => {
    const overlay = document.getElementById('card-selection-overlay');
    const container = document.getElementById('cards-container');
    container.innerHTML = '';

    cards.forEach((card, index) => {
        const cardEl = document.createElement('div');
        cardEl.className = 'rounds-card scribble-box';
        cardEl.innerHTML = `
            <div class="card-num">!${index + 1}</div>
            <div class="card-icon">${card.icon || '🃏'}</div>
            <div class="card-title">${card.name}</div>
            <div class="card-body">${card.description}</div>
            <div class="vote-bar"><div class="vote-fill" id="vote-fill-${index}" style="width:0%"></div></div>
        `;
        cardEl.onclick = () => {
            socket.emit('cast_vote', { roomCode, cardIndex: index });
            // Visuelles Feedback
            document.querySelectorAll('.rounds-card').forEach(c => c.style.borderColor = '#000');
            cardEl.style.borderColor = '#2ecc71';
        };
        container.appendChild(cardEl);
    });

    let timeLeft = duration || 30;
    document.getElementById('vote-timer').innerText = timeLeft;
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';

    const timerInterval = setInterval(() => {
        timeLeft--;
        document.getElementById('vote-timer').innerText = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            overlay.classList.add('hidden');
            overlay.style.display = 'none';
        }
    }, 1000);
});

socket.on('update_votes', ({ votesPct }) => {
    votesPct.forEach((pct, index) => {
        const fill = document.getElementById(`vote-fill-${index}`);
        if (fill) fill.style.width = `${pct}%`;
    });
});

socket.on('card_applied', ({ activeEffect }) => {
    document.getElementById('card-selection-overlay').classList.add('hidden');
    document.getElementById('card-selection-overlay').style.display = 'none';
    updateActiveEffectUI(activeEffect);
});

function updateActiveEffectUI(effect) {
    const cardBox = document.getElementById('active-card-box');
    if (effect) {
        cardBox.style.display = 'block';
        document.getElementById('card-name').innerText = "🔥 " + effect.name;
        document.getElementById('card-desc').innerText = effect.description;
        document.getElementById('card-turns').innerText = `Gilt noch für: ${effect.turnsLeft} Züge`;
    } else {
        cardBox.style.display = 'none';
    }
}

// CLIENT-SIDE SCHACH-VALIDIERUNG FÜR HIGHLIGHTS
function isEnemy(p1, p2) {
    if (!p1 || !p2) return false;
    return (p1 === p1.toUpperCase()) !== (p2 === p2.toUpperCase());
}

function getValidMoves(r, c) {
    let piece = board[r][c];
    if (!piece) return [];
    let moves = [];
    let color = piece === piece.toUpperCase() ? 'w' : 'b';
    if (color !== playerColor || currentTurn !== playerColor) return [];

    let dir = color === 'w' ? -1 : 1;
    let startRow = color === 'w' ? 6 : 1;

    const addSliding = (dirs) => {
        for (let [dr, dc] of dirs) {
            let nr = r + dr, nc = c + dc;
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                else {
                    if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' });
                    break;
                }
                nr += dr; nc += dc;
            }
        }
    };

    switch (piece.toLowerCase()) {
        case 'p':
            if (r + dir >= 0 && r + dir < 8 && !board[r + dir][c]) {
                moves.push({ r: r + dir, c, type: 'normal' });
                if (r === startRow && !board[r + dir * 2][c]) moves.push({ r: r + dir * 2, c, type: 'normal' });
            }
            for (let dc of [-1, 1]) {
                let targetR = r + dir, targetC = c + dc;
                if (targetR >= 0 && targetR < 8 && targetC >= 0 && targetC < 8) {
                    if (board[targetR][targetC] && isEnemy(piece, board[targetR][targetC])) moves.push({ r: targetR, c: targetC, type: 'capture' });
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
            for (let [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                let nr = r + dr, nc = c + dc;
                if (nr>=0 && nr<8 && nc>=0 && nc<8) {
                    if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                    else if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' });
                }
            }
            break;
    }
    return moves;
}

function handleSquareClick(r, c) {
    if (!isGameStarted || currentTurn !== playerColor || pendingPromotion) return;

    const clickedPiece = board[r]?.[c];

    if (selectedSquare) {
        let moveInfo = validMoves.find(m => m.r === r && m.c === c);
        if (moveInfo) {
            let movingPiece = board[selectedSquare.r][selectedSquare.c];
            if (movingPiece && movingPiece.toLowerCase() === 'p' && (r === 0 || r === 7)) {
                triggerPromotion(selectedSquare.r, selectedSquare.c, r, c, moveInfo);
                return;
            }

            socket.emit('request_chaos_move', {
                roomCode,
                fromR: selectedSquare.r,
                fromC: selectedSquare.c,
                toR: r,
                toC: c,
                moveInfo
            });
            selectedSquare = null;
            validMoves = [];
            renderBoard();
            return;
        }
    }

    if (clickedPiece) {
        const isMyPiece = (clickedPiece === clickedPiece.toUpperCase() ? 'w' : 'b') === playerColor;
        if (isMyPiece) {
            selectedSquare = { r, c };
            validMoves = getValidMoves(r, c);
            renderBoard();
            return;
        }
    }

    selectedSquare = null;
    validMoves = [];
    renderBoard();
}

function triggerPromotion(fromR, fromC, toR, toC, moveInfo) {
    pendingPromotion = { fromR, fromC, toR, toC, moveInfo };
    let modal = document.getElementById('promotion-modal'), box = document.getElementById('promo-options');
    box.innerHTML = '';
    
    (playerColor === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b']).forEach(p => {
        let img = document.createElement('img');
        img.className = 'promo-piece';
        img.src = PIECES[p].img;
        img.onclick = () => {
            modal.style.display = 'none';
            pendingPromotion = null;
            socket.emit('request_chaos_move', {
                roomCode, fromR, fromC, toR, toC, moveInfo, promotedTo: p
            });
            selectedSquare = null;
            validMoves = [];
            renderBoard();
        };
        box.appendChild(img);
    });
    modal.style.display = 'flex';
}

function startGame() {
    document.getElementById('menu-screen').classList.add('hidden');
    document.getElementById('lobby-screen').classList.add('hidden');
    document.getElementById('game-screen').classList.remove('hidden');
    
    document.getElementById('bottom-player-name').innerText = myName + " (You)";
    document.getElementById('top-player-name').innerText = opponentName;

    createBoardDOM();
    renderBoard();
}

function createBoardDOM() {
    const boardEl = document.getElementById('board');
    boardEl.innerHTML = '';
    if (playerColor === 'b') boardEl.classList.add('flipped');

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = document.createElement('div');
            square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
            square.dataset.r = r; square.dataset.c = c;
            
            const img = document.createElement('img');
            img.className = 'piece hidden';
            square.appendChild(img);
            
            square.onclick = () => handleSquareClick(r, c);
            boardEl.appendChild(square);
        }
    }
}

function renderBoard() {
    const boardEl = document.getElementById('board');
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = boardEl.querySelector(`.square[data-r="${r}"][data-c="${c}"]`);
            if (!square) continue;
            
            const piece = board[r]?.[c];
            const img = square.querySelector('.piece');
            
            square.classList.toggle('selected', !!(selectedSquare && selectedSquare.r === r && selectedSquare.c === c));

            let moveInfo = validMoves.find(m => m.r === r && m.c === c);
            square.classList.toggle('valid-move', !!(moveInfo && moveInfo.type === 'normal'));
            square.classList.toggle('capture-move', !!(moveInfo && moveInfo.type === 'capture'));

            if (piece) {
                img.src = PIECES[piece].img;
                img.classList.remove('hidden');
            } else {
                img.classList.add('hidden');
            }
        }
    }
}
