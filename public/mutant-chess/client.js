/* eslint-env browser */
/**
 * Mutant Merge Chess — Client.
 *
 * Zuggenerierung kommt aus /shared/move-gen.js und ist damit identisch zu der,
 * die der Server zur Validierung benutzt. Brett, Uhren, Fusionen, Rochade-
 * Rechte und das Ergebnis bestimmt ausschließlich der Server.
 */
(function () {
    'use strict';

    const socket = io('/mutant-chess');
    const MG = window.MoveGen;
    const DU = window.DomUtils;
    const { PIECE_IMAGES } = window.PieceAssets;

    const PIECES = {};
    Object.keys(PIECE_IMAGES).forEach(ch => { PIECES[ch] = { img: PIECE_IMAGES[ch] }; });

    // =====================================================================
    // MODALS
    // =====================================================================
    const rulesModalEl = document.getElementById('rules-modal');
    const rulesModal = DU.makeAccessibleModal(rulesModalEl);
    const btnShowRules = document.getElementById('btn-show-rules');
    const closeRulesBtn = document.getElementById('close-rules-btn');
    if (btnShowRules) btnShowRules.addEventListener('click', () => rulesModal.open());
    if (closeRulesBtn) closeRulesBtn.addEventListener('click', () => rulesModal.close());
    if (rulesModalEl) rulesModalEl.addEventListener('click', (e) => { if (e.target === rulesModalEl) rulesModal.close(); });

    // =====================================================================
    // STATE
    // =====================================================================
    let roomCode = null, playerColor = null, playerId = null;
    let myName = '', opponentName = '', opponentPfp = '';
    let selectedSquare = null;
    let validMoves = [], isGameOver = false, isBoardDomCreated = false;
    let isGameStarted = false;
    let currentTurn = 'w';
    let moveCount = 1;

    let clocks = { w: 180, b: 180 };
    let clockTimer = null;
    let countdownInterval = null;
    let reconnectBannerTimeout = null;
    let bannerHideTimeout = null;

    let enPassantTarget = null;
    let pendingPromotion = null;
    let hasMoved = MG.createHasMoved();

    let maxFusions = 3;
    let fusionsLeft = { w: 3, b: 3 };
    let allowKingFusion = true;
    let lowTimeWarned = { w: false, b: false };

    let board = MG.createInitialMutantBoard();

    const squareNodes = [];
    const containerNodes = [];
    const mainImgNodes = [];
    const overlayImgNodes = [];

    // =====================================================================
    // DOM
    // =====================================================================
    const menuScreen = document.getElementById('menu-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const gameScreen = document.getElementById('game-screen');
    const errorMsg = document.getElementById('error-msg');
    const boardEl = document.getElementById('board');
    const btnReady = document.getElementById('btn-ready');
    const statusBanner = document.getElementById('status-banner');
    const statusBannerText = document.getElementById('status-banner-text');
    const historyList = document.getElementById('history-list');
    const bottomClockEl = document.getElementById('bottom-clock');
    const topClockEl = document.getElementById('top-clock');
    const bottomFusionDots = document.getElementById('bottom-fusion-dots');
    const topFusionDots = document.getElementById('top-fusion-dots');

    // =====================================================================
    // SESSION
    // =====================================================================
    function getSavedMutantSession() {
        try {
            const data = sessionStorage.getItem('mutant_chess_session');
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    }

    function saveMutantSession() {
        if (!roomCode || !playerColor || !playerId) return;
        try {
            sessionStorage.setItem('mutant_chess_session', JSON.stringify({
                roomCode, playerColor, playerId, myName, opponentName, opponentPfp
            }));
        } catch (e) { /* ignore */ }
    }

    function clearMutantSession() {
        try { sessionStorage.removeItem('mutant_chess_session'); } catch (e) { /* ignore */ }
    }

    socket.on('connect', () => {
        const splash = document.getElementById('splash-screen');
        if (splash) splash.style.display = 'none';

        const saved = getSavedMutantSession();
        if (saved && saved.roomCode && saved.playerId && saved.playerColor) {
            socket.emit('reconnect_mutant_room', {
                roomCode: saved.roomCode, playerId: saved.playerId, playerColor: saved.playerColor
            });
        }
    });

    // =====================================================================
    // TWITCH
    // =====================================================================
    let twitchName = null, twitchPfp = '';
    try {
        twitchName = localStorage.getItem('cager_twitch_name');
        twitchPfp = DU.safeImageUrl(localStorage.getItem('cager_twitch_pfp'), '');
    } catch (e) { /* ignore */ }

    if (twitchName && twitchName !== 'undefined' && twitchName !== 'null') {
        const nameInput = document.getElementById('player-name');
        nameInput.value = twitchName;
        nameInput.disabled = true;
    }

    // =====================================================================
    // SLIDER
    // =====================================================================
    const timeRange = document.getElementById('time-range');
    const incRange = document.getElementById('inc-range');
    const fusionRange = document.getElementById('fusion-range');
    const timeVal = document.getElementById('time-val');
    const incVal = document.getElementById('inc-val');
    const fusionVal = document.getElementById('fusion-val');

    if (timeRange) timeRange.addEventListener('input', () => { timeVal.textContent = timeRange.value; });
    if (incRange) incRange.addEventListener('input', () => { incVal.textContent = incRange.value; });
    if (fusionRange) fusionRange.addEventListener('input', () => { fusionVal.textContent = fusionRange.value; });

    // =====================================================================
    // HELPER
    // =====================================================================
    function toAlgebraic(r, c) {
        return String.fromCharCode(97 + c) + (8 - r);
    }

    function formatTime(seconds) {
        const sec = Math.max(0, Math.floor(seconds));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function showError(msg) {
        errorMsg.textContent = msg;
        if (window.Sfx) window.Sfx.play('illegal', { volume: 0.6 });
    }

    function cleanupTimers() {
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        if (reconnectBannerTimeout) { clearTimeout(reconnectBannerTimeout); reconnectBannerTimeout = null; }
        if (bannerHideTimeout) { clearTimeout(bannerHideTimeout); bannerHideTimeout = null; }
    }

    window.addEventListener('beforeunload', cleanupTimers);

    function leaveGame() { cleanupTimers(); clearMutantSession(); location.reload(); }

    // =====================================================================
    // MENÜ-AKTIONEN
    // =====================================================================
    document.getElementById('btn-create').addEventListener('click', () => {
        myName = document.getElementById('player-name').value.trim() || 'Player 1';
        socket.emit('create_mutant_room', {
            playerName: myName,
            pfp: twitchPfp,
            colorChoice: document.getElementById('color-choice').value,
            totalTime: parseInt(timeRange.value, 10),
            increment: parseInt(incRange.value, 10),
            maxFusions: parseInt(fusionRange.value, 10),
            allowKingFusion: document.getElementById('allow-king-fusion')
                ? document.getElementById('allow-king-fusion').checked : true
        });
    });

    document.getElementById('btn-join').addEventListener('click', () => {
        myName = document.getElementById('player-name').value.trim() || 'Player 2';
        const code = document.getElementById('room-code-input').value.trim().toUpperCase();
        if (!code) return showError('Please enter a room code!');
        socket.emit('join_mutant_room', { roomCode: code, playerName: myName, pfp: twitchPfp });
    });

    document.getElementById('btn-leave-lobby').addEventListener('click', leaveGame);
    document.getElementById('btn-leave-game').addEventListener('click', leaveGame);
    const backToMenuBtn = document.getElementById('btn-back-to-menu');
    if (backToMenuBtn) backToMenuBtn.addEventListener('click', leaveGame);

    document.getElementById('btn-resign').addEventListener('click', () => {
        if (isGameOver) return;
        if (confirm('Are you sure you want to resign?')) socket.emit('resign_game', { roomCode });
    });

    document.getElementById('btn-offer-draw').addEventListener('click', () => {
        if (isGameOver) return;
        socket.emit('offer_draw', { roomCode });
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = 'Draw offer sent!';
        if (bannerHideTimeout) clearTimeout(bannerHideTimeout);
        bannerHideTimeout = setTimeout(() => {
            bannerHideTimeout = null;
            if (!isGameOver) statusBanner.classList.add('hidden');
        }, 2500);
    });

    document.getElementById('btn-accept-draw').addEventListener('click', () => {
        document.getElementById('draw-modal').style.display = 'none';
        socket.emit('respond_draw', { roomCode, accepted: true });
    });

    document.getElementById('btn-decline-draw').addEventListener('click', () => {
        document.getElementById('draw-modal').style.display = 'none';
        socket.emit('respond_draw', { roomCode, accepted: false });
    });

    btnReady.addEventListener('click', () => {
        socket.emit('player_ready', { roomCode });
        btnReady.textContent = 'READY!';
        btnReady.classList.add('is-ready');
        btnReady.disabled = true;
    });

    // =====================================================================
    // SOCKET-EVENTS
    // =====================================================================
    function adoptRoomState(data) {
        if (data.clocks) clocks = data.clocks;
        if (data.maxFusions !== undefined) maxFusions = data.maxFusions;
        if (data.fusionsLeft) fusionsLeft = data.fusionsLeft;
        if (data.allowKingFusion !== undefined) allowKingFusion = data.allowKingFusion;
        // Vorher rein clientseitig -> nach Reload gingen Rochade- und
        // En-Passant-Rechte verloren.
        if (data.hasMoved) hasMoved = data.hasMoved;
        if (data.enPassantTarget !== undefined) enPassantTarget = data.enPassantTarget;
    }

    socket.on('mutant_room_created', (data) => {
        roomCode = data.roomCode; playerColor = data.color; playerId = data.playerId;
        adoptRoomState(data);
        saveMutantSession();
        menuScreen.classList.add('hidden');
        lobbyScreen.classList.remove('hidden');
        document.getElementById('display-room-code').textContent = roomCode;
    });

    socket.on('mutant_room_joined', (data) => {
        roomCode = data.roomCode; playerColor = data.color; playerId = data.playerId;
        opponentName = data.opponentName;
        opponentPfp = DU.safeImageUrl(data.opponentPfp, '');
        adoptRoomState(data);
        saveMutantSession();
        startGame();
    });

    socket.on('mutant_room_reconnected', (data) => {
        roomCode = data.roomCode; playerColor = data.color; playerId = data.playerId;
        board = data.board;
        currentTurn = data.turn;
        adoptRoomState(data);
        isGameStarted = data.isGameStarted;
        isGameOver = data.isGameOver;
        opponentName = data.opponentName || opponentName;
        opponentPfp = DU.safeImageUrl(data.opponentPfp, '') || opponentPfp;

        saveMutantSession();
        startGame();

        if (isGameStarted && !isGameOver) {
            btnReady.textContent = 'READY!';
            btnReady.classList.add('is-ready');
            btnReady.disabled = true;
            startClockTicker();
        }
    });

    socket.on('mutant_opponent_joined', (data) => {
        opponentName = data.opponentName;
        opponentPfp = DU.safeImageUrl(data.opponentPfp, '');
        saveMutantSession();
        startGame();
        if (window.Sfx) window.Sfx.play('notify');
    });

    socket.on('mutant_opponent_disconnected', (data) => {
        const secs = (data && data.countdownSeconds) || 30;
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = `Opponent disconnected! Forfeit in ${secs}s...`;
    });

    socket.on('mutant_opponent_reconnected', () => {
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = 'Opponent reconnected!';
        if (reconnectBannerTimeout) clearTimeout(reconnectBannerTimeout);
        reconnectBannerTimeout = setTimeout(() => {
            reconnectBannerTimeout = null;
            if (!isGameOver) statusBanner.classList.add('hidden');
        }, 2000);
    });

    socket.on('mutant_opponent_left', () => {
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = 'Opponent has left the game!';
    });

    socket.on('ready_update', ({ playersReady }) => {
        statusBanner.classList.remove('hidden');
        playersReady.forEach(p => {
            if (p.ready) {
                const displayName = p.color === playerColor ? myName : (opponentName || p.name || 'Opponent');
                statusBannerText.textContent = `${displayName} is Ready!`;
            }
        });
    });

    socket.on('start_match_countdown', (data) => {
        if (data && data.clocks) clocks = data.clocks;
        if (data && data.fusionsLeft) fusionsLeft = data.fusionsLeft;
        if (data && data.maxFusions !== undefined) maxFusions = data.maxFusions;

        isGameStarted = false;
        statusBanner.classList.remove('hidden');
        let secondsLeft = 5;
        statusBannerText.textContent = `Match starting in ${secondsLeft}s!`;

        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            secondsLeft--;
            if (secondsLeft > 0) {
                statusBannerText.textContent = `Match starting in ${secondsLeft}s!`;
            } else {
                clearInterval(countdownInterval);
                countdownInterval = null;
                statusBannerText.textContent = 'BATTLE STARTED! GO!';
                isGameStarted = true;
                startClockTicker();
                if (window.Sfx) window.Sfx.play('game-start');
                if (bannerHideTimeout) clearTimeout(bannerHideTimeout);
                bannerHideTimeout = setTimeout(() => {
                    bannerHideTimeout = null;
                    statusBanner.classList.add('hidden');
                }, 1500);
            }
        }, 1000);
    });

    /** Server-Uhr korrigiert den lokalen Ticker regelmäßig. */
    socket.on('clock_sync', (data) => {
        if (!data || !data.clocks || isGameOver) return;
        clocks = data.clocks;
        if (data.turn) currentTurn = data.turn;
        updateClockDisplay();
    });

    socket.on('apply_mutant_move', (moveData) => {
        if (moveData.clocks) clocks = moveData.clocks;
        if (moveData.fusionsLeft) fusionsLeft = moveData.fusionsLeft;
        if (moveData.hasMoved) hasMoved = moveData.hasMoved;
        enPassantTarget = moveData.enPassantTarget || null;
        executeMove(moveData);
    });

    socket.on('draw_offered', () => {
        document.getElementById('draw-modal').style.display = 'flex';
        if (window.Sfx) window.Sfx.play('notify');
    });

    socket.on('draw_declined', () => {
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = 'Opponent declined the draw offer!';
        if (bannerHideTimeout) clearTimeout(bannerHideTimeout);
        bannerHideTimeout = setTimeout(() => {
            bannerHideTimeout = null;
            if (!isGameOver) statusBanner.classList.add('hidden');
        }, 2500);
    });

    socket.on('game_over', ({ winnerColor, reason }) => {
        isGameOver = true;
        cleanupTimers();
        clearMutantSession();
        // Stats bucht der Server.

        let text;
        if (winnerColor === null) {
            text = 'Draw! (Agreed Draw)';
        } else if (winnerColor === playerColor) {
            text = reason === 'time' ? 'Victory by time out!'
                 : reason === 'resign' ? 'Opponent resigned!'
                 : reason === 'disconnect' ? 'Victory! Opponent disconnected!'
                 : 'Victory! Enemy King destroyed!';
        } else {
            text = reason === 'time' ? 'Defeat! Time ran out!'
                 : reason === 'resign' ? 'You resigned.'
                 : reason === 'disconnect' ? 'Defeat by Disconnect!'
                 : 'Defeat! Your King was destroyed!';
        }

        document.getElementById('winner-text').textContent = text;
        document.getElementById('game-over').style.display = 'flex';
        if (window.Sfx) window.Sfx.play('game-end');
    });

    socket.on('error_msg', (msg) => showError(typeof msg === 'string' ? msg : 'Error'));

    // =====================================================================
    // RENDERING
    // =====================================================================
    function renderFusionDots() {
        if (!bottomFusionDots || !topFusionDots) return;
        const myFusions = fusionsLeft[playerColor];
        const oppFusions = fusionsLeft[playerColor === 'w' ? 'b' : 'w'];

        DU.clear(bottomFusionDots);
        DU.clear(topFusionDots);

        for (let i = 0; i < maxFusions; i++) {
            bottomFusionDots.appendChild(DU.el('div', { class: `fusion-dot ${i >= myFusions ? 'used' : ''}` }));
            topFusionDots.appendChild(DU.el('div', { class: `fusion-dot ${i >= oppFusions ? 'used' : ''}` }));
        }
        bottomFusionDots.setAttribute('aria-label', `${myFusions} von ${maxFusions} Fusionen übrig`);
        topFusionDots.setAttribute('aria-label', `Gegner: ${oppFusions} von ${maxFusions} Fusionen übrig`);
    }

    function startGame() {
        menuScreen.classList.add('hidden');
        lobbyScreen.classList.add('hidden');
        gameScreen.classList.remove('hidden');

        document.getElementById('my-role-tag').textContent = playerColor === 'w' ? 'WHITE' : 'BLACK';
        document.getElementById('bottom-player-name').textContent = myName + ' (You)';
        document.getElementById('top-player-name').textContent = opponentName || 'Opponent';

        const bottomPfpEl = document.getElementById('bottom-pfp');
        if (twitchPfp) { bottomPfpEl.src = twitchPfp; bottomPfpEl.classList.remove('hidden'); }
        const topPfpEl = document.getElementById('top-pfp');
        if (opponentPfp) { topPfpEl.src = opponentPfp; topPfpEl.classList.remove('hidden'); }

        if (playerColor === 'b') boardEl.classList.add('flipped');

        createBoardDOMOnce();
        renderBoard();
        updateTurnDisplay();
        updateClockDisplay();
        renderFusionDots();
    }

    function startClockTicker() {
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
        clockTimer = setInterval(() => {
            if (!isGameStarted || isGameOver) return;

            clocks[currentTurn] = Math.max(0, clocks[currentTurn] - 0.1);
            updateClockDisplay();

            if (clocks[currentTurn] <= 15 && clocks[currentTurn] > 0 && !lowTimeWarned[currentTurn]) {
                lowTimeWarned[currentTurn] = true;
                if (currentTurn === playerColor && window.Sfx) window.Sfx.play('low-time');
            }
            if (clocks[currentTurn] > 20) lowTimeWarned[currentTurn] = false;

            if (clocks[currentTurn] <= 0) {
                clearInterval(clockTimer);
                clockTimer = null;
                // Entschieden wird serverseitig; das hier ist nur ein Hinweis.
                socket.emit('time_out', { roomCode });
            }
        }, 100);
    }

    function updateClockDisplay() {
        const oppColor = playerColor === 'w' ? 'b' : 'w';
        bottomClockEl.textContent = formatTime(clocks[playerColor]);
        topClockEl.textContent = formatTime(clocks[oppColor]);

        bottomClockEl.classList.toggle('active', currentTurn === playerColor);
        topClockEl.classList.toggle('active', currentTurn !== playerColor);
    }

    function updateTurnDisplay() {
        const turnTag = document.getElementById('turn-display-tag');
        if (currentTurn === playerColor) {
            turnTag.textContent = 'YOUR TURN!';
            turnTag.style.color = '#2ecc71';
        } else {
            turnTag.textContent = "OPPONENT'S TURN...";
            turnTag.style.color = '#e74c3c';
        }
    }

    function createBoardDOMOnce() {
        if (isBoardDomCreated) return;
        DU.clear(boardEl);
        boardEl.setAttribute('role', 'grid');
        boardEl.setAttribute('aria-label', 'Mutant-Schachbrett');

        for (let r = 0; r < 8; r++) {
            squareNodes[r] = []; containerNodes[r] = []; mainImgNodes[r] = []; overlayImgNodes[r] = [];
            for (let c = 0; c < 8; c++) {
                const square = document.createElement('div');
                square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.r = r;
                square.dataset.c = c;
                square.setAttribute('role', 'gridcell');

                const container = document.createElement('div');
                container.className = 'piece-container hidden';

                const mainImg = document.createElement('img');
                mainImg.className = 'piece-img main';
                mainImg.referrerPolicy = 'no-referrer';
                mainImg.alt = '';
                container.appendChild(mainImg);

                const overlayImg = document.createElement('img');
                overlayImg.className = 'piece-img overlay hidden';
                overlayImg.referrerPolicy = 'no-referrer';
                overlayImg.alt = '';
                container.appendChild(overlayImg);

                square.appendChild(container);
                square.addEventListener('click', () => handleSquareClick(r, c));
                DU.makeKeyboardActivatable(square, () => handleSquareClick(r, c), squareLabel(r, c));

                boardEl.appendChild(square);
                squareNodes[r][c] = square;
                containerNodes[r][c] = container;
                mainImgNodes[r][c] = mainImg;
                overlayImgNodes[r][c] = overlayImg;
            }
        }
        isBoardDomCreated = true;
    }

    const PIECE_NAMES = { p: 'Bauer', n: 'Springer', b: 'Läufer', r: 'Turm', q: 'Dame', k: 'König' };

    function describePieces(arr) {
        return arr.map(p => PIECE_NAMES[MG.baseChar(p)] || p).join(' + ');
    }

    function squareLabel(r, c) {
        const alg = toAlgebraic(r, c);
        const arr = board[r] && board[r][c];
        if (!arr || !arr.length) return `${alg}, leer`;
        const color = MG.getPieceColor(arr) === 'w' ? 'Weiß' : 'Schwarz';
        return `${alg}, ${color} ${describePieces(arr)}`;
    }

    /** Exakt derselbe Generator wie auf dem Server. */
    function getValidMoves(r, c) {
        const pieceArr = board[r][c];
        if (!pieceArr) return [];
        if (MG.getPieceColor(pieceArr) !== playerColor || currentTurn !== playerColor) return [];
        return MG.mutantMoves(board, r, c, { enPassantTarget, hasMoved, allowKingFusion, fusionsLeft });
    }

    function handleSquareClick(r, c) {
        if (!isGameStarted || isGameOver || currentTurn !== playerColor || pendingPromotion) return;
        const clickedPiece = board[r][c];

        if (selectedSquare) {
            const moveInfo = validMoves.find(m => m.r === r && m.c === c);
            if (moveInfo) {
                const movingPiece = board[selectedSquare.r][selectedSquare.c];
                if (movingPiece && movingPiece.length === 1 &&
                    MG.baseChar(movingPiece[0]) === 'p' && (r === 0 || r === 7) &&
                    moveInfo.type !== 'merge') {
                    triggerPromotion(selectedSquare.r, selectedSquare.c, r, c, moveInfo);
                    return;
                }
                sendMoveToServer(selectedSquare.r, selectedSquare.c, r, c, moveInfo, null);
                selectedSquare = null; validMoves = [];
                renderBoard();
                return;
            }
        }

        if (clickedPiece && MG.getPieceColor(clickedPiece) === playerColor) {
            selectedSquare = { r, c };
            validMoves = getValidMoves(r, c);
            renderBoard();
            return;
        }

        selectedSquare = null; validMoves = [];
        renderBoard();
    }

    function triggerPromotion(fromR, fromC, toR, toC, moveInfo) {
        pendingPromotion = { fromR, fromC, toR, toC, moveInfo };
        const modalEl = document.getElementById('promotion-modal');
        const box = document.getElementById('promo-options');
        DU.clear(box);

        const promoPieces = playerColor === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b'];
        promoPieces.forEach(p => {
            const img = document.createElement('img');
            img.className = 'promo-piece';
            img.referrerPolicy = 'no-referrer';
            img.src = PIECES[p].img;
            img.alt = PIECE_NAMES[p.toLowerCase()];
            const choose = () => {
                modalEl.style.display = 'none';
                pendingPromotion = null;
                sendMoveToServer(fromR, fromC, toR, toC, moveInfo, p);
                selectedSquare = null; validMoves = [];
                renderBoard();
            };
            img.addEventListener('click', choose);
            DU.makeKeyboardActivatable(img, choose, `Umwandeln in ${PIECE_NAMES[p.toLowerCase()]}`);
            box.appendChild(img);
        });
        modalEl.style.display = 'flex';
        const first = box.firstChild;
        if (first && first.focus) first.focus();
    }

    function sendMoveToServer(fromR, fromC, toR, toC, moveInfo, promotedTo) {
        socket.emit('request_mutant_move', { roomCode, fromR, fromC, toR, toC, moveInfo, promotedTo });
    }

    function addMoveToHistory(fromR, fromC, toR, toC, movingPiece, targetPiece, moveType) {
        const dest = toAlgebraic(toR, toC);
        const start = toAlgebraic(fromR, fromC);
        const formatPieces = (arr) => arr.map(p => p.replace('_fused', '').toUpperCase()).join('+');

        let str;
        if (moveType === 'castle') {
            str = toC === 6 ? 'O-O' : 'O-O-O';
        } else if (moveType === 'merge') {
            str = `${formatPieces(movingPiece)}+${formatPieces(targetPiece || [])}@${dest}`;
        } else {
            const isMutant = movingPiece.length > 1;
            const pStr = isMutant ? `(${formatPieces(movingPiece)})` : movingPiece[0].replace('_fused', '').toUpperCase();
            str = (moveType === 'capture' || moveType === 'en_passant') ? `${pStr}x${dest}` : `${pStr}${start}-${dest}`;
        }

        historyList.appendChild(DU.el('div', { class: 'history-row' }, `${moveCount}. ${str}`));
        historyList.scrollTop = historyList.scrollHeight;
        moveCount++;
    }

    function executeMove(data) {
        const { fromR, fromC, toR, toC, moveInfo, promotedTo } = data;
        const movingPiece = board[fromR][fromC];
        const targetPiece = board[toR][toC];
        if (!movingPiece) return;

        const type = moveInfo ? moveInfo.type : 'normal';
        addMoveToHistory(fromR, fromC, toR, toC, movingPiece, targetPiece, type);

        board = data.board;
        currentTurn = data.nextTurn;

        updateTurnDisplay();
        updateClockDisplay();
        renderFusionDots();
        renderBoard();

        if (window.Sfx) {
            window.Sfx.playMove({
                type,
                captured: !!(targetPiece && MG.getPieceColor(targetPiece) !== MG.getPieceColor(movingPiece)),
                promoted: !!promotedTo
            });
        }
    }

    function renderBoard() {
        if (!isBoardDomCreated) return;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const square = squareNodes[r][c];
                square.classList.toggle('selected', !!(selectedSquare && selectedSquare.r === r && selectedSquare.c === c));

                const moveInfo = validMoves.find(m => m.r === r && m.c === c);
                square.classList.toggle('valid-move', !!(moveInfo && (moveInfo.type === 'normal' || moveInfo.type === 'castle')));
                square.classList.toggle('capture-move', !!(moveInfo && (moveInfo.type === 'capture' || moveInfo.type === 'en_passant')));
                square.classList.toggle('merge-move', !!(moveInfo && moveInfo.type === 'merge'));

                const pieceArr = board[r][c];
                const container = containerNodes[r][c];
                const mainImg = mainImgNodes[r][c];
                const overlayImg = overlayImgNodes[r][c];

                if (pieceArr && pieceArr.length > 0) {
                    container.classList.remove('hidden');
                    container.classList.toggle('fused-piece-bg', pieceArr.some(p => p.includes('_fused')));

                    if (pieceArr.length === 1) {
                        setSrc(mainImg, pieceArr[0].replace('_fused', ''));
                        overlayImg.classList.add('hidden');
                    } else {
                        const hasKing = pieceArr.some(p => p.toLowerCase() === 'k');
                        const mainChar = hasKing ? pieceArr.find(p => p.toLowerCase() === 'k') : pieceArr[0];
                        const overlayChar = hasKing ? pieceArr.find(p => p.toLowerCase() !== 'k') : pieceArr[1];
                        setSrc(mainImg, String(mainChar).replace('_fused', ''));
                        setSrc(overlayImg, String(overlayChar).replace('_fused', ''));
                        overlayImg.classList.remove('hidden');
                    }
                } else {
                    container.classList.add('hidden');
                    container.classList.remove('fused-piece-bg');
                }

                square.setAttribute('aria-label', squareLabel(r, c));
            }
        }
    }

    function setSrc(img, char) {
        const def = PIECES[char];
        if (!def) return;
        if (img.getAttribute('src') !== def.img) img.src = def.img;
    }

    if (window.Sfx) window.Sfx.mountFloatingToggle();
})();
