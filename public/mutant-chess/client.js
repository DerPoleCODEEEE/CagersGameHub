// Verbinde explizit auf den Namespace!
const socket = io('/mutant-chess');

// Twitch Daten aus dem Hub-Login abrufen
const twitchName = localStorage.getItem('cager_twitch_name') || 'Gast';
const twitchPfp = localStorage.getItem('cager_twitch_pfp') || 'default_avatar.png';

// UI initialisieren
document.getElementById('twitch-name').innerText = twitchName;
document.getElementById('twitch-avatar').src = twitchPfp;

// Resilienz & UI States
const splashScreen = document.getElementById('splash-screen');
const gameContainer = document.getElementById('game-container');

socket.on('connect', () => {
    splashScreen.style.display = 'none';
    gameContainer.style.display = 'block';
    gameContainer.classList.remove('offline');
    
    // Raum betreten (In echt würdest du den Code z.B. per URL-Parameter übergeben)
    socket.emit('joinRoom', '123456');
});

socket.on('disconnect', () => {
    // Wenn der Server stirbt, UI ausgrauen
    gameContainer.classList.add('offline');
});

socket.on('gameState', (board) => {
    // Hier renderst du das HTML für das Schachbrett basierend auf den Serverdaten
    renderBoard(board);
});

socket.on('mergeSuccess', (data) => {
    // Kleine Audio- oder CSS-Animation abspielen
    console.log(`BAM! Mutation auf Feld ${data.field}`);
});

// Hilfsfunktion (Beispiel)
function renderBoard(boardState) {
    // Iteriere durch boardState, erstelle DOM Elemente und füge Klasse .mutant 
    // hinzu, falls piece.types.length > 1 ist.
}
