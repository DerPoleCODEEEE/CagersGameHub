const socket = io('/mutant-chess');

// UI STATUS & RECONNECT LOGIK
function updateUIConnectionStatus(status) {
    const indicator = document.getElementById('status-indicator');
    const gameBoard = document.getElementById('board-wrapper');
    const splash = document.getElementById('splash-screen');
    
    if (status === 'online') {
        if (indicator) { indicator.className = 'status-online'; indicator.innerText = 'Verbunden'; }
        if (gameBoard) gameBoard.classList.remove('disabled-ui');
        if (splash) splash.style.display = 'none';
    } else {
        if (indicator) { indicator.className = 'status-offline'; indicator.innerText = 'Verbindung verloren... Reconnect...'; }
        if (gameBoard) gameBoard.classList.add('disabled-ui');
    }
}

socket.on('connect', () => { updateUIConnectionStatus('online'); });
socket.on('disconnect', () => { updateUIConnectionStatus('offline'); });

// TWITCH DATEN ABRUFEN
const twitchName = localStorage.getItem('cager_twitch_name');
const twitchPfp = localStorage.getItem('cager_twitch_pfp') || '';

if (twitchName && twitchName !== 'undefined' && twitchName !== 'null') {
    document.getElementById('player-name').value = twitchName;
    document.getElementById('player-name').disabled = true;
}

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

let roomCode = null, playerId = null, playerColor = null;
let myName = '', opponentName = '', opponentPfp = '';
let selectedSquare = null, opponentSelectedSquare = null;
let validMoves = [], isGameOver = false, isBoardDomCreated = false;
let currentTurn = 'w';

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
const boardEl = document.getElementById('board'), animationLayer = document.getElementById('animation-layer');
const btnReady = document.getElementById('btn-ready'), statusBanner = document.getElementById('status-banner');
const statusBannerText = document.getElementById('status-banner-text');

function getPieceColor(pieceArr) {
    if (!pieceArr || !pieceArr.length) return null;
    return pieceArr[0] === pieceArr[0].toUpperCase() ? 'w' : 'b';
}

function getVisualCoords(r, c) {
    const rect = boardEl.getBoundingClientRect();
    const squareSize = rect.width / 8;
    return playerColor === 'b' ? { x: (7 - c) * squareSize, y: (7 - r) * squareSize } : { x: c * squareSize, y: r * squareSize };
}

document.getElementById('btn-create').onclick = () => {
    myName = document.getElementById('player-name').value.trim() || 'Player 1';
    socket.emit('create_mutant_room', { playerName: myName, pfp: twitchPfp });
};

document.getElementById('btn-join').onclick = () => {
    myName = document.getElementById('player-name').value.trim() || 'Player 2';
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) return showError('Bitte Code eingeben!');
    socket.emit('join_mutant_room', { roomCode: code, playerName: myName, pfp: twitchPfp });
};

document.getElementById('btn-leave-lobby').onclick = leaveGame;
document.getElementById('btn-leave-game').onclick = leaveGame;

btnReady.onclick = () => {
    socket.emit('player_ready', { roomCode, playerId });
    btnReady.innerText = 'READY!'; btnReady.classList.add('is-ready'); btnReady.disabled = true;
};

function leaveGame() { location.reload(); }
function showError(msg) { errorMsg.innerText = msg; }

boardEl.addEventListener('mousemove', (e) => {
    if (!roomCode || isGameOver) return;
    const rect = boardEl.getBoundingClientRect();
    let xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    let yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    socket.emit('mouse_move', { roomCode, xPct: playerColor === 'b' ? (100 - xPct) : xPct, yPct: playerColor === 'b' ? (100 - yPct) : yPct });
});

boardEl.addEventListener('mouseleave', () => { if (roomCode) socket.emit('mouse_leave', { roomCode }); });

socket.on('opponent_mouse_move', ({ xPct, yPct }) => {
    const oppCursor = document.getElementById('opponent-cursor'); oppCursor.classList.remove('hidden');
    oppCursor.style.left = `${playerColor === 'b' ? (100 - xPct) : xPct}%`;
    oppCursor.style.top = `${playerColor === 'b' ? (100 - yPct) : yPct}%`;
    document.getElementById('opponent-cursor-name').innerText = opponentName || 'Opponent';
});

socket.on('opponent_mouse_leave', () => document.getElementById('opponent-cursor').classList.add('hidden'));
socket.on('opponent_select_square', ({ r, c }) => { opponentSelectedSquare = (r !== null) ? { r, c } : null; renderBoard(); });

socket.on('mutant_room_created', (data) => {
    roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color;
    menuScreen.classList.add('hidden'); lobbyScreen.classList.remove('hidden');
    document.getElementById('display-room-code').innerText = roomCode;
});

socket.on('mutant_room_joined', (data) => {
    roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color;
    opponentName = data.opponentName; opponentPfp = data.opponentPfp;
    startGame();
});

socket.on('mutant_opponent_joined', (data) => { 
    opponentName = data.opponentName; opponentPfp = data.opponentPfp; 
    startGame(); 
});

socket.on('ready_update', ({ playersReady }) => {
    playersReady.forEach(p => {
        const badgeEl = document.getElementById(p.color === playerColor ? 'bottom-ready-badge' : 'top-ready-badge');
        if (p.ready) { badgeEl.innerText = 'READY'; badgeEl.classList.add('ready'); }
    });
});

socket.on('start_match', (data) => {
    board = data.board;
    currentTurn = data.turn;
    updateTurnDisplay();
    statusBanner.classList.remove('hidden');
    statusBannerText.innerText = `BATTLE STARTED!`; 
    setTimeout(() => statusBanner.classList.add('hidden'), 1800);
});

socket.on('apply_mutant_move', (moveData) => {
    if (moveData.playerId !== playerId) opponentSelectedSquare = null;
    executeMove(moveData.fromR, moveData.fromC, moveData.toR, moveData.toC, moveData.moveInfo, moveData.duration, moveData.board, moveData.nextTurn);
});

socket.on('game_over', ({ winnerColor }) => {
    isGameOver = true;
    document.getElementById('winner-text').innerText = (winnerColor === playerColor ? 'Du hast gewonnen!' : 'Gegner hat gewonnen!');
    document.getElementById('game-over').style.display = 'flex';
});

socket.on('error_msg', (msg) => showError(msg));

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
    createBoardDOMOnce(); renderBoard(); updateTurnDisplay();
}

function updateTurnDisplay() {
    const turnTag = document.getElementById('turn-display-tag');
    if (currentTurn === playerColor) {
        turnTag.innerText = "DEIN ZUG!";
        turnTag.style.color = "#2ecc71";
    } else {
        turnTag.innerText = "GEGNER ZIEHT...";
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
            container.appendChild(mainImg);

            const overlayImg = document.createElement('img');
            overlayImg.className = 'piece-img overlay hidden';
            container.appendChild(overlayImg);

            square.appendChild(container);
            square.onclick = () => handleSquareClick(r, c);
            boardEl.appendChild(square);
        }
    }
    isBoardDomCreated = true;
}

function calculateMoveDuration(fR, fC, tR, tC) {
    return Math.round(200 + Math.sqrt((tR-fR)**2 + (tC-fC)**2) * 180);
}

// FUSIONS- UND MUTANTEN ZUG-BERECHNUNG
function getValidMoves(r, c) {
    const pieceArr = board[r][c];
    if (!pieceArr) return [];

    const pColor = getPieceColor(pieceArr);
    if (pColor !== playerColor || currentTurn !== playerColor) return [];

    let moves = [];

    pieceArr.forEach(typeChar => {
        const charLower = typeChar.toLowerCase();
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
                        } else if (pieceArr.length + target.length <= 2) {
                            moves.push({ r: nr, c: nc, type: 'merge' });
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
                            if (getPieceColor(target) !== pColor) moves.push({ r: targetR, c: targetC, type: 'capture' });
                            else if (pieceArr.length + target.length <= 2) moves.push({ r: targetR, c: targetC, type: 'merge' });
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
                        if (!target) moves.push({ r: nr, c: nc, type: 'normal' });
                        else if (getPieceColor(target) !== pColor) moves.push({ r: nr, c: nc, type: 'capture' });
                        else if (pieceArr.length + target.length <= 2) moves.push({ r: nr, c: nc, type: 'merge' });
                    }
                }
                break;

            case 'k':
                for (let [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                    let nr = r + dr, nc = c + dc;
                    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                        const target = board[nr][nc];
                        if (!target) moves.push({ r: nr, c: nc, type: 'normal' });
                        else if (getPieceColor(target) !== pColor) moves.push({ r: nr, c: nc, type: 'capture' });
                        else if (pieceArr.length + target.length <= 2) moves.push({ r: nr, c: nc, type: 'merge' });
                    }
                }
                break;
        }
    });

    // Duplikate filtern (falls Figur 2 den gleichen Zug wie Figur 1 ermöglicht)
    const uniqueMap = new Map();
    moves.forEach(m => uniqueMap.set(`${m.r}-${m.c}`, m));
    return Array.from(uniqueMap.values());
}

function handleSquareClick(r, c) {
    if (isGameOver || currentTurn !== playerColor) return;
    const clickedPiece = board[r][c];

    if (selectedSquare) {
        let moveInfo = validMoves.find(m => m.r === r && m.c === c);
        if (moveInfo) {
            const duration = calculateMoveDuration(selectedSquare.r, selectedSquare.c, r, c);
            socket.emit('request_mutant_move', {
                roomCode, playerId, fromR: selectedSquare.r, fromC: selectedSquare.c, toR: r, toC: c, moveInfo, duration
            });
            selectedSquare = null; validMoves = []; socket.emit('select_square', { roomCode, r: null, c: null }); renderBoard(); return;
        }
    }

    if (clickedPiece && getPieceColor(clickedPiece) === playerColor) {
        selectedSquare = { r, c };
        validMoves = getValidMoves(r, c);
        socket.emit('select_square', { roomCode, r, c });
        renderBoard();
        return;
    }

    selectedSquare = null; validMoves = []; socket.emit('select_square', { roomCode, r: null, c: null }); renderBoard();
}

function executeMove(fromR, fromC, toR, toC, moveInfo, duration, newBoard, nextTurn) {
    const movingPiece = board[fromR][fromC];
    if (!movingPiece) return;

    const startCoords = getVisualCoords(fromR, fromC), targetCoords = getVisualCoords(toR, toC);
    
    board[fromR][fromC] = null;
    renderBoard();

    const wrapper = document.createElement('div'); wrapper.className = 'animating-wrapper';
    wrapper.style.left = `${startCoords.x}px`; wrapper.style.top = `${startCoords.y}px`; wrapper.style.transitionDuration = `${duration}ms`;
    wrapper.style.width = `${boardEl.getBoundingClientRect().width / 8}px`;
    wrapper.style.height = `${boardEl.getBoundingClientRect().width / 8}px`;

    const animImg = document.createElement('img'); animImg.className = 'piece-img'; animImg.src = PIECES[movingPiece[0]].img; wrapper.appendChild(animImg);
    animationLayer.appendChild(wrapper);

    requestAnimationFrame(() => wrapper.style.transform = `translate(${targetCoords.x - startCoords.x}px, ${targetCoords.y - startCoords.y}px)`);

    setTimeout(() => {
        if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
        board = newBoard;
        currentTurn = nextTurn;
        updateTurnDisplay();
        renderBoard();
    }, duration);
}

function renderBoard() {
    if (!isBoardDomCreated) return;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = boardEl.querySelector(`.square[data-r="${r}"][data-c="${c}"]`); if (!square) continue;
            
            square.classList.toggle('selected', !!(selectedSquare && selectedSquare.r === r && selectedSquare.c === c));
            square.classList.toggle('opponent-selected', !!(opponentSelectedSquare && opponentSelectedSquare.r === r && opponentSelectedSquare.c === c));
            
            let moveInfo = validMoves.find(m => m.r === r && m.c === c);
            square.classList.toggle('valid-move', !!(moveInfo && moveInfo.type === 'normal'));
            square.classList.toggle('capture-move', !!(moveInfo && moveInfo.type === 'capture'));
            square.classList.toggle('merge-move', !!(moveInfo && moveInfo.type === 'merge'));

            let pieceArr = board[r][c];
            let container = square.querySelector('.piece-container');
            let mainImg = square.querySelector('.piece-img.main');
            let overlayImg = square.querySelector('.piece-img.overlay');

            if (pieceArr && pieceArr.length > 0) {
                container.classList.remove('hidden');
                mainImg.src = PIECES[pieceArr[0]].img;
                
                if (pieceArr.length > 1) {
                    overlayImg.src = PIECES[pieceArr[1]].img;
                    overlayImg.classList.remove('hidden');
                } else {
                    overlayImg.classList.add('hidden');
                }
            } else {
                container.classList.add('hidden');
            }
        }
    }
}
