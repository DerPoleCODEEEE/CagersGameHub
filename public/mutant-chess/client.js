const socket = io('/mutant-chess');

// Twitch Profil-Daten laden
const twitchName = localStorage.getItem('cager_twitch_name') || 'Gast';
let twitchPfp = localStorage.getItem('cager_twitch_pfp');

if (!twitchPfp || twitchPfp === 'undefined' || twitchPfp === 'null') {
    twitchPfp = 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
}

// UI Elements
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const playerNameInput = document.getElementById('player-name-input');
const roomCodeInput = document.getElementById('room-code-input');

const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const btnReady = document.getElementById('btn-ready');
const btnLeaveGame = document.getElementById('btn-leave-game');

const selfNameEl = document.getElementById('self-name');
const selfAvatarEl = document.getElementById('self-avatar');
const selfStatusBadge = document.getElementById('self-status-badge');

const oppNameEl = document.getElementById('opp-name');
const oppAvatarEl = document.getElementById('opp-avatar');
const oppStatusBadge = document.getElementById('opp-status-badge');

const playerColorBadge = document.getElementById('player-color-badge');
const chessboardEl = document.getElementById('chessboard');

// State
let currentRoomCode = null;
let myColor = 'w';
let isReady = false;

// Initialisierung
playerNameInput.value = twitchName;
selfNameEl.innerText = `${twitchName} (You)`;
selfAvatarEl.src = twitchPfp;

// Unicode Figuren (Platzhalter für Vorschau)
const pieceMap = { 'p': '♙', 'r': '♖', 'n': '♘', 'b': '♗', 'q': '♕', 'k': '♔' };

// LOBBY LOGIK (Umschalten zwischen Menü und Ingame)
btnCreateRoom.addEventListener('click', () => {
    socket.emit('create_mutant_room', { playerName: twitchName, pfp: twitchPfp });
});

btnJoinRoom.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) return alert('Bitte gib einen Code ein!');
    socket.emit('join_mutant_room', { roomCode: code, playerName: twitchName, pfp: twitchPfp });
});

btnReady.addEventListener('click', () => {
    isReady = !isReady;
    if (isReady) {
        btnReady.innerText = "READY!";
        btnReady.style.background = "#2ecc71";
        selfStatusBadge.innerText = "Ready";
        selfStatusBadge.className = "badge badge-green";
    } else {
        btnReady.innerText = "I AM READY!";
        btnReady.style.background = "#f39c12";
        selfStatusBadge.innerText = "Not Ready";
        selfStatusBadge.className = "badge badge-red";
    }
});

btnLeaveGame.addEventListener('click', () => {
    window.location.href = '/';
});

// SOCKET EVENTS (Für Menü-Flow)
socket.on('mutant_room_created', (data) => {
    currentRoomCode = data.roomCode;
    myColor = data.color;
    playerColorBadge.innerText = myColor === 'w' ? 'WHITE' : 'BLACK';
    switchToGameScreen();
});

socket.on('mutant_room_joined', (data) => {
    currentRoomCode = data.roomCode;
    myColor = data.color;
    playerColorBadge.innerText = myColor === 'w' ? 'WHITE' : 'BLACK';
    
    if (data.opponentName) {
        oppNameEl.innerText = data.opponentName;
        oppAvatarEl.src = data.opponentPfp || 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
        oppStatusBadge.innerText = 'Verbunden';
        oppStatusBadge.className = 'badge badge-green';
    }
    switchToGameScreen();
});

socket.on('mutant_opponent_joined', (data) => {
    oppNameEl.innerText = data.opponentName;
    oppAvatarEl.src = data.opponentPfp || 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
    oppStatusBadge.innerText = 'Verbunden';
    oppStatusBadge.className = 'badge badge-green';
});

function switchToGameScreen() {
    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'flex';
    renderPreviewBoard();
}

// Rendert das leere Vorschau-Schachbrett im exakten Design
function renderPreviewBoard() {
    chessboardEl.innerHTML = '';
    const initialBoard = [
        ['r','n','b','q','k','b','n','r'],
        ['p','p','p','p','p','p','p','p'],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        ['p','p','p','p','p','p','p','p'],
        ['r','n','b','q','k','b','n','r']
    ];

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = document.createElement('div');
            square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
            
            const piece = initialBoard[r][c];
            if (piece) {
                square.innerText = pieceMap[piece];
                square.style.color = r < 2 ? '#000' : '#fff';
                if (r >= 6) {
                    square.style.textShadow = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
                }
            }
            chessboardEl.appendChild(square);
        }
    }
}
