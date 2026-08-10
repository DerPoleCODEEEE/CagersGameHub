const socket = io();

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

// UI STATUS UND RECONNECT LOGIK
function updateUIConnectionStatus(status) {
    const indicator = document.getElementById('status-indicator');
    const gameBoard = document.getElementById('board-wrapper');
    const splash = document.getElementById('splash-screen');
    
    if (status === 'online') {
        if (indicator) {
            indicator.className = 'status-online';
            indicator.innerText = 'Verbunden';
        }
        if (gameBoard) gameBoard.classList.remove('disabled-ui');
        if (splash) splash.style.display = 'none';
    } else {
        if (indicator) {
            indicator.className = 'status-offline';
            indicator.innerText = 'Verbindung verloren... Reconnect...';
        }
        if (gameBoard) gameBoard.classList.add('disabled-ui');
    }
}

function getSavedSession() {
    try {
        const data = sessionStorage.getItem('quick_chess_session');
        return data ? JSON.parse(data) : null;
    } catch(e) { return null; }
}

function saveSession() {
    if (!roomCode || !playerId || !playerColor) return;
    sessionStorage.setItem('quick_chess_session', JSON.stringify({
        roomCode, playerId, playerColor, gameMode, myName, opponentName, opponentPfp
    }));
}

function clearSession() {
    sessionStorage.removeItem('quick_chess_session');
}

socket.on('connect', () => {
    updateUIConnectionStatus('online');
    const saved = getSavedSession();
    if (saved && saved.roomCode && saved.playerId && saved.playerColor) {
        socket.emit('reconnect_room', {
            roomCode: saved.roomCode,
            playerId: saved.playerId,
            playerColor: saved.playerColor
        });
    }
});

socket.on('disconnect', () => {
    updateUIConnectionStatus('offline');
});

// TWITCH DATEN ABRUFEN
const twitchName = localStorage.getItem('cager_twitch_name');
const twitchPfp = localStorage.getItem('cager_twitch_pfp') || '';

if (twitchName) {
    document.getElementById('player-name').value = twitchName;
    document.getElementById('player-name').disabled = true;
}

const INITIAL_BOARD = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
];

let roomCode = null, playerId = null, playerColor = null, gameMode = 'class';
let myName = '', opponentName = '', opponentPfp = '';
let selectedSquare = null, opponentSelectedSquare = null;
let validMoves = [], isGameOver = false, pendingPromotion = null, enPassantTarget = null, isBoardDomCreated = false;
let isGameStarted = false;

const PIECES = {
    'P': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg', color: 'w', cd: 3500 },
    'N': { img: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg', color: 'w', cd: 6500 },
    'B': { img: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg', color: 'w', cd: 6500 },
    'R': { img: 'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg', color: 'w', cd: 10000 },
    'Q': { img: 'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg', color: 'w', cd: 14000 },
    'K': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg', color: 'w', cd: 1000 },
    'p': { img: 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg', color: 'b', cd: 3500 },
    'n': { img: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg', color: 'b', cd: 6500 },
    'b': { img: 'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg', color: 'b', cd: 6500 },
    'r': { img: 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg', color: 'b', cd: 10000 },
    'q': { img: 'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg', color: 'b', cd: 14000 },
    'k': { img: 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg', color: 'b', cd: 1000 }
};

let board = JSON.parse(JSON.stringify(INITIAL_BOARD));
let typeCooldowns = { 'w': { 'p':0,'n':0,'b':0,'r':0,'q':0,'k':0 }, 'b': { 'p':0,'n':0,'b':0,'r':0,'q':0,'k':0 } };
let typeCooldownMax = { 'w': { 'p':3500,'n':6500,'b':6500,'r':10000,'q':14000,'k':1000 }, 'b': { 'p':3500,'n':6500,'b':6500,'r':10000,'q':14000,'k':1000 } };
let singleCooldowns = Array(8).fill(null).map(() => Array(8).fill(0));
let singleCooldownMax = Array(8).fill(null).map(() => Array(8).fill(3500));
let hasMoved = { 'wK': false, 'wR_left': false, 'wR_right': false, 'bK': false, 'bR_left': false, 'bR_right': false };

const menuScreen = document.getElementById('menu-screen'), lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen'), errorMsg = document.getElementById('error-msg');
const boardEl = document.getElementById('board'), animationLayer = document.getElementById('animation-layer');
const btnReady = document.getElementById('btn-ready'), statusBanner = document.getElementById('status-banner');
const statusBannerText = document.getElementById('status-banner-text');

function getVisualCoords(r, c) {
    const rect = boardEl.getBoundingClientRect();
    const squareSize = rect.width / 8;
    return playerColor === 'b' ? { x: (7 - c) * squareSize, y: (7 - r) * squareSize } : { x: c * squareSize, y: r * squareSize };
}

document.getElementById('btn-create').onclick = () => {
    myName = document.getElementById('player-name').value.trim() || 'Player 1';
    socket.emit('create_room', { playerName: myName, mode: document.getElementById('game-mode').value, pfp: twitchPfp });
};

document.getElementById('btn-join').onclick = () => {
    myName = document.getElementById('player-name').value.trim() || 'Player 2';
    const code = document.getElementById('room-code-input').value.trim();
    if (!code) return showError('Enter code!');
    socket.emit('join_room', { roomCode: code, playerName: myName, pfp: twitchPfp });
};

document.getElementById('btn-leave-lobby').onclick = leaveGame;
document.getElementById('btn-leave-game').onclick = leaveGame;

btnReady.onclick = () => {
    socket.emit('player_ready', { roomCode, playerId });
    btnReady.innerText = 'READY!'; btnReady.classList.add('is-ready'); btnReady.disabled = true;
};

function leaveGame() { clearSession(); location.reload(); }
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

socket.on('room_created', (data) => {
    roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color; gameMode = data.mode;
    saveSession();
    menuScreen.classList.add('hidden'); lobbyScreen.classList.remove('hidden');
    document.getElementById('display-room-code').innerText = roomCode;
});

socket.on('room_joined', (data) => {
    roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color; gameMode = data.mode; 
    opponentName = data.opponentName; opponentPfp = data.opponentPfp;
    saveSession();
    startGame();
});

socket.on('room_reconnected', (data) => {
    roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color; gameMode = data.mode;
    board = data.board;
    if (data.typeCooldowns) typeCooldowns = data.typeCooldowns;
    if (data.singleCooldowns) singleCooldowns = data.singleCooldowns;
    isGameStarted = data.isGameStarted;
    isGameOver = data.isGameOver;
    opponentName = data.opponentName || opponentName;
    opponentPfp = data.opponentPfp || opponentPfp;

    saveSession();
    startGame();

    if (data.playersReady) {
        data.playersReady.forEach(p => {
            const badgeEl = document.getElementById(p.color === playerColor ? 'bottom-ready-badge' : 'top-ready-badge');
            if (p.ready && badgeEl) { badgeEl.innerText = 'READY'; badgeEl.classList.add('ready'); }
        });
    }

    if (isGameStarted) {
        btnReady.innerText = 'READY!'; btnReady.classList.add('is-ready'); btnReady.disabled = true;
    }
});

socket.on('opponent_joined', (data) => { 
    opponentName = data.opponentName; opponentPfp = data.opponentPfp;
    saveSession();
    startGame(); 
});

socket.on('opponent_disconnected', () => {
    statusBanner.classList.remove('hidden');
    statusBannerText.innerText = "Opponent disconnected! Forfeit in 30s...";
});

socket.on('opponent_reconnected', () => {
    statusBanner.classList.remove('hidden');
    statusBannerText.innerText = "Opponent reconnected!";
    setTimeout(() => { if (!isGameOver) statusBanner.classList.add('hidden'); }, 2000);
});

socket.on('game_over', ({ winnerColor, reason }) => {
    isGameOver = true;
    clearSession();
    const isWin = (winnerColor === playerColor);
    saveGameResult('chess', isWin ? 'win' : (winnerColor === null ? 'draw' : 'loss'));

    let text = "";
    if (winnerColor === null) text = "Draw!";
    else if (isWin) text = reason === 'disconnect' ? "Victory! Opponent failed to reconnect!" : "Victory! Enemy King captured!";
    else text = reason === 'disconnect' ? "Defeat by Disconnect!" : "Defeat! Your King was captured!";

    document.getElementById('winner-text').innerText = text;
    document.getElementById('game-over').style.display = 'flex';
});

socket.on('ready_update', ({ playersReady }) => {
    playersReady.forEach(p => {
        const badgeEl = document.getElementById(p.color === playerColor ? 'bottom-ready-badge' : 'top-ready-badge');
        if (p.ready && badgeEl) { badgeEl.innerText = 'READY'; badgeEl.classList.add('ready'); }
    });
});

socket.on('start_match_countdown', (data) => {
    if (gameMode === 'class') typeCooldowns = data.typeCooldowns;
    else singleCooldowns = data.singleCooldowns;

    isGameStarted = false;
    statusBanner.classList.remove('hidden'); let s = 10;
    statusBannerText.innerText = `Match Starting in ${s}s!`;
    const interval = setInterval(() => {
        s--;
        if (s > 0) {
            statusBannerText.innerText = `Match Starting in ${s}s!`;
        } else { 
            clearInterval(interval); 
            isGameStarted = true;
            statusBanner.classList.add('hidden');
        }
    }, 1000);
});

socket.on('apply_move', (moveData) => {
    if (moveData.playerId !== playerId) opponentSelectedSquare = null;
    executeMove(moveData.fromR, moveData.fromC, moveData.toR, moveData.toC, moveData.moveInfo, moveData.promotedTo, moveData.duration);
});

socket.on('error_msg', (msg) => showError(msg));

function startGame() {
    menuScreen.classList.add('hidden'); lobbyScreen.classList.add('hidden'); gameScreen.classList.remove('hidden');
    
    document.getElementById('my-role-tag').innerText = playerColor === 'w' ? 'WHITE' : 'BLACK';
    let modeText = 'CLASS LOCK';
    if (gameMode === 'single') modeText = 'SINGLE PIECE';
    if (gameMode === 'fast_single') modeText = 'BLITZ (2S ALL)';
    document.getElementById('mode-display-tag').innerText = modeText;
    
    if (gameMode === 'fast_single') {
        ['lg-k-val', 'lg-p-val', 'lg-n-val', 'lg-r-val', 'lg-q-val'].forEach(id => {
            const el = document.getElementById(id); if (el) { el.innerText = '2.0s'; el.className = 'time fast'; }
        });
    }
    
    document.getElementById('bottom-player-name').innerText = myName + ' (You)';
    document.getElementById('top-player-name').innerText = opponentName || 'Opponent';
    
    const bottomPfpEl = document.getElementById('bottom-pfp');
    if (twitchPfp) { bottomPfpEl.src = twitchPfp; bottomPfpEl.classList.remove('hidden'); }
    
    const topPfpEl = document.getElementById('top-pfp');
    if (opponentPfp) { topPfpEl.src = opponentPfp; topPfpEl.classList.remove('hidden'); }

    if (playerColor === 'b') boardEl.classList.add('flipped');
    createBoardDOMOnce(); renderBoard(); requestAnimationFrame(updateCooldowns);
}

function createBoardDOMOnce() {
    if (isBoardDomCreated) return;
    boardEl.innerHTML = '';
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = document.createElement('div');
            square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
            square.dataset.r = r; square.dataset.c = c;
            const pieceImg = document.createElement('img'); pieceImg.className = 'piece hidden'; square.appendChild(pieceImg);
            const cdBar = document.createElement('div'); cdBar.className = 'cd-bar'; cdBar.id = `cd-${r}-${c}`; square.appendChild(cdBar);
            square.onclick = () => handleSquareClick(r, c);
            boardEl.appendChild(square);
        }
    }
    isBoardDomCreated = true;
}

function isEnemy(p1, p2) { return p1 && p2 && PIECES[p1].color !== PIECES[p2].color; }
function calculateMoveDuration(fR, fC, tR, tC) { return Math.round(250 + Math.sqrt((tR-fR)**2 + (tC-fC)**2) * 250); }

function getValidMoves(r, c) {
    let piece = board[r][c]; if (!piece) return [];
    let moves = [], info = PIECES[piece], dir = info.color === 'w' ? -1 : 1, startRow = info.color === 'w' ? 6 : 1;
    const addSliding = (dirs) => {
        for (let [dr, dc] of dirs) {
            let nr = r + dr, nc = c + dc;
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                else { if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' }); break; }
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
                    else if (enPassantTarget && enPassantTarget.color !== info.color && enPassantTarget.r === targetR && enPassantTarget.c === targetC) moves.push({ r: targetR, c: targetC, type: 'en_passant' });
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
            let kRow = info.color === 'w' ? 7 : 0, kKey = info.color === 'w' ? 'wK' : 'bK', rookChar = info.color === 'w' ? 'R' : 'r';
            if (r === kRow && c === 4 && !hasMoved[kKey]) {
                let rRight = info.color === 'w' ? 'wR_right' : 'bR_right';
                if (!hasMoved[rRight] && board[kRow][7] === rookChar && !board[kRow][5] && !board[kRow][6]) moves.push({ r: kRow, c: 6, type: 'castle' });
                let rLeft = info.color === 'w' ? 'wR_left' : 'bR_left';
                if (!hasMoved[rLeft] && board[kRow][0] === rookChar && !board[kRow][3] && !board[kRow][2] && !board[kRow][1]) moves.push({ r: kRow, c: 2, type: 'castle' });
            }
            break;
    }
    return moves;
}

function handleSquareClick(r, c) {
    if (!isGameStarted || isGameOver || pendingPromotion) return;
    const now = Date.now(), clickedPiece = board[r][c];
    if (selectedSquare) {
        let currentPiece = board[selectedSquare.r][selectedSquare.c];
        if (!currentPiece || PIECES[currentPiece].color !== playerColor) { selectedSquare = null; validMoves = []; }
    }
    if (selectedSquare) {
        let moveInfo = validMoves.find(m => m.r === r && m.c === c);
        if (moveInfo) {
            let piece = board[selectedSquare.r][selectedSquare.c];
            if (piece && piece.toLowerCase() === 'p' && (r === 0 || r === 7)) { triggerPromotion(selectedSquare.r, selectedSquare.c, r, c, PIECES[piece].color); return; }
            const duration = calculateMoveDuration(selectedSquare.r, selectedSquare.c, r, c);
            socket.emit('request_move', { roomCode, playerId, fromR: selectedSquare.r, fromC: selectedSquare.c, toR: r, toC: c, moveInfo, promotedTo: null, duration });
            selectedSquare = null; validMoves = []; socket.emit('select_square', { roomCode, r: null, c: null }); renderBoard(); return;
        }
    }
    if (clickedPiece && PIECES[clickedPiece].color === playerColor) {
        let pieceKey = clickedPiece.toLowerCase(), isOnCooldown = gameMode === 'class' ? (typeCooldowns[playerColor][pieceKey] > now) : (singleCooldowns[r][c] > now);
        if (!isOnCooldown) { selectedSquare = { r, c }; validMoves = getValidMoves(r, c); socket.emit('select_square', { roomCode, r, c }); renderBoard(); return; }
    }
    selectedSquare = null; validMoves = []; socket.emit('select_square', { roomCode, r: null, c: null }); renderBoard();
}

function executeMove(fromR, fromC, toR, toC, moveInfo, promotedTo = null, duration = 500) {
    let piece = board[fromR][fromC]; if (!piece) return;
    let pieceChar = promotedTo || piece, color = PIECES[piece].color, finalKey = pieceChar.toLowerCase();
    let cdDuration = gameMode === 'fast_single' ? 2000 : PIECES[pieceChar].cd, cdEndTime = Date.now() + cdDuration;

    if (piece === 'K') hasMoved['wK'] = true; if (piece === 'k') hasMoved['bK'] = true;
    if (piece === 'R' && fromR === 7 && fromC === 0) hasMoved['wR_left'] = true;
    if (piece === 'R' && fromR === 7 && fromC === 7) hasMoved['wR_right'] = true;
    if (piece === 'r' && fromR === 0 && fromC === 0) hasMoved['bR_left'] = true;
    if (piece === 'r' && fromR === 0 && fromC === 7) hasMoved['bR_right'] = true;

    if (piece.toLowerCase() === 'p' && Math.abs(toR - fromR) === 2) enPassantTarget = { r: (fromR + toR) / 2, c: fromC, color };
    else enPassantTarget = null;
    if (moveInfo && moveInfo.type === 'en_passant') { board[color === 'w' ? toR + 1 : toR - 1][toC] = null; }

    if (gameMode === 'class') { typeCooldowns[color][finalKey] = cdEndTime; typeCooldownMax[color][finalKey] = cdDuration; }
    else singleCooldowns[fromR][fromC] = 0;

    const startCoords = getVisualCoords(fromR, fromC), targetCoords = getVisualCoords(toR, toC);
    board[fromR][fromC] = null; renderBoard();

    const wrapper = document.createElement('div'); wrapper.className = 'animating-wrapper';
    wrapper.style.left = `${startCoords.x}px`; wrapper.style.top = `${startCoords.y}px`; wrapper.style.transitionDuration = `${duration}ms`;
    wrapper.style.width = `${boardEl.getBoundingClientRect().width / 8}px`;
    wrapper.style.height = `${boardEl.getBoundingClientRect().width / 8}px`;
    wrapper.dataset.cdEnd = cdEndTime; wrapper.dataset.maxCd = cdDuration;

    const animImg = document.createElement('img'); animImg.className = 'piece'; animImg.src = PIECES[pieceChar].img; wrapper.appendChild(animImg);
    const floatCdBar = document.createElement('div'); floatCdBar.className = 'cd-bar'; wrapper.appendChild(floatCdBar);
    animationLayer.appendChild(wrapper);

    let rookWrapper = null;
    if (moveInfo && moveInfo.type === 'castle') {
        let row = fromR, rFromC = toC === 6 ? 7 : 0, rToC = toC === 6 ? 5 : 3, rookPiece = board[row][rFromC];
        if (rookPiece) {
            board[row][rFromC] = null; if (gameMode !== 'class') singleCooldowns[row][rFromC] = 0; renderBoard();
            const rStart = getVisualCoords(row, rFromC), rTarget = getVisualCoords(row, rToC);
            rookWrapper = document.createElement('div'); rookWrapper.className = 'animating-wrapper';
            rookWrapper.style.left = `${rStart.x}px`; rookWrapper.style.top = `${rStart.y}px`; rookWrapper.style.transitionDuration = `${duration}ms`;
            rookWrapper.style.width = `${boardEl.getBoundingClientRect().width / 8}px`;
            rookWrapper.style.height = `${boardEl.getBoundingClientRect().width / 8}px`;
            const rImg = document.createElement('img'); rImg.className = 'piece'; rImg.src = PIECES[rookPiece].img; rookWrapper.appendChild(rImg);
            animationLayer.appendChild(rookWrapper);
            requestAnimationFrame(() => rookWrapper.style.transform = `translate(${rTarget.x - rStart.x}px, ${rTarget.y - rStart.y}px)`);
        }
    }

    requestAnimationFrame(() => wrapper.style.transform = `translate(${targetCoords.x - startCoords.x}px, ${targetCoords.y - startCoords.y}px)`);

    setTimeout(() => {
        if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
        if (rookWrapper && rookWrapper.parentNode) rookWrapper.parentNode.removeChild(rookWrapper);
        if (moveInfo && moveInfo.type === 'castle') { board[fromR][toC === 6 ? 5 : 3] = color === 'w' ? 'R' : 'r'; }
        if (gameMode !== 'class') { singleCooldowns[toR][toC] = cdEndTime; singleCooldownMax[toR][toC] = cdDuration; }
        
        if (board[toR][toC] && board[toR][toC].toLowerCase() === 'k') {
            isGameOver = true; 
            clearSession();
            
            // STATS SPEICHERN (QUICKCHESS)
            const isWin = (color === playerColor);
            saveGameResult('chess', isWin ? 'win' : 'loss');

            document.getElementById('winner-text').innerHTML = (color === playerColor ? myName : opponentName) + ' Wins!';
            document.getElementById('game-over').style.display = 'flex';
        }
        board[toR][toC] = pieceChar; renderBoard();
    }, duration);
}

function triggerPromotion(fromR, fromC, toR, toC, color) {
    pendingPromotion = { fromR, fromC, toR, toC, color };
    let modal = document.getElementById('promotion-modal'), box = document.getElementById('promo-options'); box.innerHTML = '';
    (color === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b']).forEach(p => {
        let img = document.createElement('img'); img.className = 'promo-piece'; img.src = PIECES[p].img;
        img.onclick = () => {
            modal.style.display = 'none'; pendingPromotion = null;
            const duration = calculateMoveDuration(fromR, fromC, toR, toC);
            socket.emit('request_move', { roomCode, playerId, fromR, fromC, toR, toC, moveInfo: { r: toR, c: toC, type: 'normal' }, promotedTo: p, duration });
            selectedSquare = null; validMoves = []; socket.emit('select_square', { roomCode, r: null, c: null }); renderBoard();
        };
        box.appendChild(img);
    });
    modal.style.display = 'flex';
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
            square.classList.toggle('capture-move', !!(moveInfo && (moveInfo.type === 'capture' || moveInfo.type === 'en_passant')));
            let piece = board[r][c], img = square.querySelector('.piece');
            if (piece) { img.src = PIECES[piece].img; img.classList.remove('hidden'); }
            else { img.src = ''; img.classList.add('hidden'); }
        }
    }
}

function updateCooldowns() {
    if (!isGameOver) {
        const now = Date.now();
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                let squareEl = boardEl.querySelector(`.square[data-r="${r}"][data-c="${c}"]`), cdBar = document.getElementById(`cd-${r}-${c}`), piece = board[r][c];
                if (squareEl && cdBar) {
                    let cdEnd = gameMode === 'class' ? (piece ? typeCooldowns[PIECES[piece].color][piece.toLowerCase()] : 0) : singleCooldowns[r][c];
                    let maxCd = gameMode === 'class' ? (piece ? typeCooldownMax[PIECES[piece].color][piece.toLowerCase()] : 1000) : singleCooldownMax[r][c];
                    if (cdEnd > now) { cdBar.style.width = `${Math.min(100, Math.max(0, ((cdEnd - now) / maxCd) * 100))}%`; squareEl.classList.add('locked'); }
                    else { cdBar.style.width = `0%`; squareEl.classList.remove('locked'); }
                }
            }
        }
        animationLayer.querySelectorAll('.animating-wrapper').forEach(wrap => {
            let cdEnd = parseFloat(wrap.dataset.cdEnd), maxCd = parseFloat(wrap.dataset.maxCd), floatBar = wrap.querySelector('.cd-bar');
            if (floatBar && cdEnd) floatBar.style.width = cdEnd > now ? `${Math.min(100, Math.max(0, ((cdEnd - now) / maxCd) * 100))}%` : `0%`;
        });
    }
    requestAnimationFrame(updateCooldowns);
}
