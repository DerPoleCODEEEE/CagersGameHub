const socket = io('/mutant-chess');

// Twitch-Profilbild oder Flork-Fallback
const twitchName = localStorage.getItem('cager_twitch_name') || 'Gast';
let twitchPfp = localStorage.getItem('cager_twitch_pfp');

if (!twitchPfp || twitchPfp === 'undefined' || twitchPfp === 'null') {
    twitchPfp = 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
}

document.getElementById('twitch-name').innerText = twitchName;
document.getElementById('twitch-avatar').src = twitchPfp;

// State
let myColor = null;
let currentBoard = null;
let draggedPiece = null;

const pieceMap = { 'p': '♙', 'r': '♖', 'n': '♘', 'b': '♗', 'q': '♕', 'k': '♔' };

const boardEl = document.getElementById('chessboard');
const turnIndicator = document.getElementById('turn-indicator');
const splash = document.getElementById('splash-screen');
const container = document.getElementById('game-container');

socket.on('connect', () => {
    splash.style.display = 'none';
    container.style.display = 'flex';
    socket.emit('join_mutant_room', { roomCode: 'CHAOS', playerName: twitchName, pfp: twitchPfp });
});

socket.on('game_started', (data) => {
    myColor = data.color;
    updateBoard(data.board);
    updateTurnIndicator(data.turn);
});

socket.on('board_update', (data) => {
    updateBoard(data.board);
    updateTurnIndicator(data.turn);
});

socket.on('game_over', (data) => {
    document.getElementById('game-over-modal').style.display = 'block';
    const text = data.winner === myColor ? "Sieg! Du hast den König zerstört!" : "Niederlage! Dein König wurde vernichtet!";
    document.getElementById('win-text').innerText = text;
});

socket.on('invalid_move', (msg) => {
    console.warn(msg);
});

function updateTurnIndicator(turn) {
    if (turn === myColor) {
        turnIndicator.innerText = "Dein Zug!";
        turnIndicator.className = `turn-indicator turn-${myColor}`;
    } else {
        turnIndicator.innerText = "Gegner zieht...";
        turnIndicator.className = 'turn-indicator';
    }
}

function updateBoard(boardArray) {
    currentBoard = boardArray;
    boardEl.innerHTML = '';

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const visualR = myColor === 'b' ? 7 - r : r;
            const visualC = myColor === 'b' ? 7 - c : c;

            const square = document.createElement('div');
            square.className = `square ${(visualR + visualC) % 2 === 0 ? 'light' : 'dark'}`;
            square.dataset.r = r;
            square.dataset.c = c;

            const cellData = boardArray[r][c];
            if (cellData) {
                const pieceDiv = document.createElement('div');
                pieceDiv.className = `piece color-${cellData.color}`;
                pieceDiv.draggable = (cellData.color === myColor);

                pieceDiv.innerText = pieceMap[cellData.types[0]];

                if (cellData.types.length > 1) {
                    const overlay = document.createElement('div');
                    overlay.className = 'mutant-layer';
                    overlay.innerText = pieceMap[cellData.types[1]];
                    pieceDiv.appendChild(overlay);
                }

                pieceDiv.addEventListener('dragstart', () => {
                    draggedPiece = { r, c };
                    setTimeout(() => pieceDiv.style.opacity = '0.5', 0);
                });
                pieceDiv.addEventListener('dragend', () => pieceDiv.style.opacity = '1');

                square.appendChild(pieceDiv);
            }

            square.addEventListener('dragover', (e) => e.preventDefault());
            square.addEventListener('dragenter', () => square.classList.add('highlight'));
            square.addEventListener('dragleave', () => square.classList.remove('highlight'));
            square.addEventListener('drop', (e) => {
                e.preventDefault();
                square.classList.remove('highlight');
                if (draggedPiece) {
                    const targetStart = [draggedPiece.r, draggedPiece.c];
                    const targetEnd = [r, c];
                    if (targetStart[0] !== targetEnd[0] || targetStart[1] !== targetEnd[1]) {
                        socket.emit('make_move', { roomCode: 'CHAOS', start: targetStart, target: targetEnd });
                    }
                }
            });

            boardEl.appendChild(square);
        }
    }
}
