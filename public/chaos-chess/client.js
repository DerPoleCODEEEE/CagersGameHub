const socket = io('/chaos-chess');

let roomCode = null, playerColor = null;
let myName = 'Player', opponentName = 'Opponent';

// Standard-Startaufstellung für sofortiges Rendering
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

document.getElementById('btn-create').onclick = () => {
    myName = document.getElementById('player-name').value || 'Player 1';
    socket.emit('create_chaos_room', { playerName: myName });
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

socket.on('start_match', () => {
    isGameStarted = true;
    document.getElementById('btn-ready').classList.add('hidden');
    renderBoard();
});

socket.on('apply_chaos_move', (data) => {
    board = data.board;
    currentTurn = data.nextTurn;
    
    document.getElementById('turn-display-tag').innerText = currentTurn === playerColor ? "YOUR TURN" : "OPPONENT";
    document.getElementById('turn-display-tag').style.color = currentTurn === playerColor ? "#2ecc71" : "#e74c3c";

    const progressPct = Math.min(100, ((data.moveCount % 6) / 6) * 100);
    document.getElementById('chaos-progress-fill').style.width = `${progressPct}%`;

    const cardBox = document.getElementById('active-card-box');
    if (data.activeEffect) {
        cardBox.style.display = 'block';
        document.getElementById('card-name').innerText = "🔥 " + data.activeEffect.name;
        document.getElementById('card-desc').innerText = data.activeEffect.description;
        document.getElementById('card-turns').innerText = `Gilt noch für: ${data.activeEffect.turnsLeft} Züge`;
    } else {
        cardBox.style.display = 'none';
    }

    renderBoard();
});

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
        };
        container.appendChild(cardEl);
    });

    let timeLeft = duration || 30;
    document.getElementById('vote-timer').innerText = timeLeft;
    overlay.classList.remove('hidden');

    const timerInterval = setInterval(() => {
        timeLeft--;
        document.getElementById('vote-timer').innerText = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            overlay.classList.add('hidden');
        }
    }, 1000);
});

socket.on('update_votes', ({ votesPct }) => {
    votesPct.forEach((pct, index) => {
        const fill = document.getElementById(`vote-fill-${index}`);
        if (fill) fill.style.width = `${pct}%`;
    });
});

function handleSquareClick(r, c) {
    if (!isGameStarted || currentTurn !== playerColor) return;

    const clickedPiece = board[r]?.[c];
    
    if (selectedSquare) {
        socket.emit('request_chaos_move', {
            roomCode,
            fromR: selectedSquare.r,
            fromC: selectedSquare.c,
            toR: r,
            toC: c
        });
        selectedSquare = null;
        renderBoard();
    } else if (clickedPiece) {
        const isMyPiece = (clickedPiece === clickedPiece.toUpperCase() ? 'w' : 'b') === playerColor;
        if (isMyPiece) {
            selectedSquare = { r, c };
            renderBoard();
        }
    }
}

function startGame() {
    document.getElementById('menu-screen').classList.add('hidden');
    document.getElementById('lobby-screen').classList.add('hidden');
    document.getElementById('game-screen').classList.remove('hidden');
    
    document.getElementById('bottom-player-name').innerText = myName + " (You)";
    document.getElementById('top-player-name').innerText = opponentName;

    createBoardDOM();
    renderBoard(); // Rendert Figuren direkt beim Aufruf!
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
            
            square.classList.toggle('selected', selectedSquare && selectedSquare.r === r && selectedSquare.c === c);

            if (piece) {
                img.src = PIECES[piece].img;
                img.classList.remove('hidden');
            } else {
                img.classList.add('hidden');
            }
        }
    }
}
