const socket = io('/mutant-chess');

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
const displayRoomCode = document.getElementById('display-room-code');
const chessboardEl = document.getElementById('chessboard');

// State
let currentRoomCode = null;
let myColor = 'w';
let isReady = false;

// Twitch-Daten abfragen
const twitchName = localStorage.getItem('cager_twitch_name');
let twitchPfp = localStorage.getItem('cager_twitch_pfp');

if (!twitchPfp || twitchPfp === 'undefined' || twitchPfp === 'null') {
    twitchPfp = 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
}

// LOGIK: Wenn via Twitch angemeldet -> fixieren. Sonst -> Freie Eingabe erlauben!
if (twitchName && twitchName !== 'undefined' && twitchName !== 'null') {
    playerNameInput.value = twitchName;
    playerNameInput.readOnly = true;
    playerNameInput.style.backgroundColor = '#f0f0f0';
} else {
    playerNameInput.value = 'Gast_' + Math.floor(100 + Math.random() * 900);
    playerNameInput.readOnly = false;
}

const pieceMap = { 'p': '♙', 'r': '♖', 'n': '♘', 'b': '♗', 'q': '♕', 'k': '♔' };

// LOBBY ACTIONS
btnCreateRoom.addEventListener('click', () => {
    const finalName = playerNameInput.value.trim() || 'Gast';
    socket.emit('create_mutant_room', { playerName: finalName, pfp: twitchPfp });
});

btnJoinRoom.addEventListener('click', () => {
    const finalName = playerNameInput.value.trim() || 'Gast';
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) return alert('Bitte gib einen 6-stelligen Raumcode ein!');
    socket.emit('join_mutant_room', { roomCode: code, playerName: finalName, pfp: twitchPfp });
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

// SOCKET LISTENERS
socket.on('mutant_room_created', (data) => {
    currentRoomCode = data.roomCode;
    myColor = data.color;
    setupGameUI(data);
});

socket.on('mutant_room_joined', (data) => {
    currentRoomCode = data.roomCode;
    myColor = data.color;
    setupGameUI(data);

    if (data.opponentName) {
        oppNameEl.innerText = data.opponentName;
        oppAvatarEl.src = data.opponentPfp || 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
        oppStatusBadge.innerText = 'Verbunden';
        oppStatusBadge.className = 'badge badge-green';
    }
});

socket.on('mutant_opponent_joined', (data) => {
    oppNameEl.innerText = data.opponentName;
    oppAvatarEl.src = data.opponentPfp || 'https://www.pngmart.com/files/23/Flork-PNG-Transparent.png';
    oppStatusBadge.innerText = 'Verbunden';
    oppStatusBadge.className = 'badge badge-green';
});

socket.on('error_msg', (msg) => {
    alert(msg);
});

function setupGameUI(data) {
    const activeName = playerNameInput.value.trim() || 'Gast';
    selfNameEl.innerText = `${activeName} (You)`;
    selfAvatarEl.src = twitchPfp;

    displayRoomCode.innerText = currentRoomCode;
    playerColorBadge.innerText = myColor === 'w' ? 'WHITE' : 'BLACK';

    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'flex';
    renderPreviewBoard();
}

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
