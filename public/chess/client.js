/* eslint-env browser */
/**
 * Cagers Quick Chess — Client.
 *
 * Der Server ist die einzige Autorität für Brett, Cooldowns, Rochade-Rechte
 * und Spielergebnis. Dieser Client rendert und schlägt Züge vor.
 */
(function () {
    'use strict';

    const socket = io();
    const MG = window.MoveGen;
    const DU = window.DomUtils;
    const { DEFAULT_COOLDOWNS, buildPieces } = window.PieceAssets;

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
    // SLIDER
    // =====================================================================
    const cdSliders = {};
    ['k', 'p', 'n', 'b', 'r', 'q'].forEach(key => {
        cdSliders[key] = {
            range: document.getElementById(`cd-${key}-range`),
            val: document.getElementById(`cd-${key}-val`)
        };
        const item = cdSliders[key];
        if (item.range && item.val) {
            item.range.addEventListener('input', () => {
                item.val.textContent = parseFloat(item.range.value).toFixed(1);
            });
        }
    });

    // =====================================================================
    // STATE
    // =====================================================================
    let roomCode = null, playerId = null, playerColor = null;
    let isClassLock = true;
    let customCooldowns = Object.assign({}, DEFAULT_COOLDOWNS);
    let myName = '', opponentName = '', opponentPfp = '';
    let selectedSquare = null, opponentSelectedSquare = null;
    let validMoves = [], isGameOver = false, pendingPromotion = null;
    let enPassantTarget = null, isBoardDomCreated = false, isGameStarted = false;

    let PIECES = buildPieces(customCooldowns);

    let board = MG.createInitialBoard();
    let typeCooldowns = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
    let typeCooldownMax = {
        w: Object.assign({}, DEFAULT_COOLDOWNS),
        b: Object.assign({}, DEFAULT_COOLDOWNS)
    };
    let singleCooldowns = Array.from({ length: 8 }, () => Array(8).fill(0));
    let singleCooldownMax = Array.from({ length: 8 }, () => Array(8).fill(DEFAULT_COOLDOWNS.p));
    let hasMoved = MG.createHasMoved();

    // Felder, deren Figur gerade "fliegt": im Modell schon am Ziel, visuell noch
    // unterwegs. Vorher wurde die Figur währenddessen aus dem Brett gelöscht —
    // in einem Echtzeitspiel rechnete getValidMoves dann auf einem Brett mit Loch.
    const animatingSquares = new Set();

    // Aufräumbare Handles (vorher alle lokal -> nie gecleart).
    let countdownInterval = null;
    let reconnectBannerTimeout = null;
    let cooldownRafId = null;
    let isCooldownLoopRunning = false;
    const pendingMoveTimeouts = new Set();
    let latestAnimationEnd = 0;
    let pendingGameOver = null;

    const squareNodes = [];   // Node-Cache statt 64x querySelector pro Frame
    const pieceNodes = [];
    const cdBarNodes = [];

    // =====================================================================
    // DOM-REFERENZEN
    // =====================================================================
    const menuScreen = document.getElementById('menu-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const gameScreen = document.getElementById('game-screen');
    const errorMsg = document.getElementById('error-msg');
    const boardEl = document.getElementById('board');
    const animationLayer = document.getElementById('animation-layer');
    const btnReady = document.getElementById('btn-ready');
    const statusBanner = document.getElementById('status-banner');
    const statusBannerText = document.getElementById('status-banner-text');

    // =====================================================================
    // SESSION
    // =====================================================================
    function updateUIConnectionStatus(status) {
        const indicator = document.getElementById('status-indicator');
        const gameBoard = document.getElementById('board-wrapper');
        const splash = document.getElementById('splash-screen');

        if (status === 'online') {
            if (indicator) { indicator.className = 'status-online'; indicator.textContent = 'Connected'; }
            if (gameBoard) gameBoard.classList.remove('disabled-ui');
            if (splash) splash.style.display = 'none';
        } else {
            if (indicator) { indicator.className = 'status-offline'; indicator.textContent = 'Connection lost... Reconnecting...'; }
            if (gameBoard) gameBoard.classList.add('disabled-ui');
        }
    }

    function getSavedSession() {
        try {
            const data = sessionStorage.getItem('quick_chess_session');
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    }

    function saveSession() {
        if (!roomCode || !playerId || !playerColor) return;
        try {
            sessionStorage.setItem('quick_chess_session', JSON.stringify({
                roomCode, playerId, playerColor, isClassLock, customCooldowns, myName, opponentName, opponentPfp
            }));
        } catch (e) { /* Storage kann blockiert sein */ }
    }

    function clearSession() {
        try { sessionStorage.removeItem('quick_chess_session'); } catch (e) { /* ignore */ }
    }

    socket.on('connect', () => {
        updateUIConnectionStatus('online');
        const saved = getSavedSession();
        if (saved && saved.roomCode && saved.playerId && saved.playerColor) {
            socket.emit('reconnect_room', {
                roomCode: saved.roomCode, playerId: saved.playerId, playerColor: saved.playerColor
            });
        }
    });

    socket.on('disconnect', () => updateUIConnectionStatus('offline'));

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
    // COOLDOWN-ANZEIGE
    // =====================================================================
    function updatePieceCooldownsFromData(cds) {
        if (!cds) return;
        customCooldowns = Object.assign({}, DEFAULT_COOLDOWNS, cds);
        PIECES = buildPieces(customCooldowns);

        ['w', 'b'].forEach(col => {
            typeCooldownMax[col] = Object.assign({}, customCooldowns);
        });

        const formatS = (ms) => (ms / 1000).toFixed(1) + 's';
        ['k', 'p', 'n', 'b', 'r', 'q'].forEach(key => {
            const el = document.getElementById(`lg-${key}-val`);
            if (el) el.textContent = formatS(customCooldowns[key]);
        });
    }

    function getVisualCoords(r, c) {
        const rect = boardEl.getBoundingClientRect();
        const squareSize = rect.width / 8;
        return playerColor === 'b'
            ? { x: (7 - c) * squareSize, y: (7 - r) * squareSize }
            : { x: c * squareSize, y: r * squareSize };
    }

    // =====================================================================
    // MENÜ-AKTIONEN
    // =====================================================================
    document.getElementById('btn-create').addEventListener('click', () => {
        myName = document.getElementById('player-name').value.trim() || 'Player 1';
        const lockEl = document.getElementById('class-lock-check');
        const classLock = lockEl ? lockEl.checked : true;

        const cds = {};
        ['k', 'p', 'n', 'b', 'r', 'q'].forEach(key => {
            cds[key] = parseFloat(cdSliders[key].range.value) * 1000;
        });

        socket.emit('create_room', { playerName: myName, isClassLock: classLock, customCooldowns: cds, pfp: twitchPfp });
    });

    document.getElementById('btn-join').addEventListener('click', () => {
        myName = document.getElementById('player-name').value.trim() || 'Player 2';
        const code = document.getElementById('room-code-input').value.trim();
        if (!code) return showError('Enter code!');
        socket.emit('join_room', { roomCode: code, playerName: myName, pfp: twitchPfp });
    });

    document.getElementById('btn-leave-lobby').addEventListener('click', leaveGame);
    document.getElementById('btn-leave-game').addEventListener('click', leaveGame);
    const backToMenuBtn = document.getElementById('btn-back-to-menu');
    if (backToMenuBtn) backToMenuBtn.addEventListener('click', leaveGame);

    btnReady.addEventListener('click', () => {
        socket.emit('player_ready', { roomCode, playerId });
        btnReady.textContent = 'READY!';
        btnReady.classList.add('is-ready');
        btnReady.disabled = true;
    });

    function leaveGame() { cleanupTimers(); clearSession(); location.reload(); }
    function showError(msg) {
        errorMsg.textContent = msg;
        if (window.Sfx) window.Sfx.play('illegal', { volume: 0.6 });
    }

    /** Räumt alle Timer/Loops ab — vorher liefen sie bis zum Seitenwechsel weiter. */
    function cleanupTimers() {
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        if (reconnectBannerTimeout) { clearTimeout(reconnectBannerTimeout); reconnectBannerTimeout = null; }
        if (cooldownRafId) { cancelAnimationFrame(cooldownRafId); cooldownRafId = null; }
        isCooldownLoopRunning = false;
        pendingMoveTimeouts.forEach(id => clearTimeout(id));
        pendingMoveTimeouts.clear();
    }

    window.addEventListener('beforeunload', cleanupTimers);

    // =====================================================================
    // SOCKET-EVENTS
    // =====================================================================
    socket.on('opponent_select_square', ({ r, c }) => {
        opponentSelectedSquare = (r !== null && r !== undefined) ? { r, c } : null;
        renderBoard();
    });

    socket.on('room_created', (data) => {
        roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color;
        isClassLock = data.isClassLock;
        updatePieceCooldownsFromData(data.customCooldowns);
        saveSession();
        menuScreen.classList.add('hidden');
        lobbyScreen.classList.remove('hidden');
        document.getElementById('display-room-code').textContent = roomCode;
    });

    socket.on('room_joined', (data) => {
        roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color;
        isClassLock = data.isClassLock;
        updatePieceCooldownsFromData(data.customCooldowns);
        opponentName = data.opponentName; opponentPfp = DU.safeImageUrl(data.opponentPfp, '');
        if (data.hasMoved) hasMoved = data.hasMoved;
        enPassantTarget = data.enPassantTarget || null;
        saveSession();
        startGame();
    });

    socket.on('room_reconnected', (data) => {
        roomCode = data.roomCode; playerId = data.playerId; playerColor = data.color;
        isClassLock = data.isClassLock;
        updatePieceCooldownsFromData(data.customCooldowns);
        board = data.board;
        if (data.typeCooldowns) typeCooldowns = data.typeCooldowns;
        if (data.singleCooldowns) singleCooldowns = data.singleCooldowns;
        // Diese beiden fehlten vorher -> der Client bot nach jedem Reconnect
        // eine Rochade an, die der Server als "Cheat" ablehnte.
        if (data.hasMoved) hasMoved = data.hasMoved;
        enPassantTarget = data.enPassantTarget || null;
        isGameStarted = data.isGameStarted;
        isGameOver = data.isGameOver;
        opponentName = data.opponentName || opponentName;
        opponentPfp = DU.safeImageUrl(data.opponentPfp, '') || opponentPfp;

        animatingSquares.clear();
        saveSession();
        startGame();

        if (Array.isArray(data.playersReady)) {
            data.playersReady.forEach(p => {
                const badgeEl = document.getElementById(p.color === playerColor ? 'bottom-ready-badge' : 'top-ready-badge');
                if (p.ready && badgeEl) { badgeEl.textContent = 'READY'; badgeEl.classList.add('ready'); }
            });
        }

        if (isGameStarted) {
            btnReady.textContent = 'READY!';
            btnReady.classList.add('is-ready');
            btnReady.disabled = true;
        }
    });

    socket.on('opponent_joined', (data) => {
        opponentName = data.opponentName;
        opponentPfp = DU.safeImageUrl(data.opponentPfp, '');
        saveSession();
        startGame();
        if (window.Sfx) window.Sfx.play('notify');
    });

    socket.on('opponent_disconnected', (data) => {
        const secs = (data && data.countdownSeconds) || 30;
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = `Opponent disconnected! Forfeit in ${secs}s...`;
    });

    socket.on('opponent_reconnected', () => {
        statusBanner.classList.remove('hidden');
        statusBannerText.textContent = 'Opponent reconnected!';
        if (reconnectBannerTimeout) clearTimeout(reconnectBannerTimeout);
        reconnectBannerTimeout = setTimeout(() => {
            reconnectBannerTimeout = null;
            if (!isGameOver) statusBanner.classList.add('hidden');
        }, 2000);
    });

    socket.on('game_over', ({ winnerColor, reason }) => {
        isGameOver = true;
        clearSession();
        // Stats bucht jetzt der Server — kein saveGameResult mehr im Client.

        let text;
        if (winnerColor === null) text = 'Draw!';
        else if (winnerColor === playerColor) {
            text = reason === 'disconnect' ? 'Victory! Opponent failed to reconnect!' : 'Victory! Enemy King captured!';
        } else {
            text = reason === 'disconnect' ? 'Defeat by Disconnect!' : 'Defeat! Your King was captured!';
        }

        // Overlay erst zeigen, wenn die laufende Zug-Animation durch ist.
        const delay = Math.max(0, latestAnimationEnd - Date.now());
        pendingGameOver = text;
        setTimeout(showGameOverOverlay, delay + 60);
    });

    function showGameOverOverlay() {
        if (!pendingGameOver) return;
        document.getElementById('winner-text').textContent = pendingGameOver;
        document.getElementById('game-over').style.display = 'flex';
        pendingGameOver = null;
        if (window.Sfx) window.Sfx.play('game-end');
    }

    socket.on('ready_update', ({ playersReady }) => {
        playersReady.forEach(p => {
            const badgeEl = document.getElementById(p.color === playerColor ? 'bottom-ready-badge' : 'top-ready-badge');
            if (p.ready && badgeEl) { badgeEl.textContent = 'READY'; badgeEl.classList.add('ready'); }
        });
    });

    socket.on('start_match_countdown', (data) => {
        if (data.isClassLock !== undefined) isClassLock = data.isClassLock;
        if (data.customCooldowns) updatePieceCooldownsFromData(data.customCooldowns);
        if (isClassLock && data.typeCooldowns) typeCooldowns = data.typeCooldowns;
        if (!isClassLock && data.singleCooldowns) singleCooldowns = data.singleCooldowns;

        isGameStarted = false;
        statusBanner.classList.remove('hidden');

        let s = 10;
        statusBannerText.textContent = `Match Starting in ${s}s!`;
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            s--;
            if (s > 0) {
                statusBannerText.textContent = `Match Starting in ${s}s!`;
            } else {
                clearInterval(countdownInterval);
                countdownInterval = null;
                isGameStarted = true;
                statusBanner.classList.add('hidden');
                if (window.Sfx) window.Sfx.play('game-start');
            }
        }, 1000);
    });

    socket.on('apply_move', (moveData) => {
        if (moveData.playerId !== playerId) opponentSelectedSquare = null;
        // Rochade-/En-Passant-Rechte kommen jetzt vom Server mit jedem Zug.
        if (moveData.hasMoved) hasMoved = moveData.hasMoved;
        enPassantTarget = moveData.enPassantTarget || null;
        executeMove(moveData);
    });

    socket.on('error_msg', (msg) => showError(typeof msg === 'string' ? msg : 'Error'));

    // =====================================================================
    // BRETT
    // =====================================================================
    function startGame() {
        menuScreen.classList.add('hidden');
        lobbyScreen.classList.add('hidden');
        gameScreen.classList.remove('hidden');

        document.getElementById('my-role-tag').textContent = playerColor === 'w' ? 'WHITE' : 'BLACK';
        document.getElementById('mode-display-tag').textContent = isClassLock ? 'CLASS LOCK' : 'SINGLE PIECE';
        document.getElementById('bottom-player-name').textContent = myName + ' (You)';
        document.getElementById('top-player-name').textContent = opponentName || 'Opponent';

        const bottomPfpEl = document.getElementById('bottom-pfp');
        if (twitchPfp) { bottomPfpEl.src = twitchPfp; bottomPfpEl.classList.remove('hidden'); }

        const topPfpEl = document.getElementById('top-pfp');
        if (opponentPfp) { topPfpEl.src = opponentPfp; topPfpEl.classList.remove('hidden'); }

        if (playerColor === 'b') boardEl.classList.add('flipped');

        createBoardDOMOnce();
        renderBoard();
        startCooldownLoop();
    }

    function createBoardDOMOnce() {
        if (isBoardDomCreated) return;
        DU.clear(boardEl);
        boardEl.setAttribute('role', 'grid');
        boardEl.setAttribute('aria-label', 'Schachbrett');

        for (let r = 0; r < 8; r++) {
            squareNodes[r] = []; pieceNodes[r] = []; cdBarNodes[r] = [];
            for (let c = 0; c < 8; c++) {
                const square = document.createElement('div');
                square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.r = r;
                square.dataset.c = c;

                const pieceImg = document.createElement('img');
                pieceImg.className = 'piece hidden';
                pieceImg.alt = '';
                square.appendChild(pieceImg);

                const cdBar = document.createElement('div');
                cdBar.className = 'cd-bar';
                cdBar.id = `cd-${r}-${c}`;
                square.appendChild(cdBar);

                square.addEventListener('click', () => handleSquareClick(r, c));
                // Vorher war das Brett per Tastatur nicht bedienbar.
                DU.makeKeyboardActivatable(square, () => handleSquareClick(r, c), squareLabel(r, c));
                square.setAttribute('role', 'gridcell');

                boardEl.appendChild(square);
                squareNodes[r][c] = square;
                pieceNodes[r][c] = pieceImg;
                cdBarNodes[r][c] = cdBar;
            }
        }
        isBoardDomCreated = true;
    }

    const PIECE_NAMES = { p: 'Bauer', n: 'Springer', b: 'Läufer', r: 'Turm', q: 'Dame', k: 'König' };

    function squareLabel(r, c) {
        const file = String.fromCharCode(97 + c);
        const rank = 8 - r;
        const piece = board[r] && board[r][c];
        if (!piece) return `${file}${rank}, leer`;
        const color = MG.colorOf(piece) === 'w' ? 'Weiß' : 'Schwarz';
        return `${file}${rank}, ${color} ${PIECE_NAMES[piece.toLowerCase()] || piece}`;
    }

    function calculateMoveDuration(fR, fC, tR, tC) {
        return Math.round(250 + Math.sqrt((tR - fR) ** 2 + (tC - fC) ** 2) * 250);
    }

    /** Identische Funktion wie auf dem Server — daher nie mehr "Illegal move". */
    function getValidMoves(r, c) {
        return MG.classicMoves(board, r, c, { enPassantTarget, hasMoved });
    }

    function handleSquareClick(r, c) {
        if (!isGameStarted || isGameOver || pendingPromotion) return;
        const now = Date.now();
        const clickedPiece = board[r][c];

        if (selectedSquare) {
            const currentPiece = board[selectedSquare.r][selectedSquare.c];
            if (!currentPiece || MG.colorOf(currentPiece) !== playerColor) {
                selectedSquare = null; validMoves = [];
            }
        }

        if (selectedSquare) {
            const moveInfo = validMoves.find(m => m.r === r && m.c === c);
            if (moveInfo) {
                const piece = board[selectedSquare.r][selectedSquare.c];
                if (piece && piece.toLowerCase() === 'p' && (r === 0 || r === 7)) {
                    triggerPromotion(selectedSquare.r, selectedSquare.c, r, c, MG.colorOf(piece));
                    return;
                }
                const duration = calculateMoveDuration(selectedSquare.r, selectedSquare.c, r, c);
                socket.emit('request_move', {
                    roomCode, playerId,
                    fromR: selectedSquare.r, fromC: selectedSquare.c, toR: r, toC: c,
                    promotedTo: null, duration
                });
                selectedSquare = null; validMoves = [];
                socket.emit('select_square', { roomCode, r: null, c: null });
                renderBoard();
                return;
            }
        }

        if (clickedPiece && MG.colorOf(clickedPiece) === playerColor) {
            const pieceKey = clickedPiece.toLowerCase();
            const isOnCooldown = isClassLock
                ? (typeCooldowns[playerColor][pieceKey] > now)
                : (singleCooldowns[r][c] > now);
            if (!isOnCooldown) {
                selectedSquare = { r, c };
                validMoves = getValidMoves(r, c);
                socket.emit('select_square', { roomCode, r, c });
                renderBoard();
                return;
            }
            if (window.Sfx) window.Sfx.play('illegal', { volume: 0.45 });
        }

        selectedSquare = null; validMoves = [];
        socket.emit('select_square', { roomCode, r: null, c: null });
        renderBoard();
    }

    /**
     * Führt den vom Server bestätigten Zug aus.
     * Wichtig: Das Zielfeld wird SOFORT im Modell gesetzt und nur visuell
     * bis zum Animationsende ausgeblendet.
     */
    function executeMove(data) {
        const { fromR, fromC, toR, toC, moveInfo, promotedTo, captured } = data;
        const duration = data.duration || 500;

        const piece = board[fromR][fromC];
        if (!piece) return;

        const pieceChar = promotedTo || piece;
        const color = MG.colorOf(piece);
        const finalKey = pieceChar.toLowerCase();
        const cdDuration = (PIECES[pieceChar] && PIECES[pieceChar].cd) || DEFAULT_COOLDOWNS[finalKey] || 3500;
        const cdEndTime = Date.now() + cdDuration;

        if (moveInfo && moveInfo.type === 'en_passant') {
            const epRow = color === 'w' ? toR + 1 : toR - 1;
            if (epRow >= 0 && epRow < 8) board[epRow][toC] = null;
        }

        if (isClassLock) {
            typeCooldowns[color][finalKey] = cdEndTime;
            typeCooldownMax[color][finalKey] = cdDuration;
        } else {
            singleCooldowns[fromR][fromC] = 0;
        }

        const startCoords = getVisualCoords(fromR, fromC);
        const targetCoords = getVisualCoords(toR, toC);

        // Modell sofort konsistent halten, Darstellung verzögert.
        board[fromR][fromC] = null;
        board[toR][toC] = pieceChar;
        const destKey = `${toR},${toC}`;
        animatingSquares.add(destKey);
        renderBoard();

        const squareSize = boardEl.getBoundingClientRect().width / 8;

        const wrapper = document.createElement('div');
        wrapper.className = 'animating-wrapper';
        wrapper.style.left = `${startCoords.x}px`;
        wrapper.style.top = `${startCoords.y}px`;
        wrapper.style.transitionDuration = `${duration}ms`;
        wrapper.style.width = `${squareSize}px`;
        wrapper.style.height = `${squareSize}px`;
        wrapper.dataset.cdEnd = cdEndTime;
        wrapper.dataset.maxCd = cdDuration;

        const animImg = document.createElement('img');
        animImg.className = 'piece';
        animImg.alt = '';
        animImg.src = PIECES[pieceChar].img;
        wrapper.appendChild(animImg);

        const floatCdBar = document.createElement('div');
        floatCdBar.className = 'cd-bar';
        wrapper.appendChild(floatCdBar);
        animationLayer.appendChild(wrapper);

        let rookWrapper = null;
        let rookDestKey = null;
        if (moveInfo && moveInfo.type === 'castle') {
            const row = fromR;
            const rFromC = toC === 6 ? 7 : 0;
            const rToC = toC === 6 ? 5 : 3;
            const rookPiece = board[row][rFromC];
            if (rookPiece) {
                board[row][rFromC] = null;
                board[row][rToC] = rookPiece;
                rookDestKey = `${row},${rToC}`;
                animatingSquares.add(rookDestKey);
                if (!isClassLock) singleCooldowns[row][rFromC] = 0;
                renderBoard();

                const rStart = getVisualCoords(row, rFromC);
                const rTarget = getVisualCoords(row, rToC);
                rookWrapper = document.createElement('div');
                rookWrapper.className = 'animating-wrapper';
                rookWrapper.style.left = `${rStart.x}px`;
                rookWrapper.style.top = `${rStart.y}px`;
                rookWrapper.style.transitionDuration = `${duration}ms`;
                rookWrapper.style.width = `${squareSize}px`;
                rookWrapper.style.height = `${squareSize}px`;

                const rImg = document.createElement('img');
                rImg.className = 'piece';
                rImg.alt = '';
                rImg.src = PIECES[rookPiece].img;
                rookWrapper.appendChild(rImg);
                animationLayer.appendChild(rookWrapper);
                requestAnimationFrame(() => {
                    rookWrapper.style.transform = `translate(${rTarget.x - rStart.x}px, ${rTarget.y - rStart.y}px)`;
                });
            }
        }

        requestAnimationFrame(() => {
            wrapper.style.transform = `translate(${targetCoords.x - startCoords.x}px, ${targetCoords.y - startCoords.y}px)`;
        });

        if (window.Sfx) {
            window.Sfx.playMove({
                type: moveInfo ? moveInfo.type : 'normal',
                captured: !!captured,
                promoted: !!promotedTo
            });
        }

        latestAnimationEnd = Math.max(latestAnimationEnd, Date.now() + duration);

        const timeoutId = setTimeout(() => {
            pendingMoveTimeouts.delete(timeoutId);
            if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
            if (rookWrapper && rookWrapper.parentNode) rookWrapper.parentNode.removeChild(rookWrapper);

            animatingSquares.delete(destKey);
            if (rookDestKey) animatingSquares.delete(rookDestKey);

            if (!isClassLock) {
                singleCooldowns[toR][toC] = cdEndTime;
                singleCooldownMax[toR][toC] = cdDuration;
            }
            renderBoard();
        }, duration);
        pendingMoveTimeouts.add(timeoutId);
    }

    function triggerPromotion(fromR, fromC, toR, toC, color) {
        pendingPromotion = { fromR, fromC, toR, toC, color };
        const modalEl = document.getElementById('promotion-modal');
        const box = document.getElementById('promo-options');
        DU.clear(box);

        const options = color === 'w' ? ['Q', 'R', 'N', 'B'] : ['q', 'r', 'n', 'b'];
        options.forEach(p => {
            const img = document.createElement('img');
            img.className = 'promo-piece';
            img.src = PIECES[p].img;
            img.alt = PIECE_NAMES[p.toLowerCase()];
            const choose = () => {
                modalEl.style.display = 'none';
                pendingPromotion = null;
                const duration = calculateMoveDuration(fromR, fromC, toR, toC);
                socket.emit('request_move', {
                    roomCode, playerId, fromR, fromC, toR, toC, promotedTo: p, duration
                });
                selectedSquare = null; validMoves = [];
                socket.emit('select_square', { roomCode, r: null, c: null });
                renderBoard();
            };
            img.addEventListener('click', choose);
            DU.makeKeyboardActivatable(img, choose, `Umwandeln in ${PIECE_NAMES[p.toLowerCase()]}`);
            box.appendChild(img);
        });
        modalEl.setAttribute('role', 'dialog');
        modalEl.setAttribute('aria-modal', 'true');
        modalEl.style.display = 'flex';
        const first = box.firstChild;
        if (first && first.focus) first.focus();
    }

    function renderBoard() {
        if (!isBoardDomCreated) return;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const square = squareNodes[r][c];
                square.classList.toggle('selected', !!(selectedSquare && selectedSquare.r === r && selectedSquare.c === c));
                square.classList.toggle('opponent-selected', !!(opponentSelectedSquare && opponentSelectedSquare.r === r && opponentSelectedSquare.c === c));

                const moveInfo = validMoves.find(m => m.r === r && m.c === c);
                square.classList.toggle('valid-move', !!(moveInfo && (moveInfo.type === 'normal' || moveInfo.type === 'castle')));
                square.classList.toggle('capture-move', !!(moveInfo && (moveInfo.type === 'capture' || moveInfo.type === 'en_passant')));

                const piece = board[r][c];
                const img = pieceNodes[r][c];
                // Figur existiert im Modell, wird aber gerade animiert -> nur ausblenden.
                if (piece && !animatingSquares.has(`${r},${c}`)) {
                    const src = PIECES[piece].img;
                    if (img.getAttribute('src') !== src) img.src = src;
                    img.classList.remove('hidden');
                } else {
                    img.classList.add('hidden');
                }
                square.setAttribute('aria-label', squareLabel(r, c));
            }
        }
    }

    /** Genau eine rAF-Schleife — vorher startete jeder Reconnect eine weitere. */
    function startCooldownLoop() {
        if (isCooldownLoopRunning) return;
        isCooldownLoopRunning = true;
        cooldownRafId = requestAnimationFrame(updateCooldowns);
    }

    function updateCooldowns() {
        if (isGameOver) {
            isCooldownLoopRunning = false;
            cooldownRafId = null;
            return; // vorher lief die Schleife auch nach Spielende weiter
        }

        const now = Date.now();
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const squareEl = squareNodes[r][c];
                const cdBar = cdBarNodes[r][c];
                if (!squareEl || !cdBar) continue;

                const piece = board[r][c];
                let cdEnd, maxCd;
                if (isClassLock) {
                    cdEnd = piece ? typeCooldowns[MG.colorOf(piece)][piece.toLowerCase()] : 0;
                    maxCd = piece ? typeCooldownMax[MG.colorOf(piece)][piece.toLowerCase()] : 1000;
                } else {
                    cdEnd = singleCooldowns[r][c];
                    maxCd = singleCooldownMax[r][c];
                }

                if (cdEnd > now) {
                    cdBar.style.width = `${Math.min(100, Math.max(0, ((cdEnd - now) / maxCd) * 100))}%`;
                    squareEl.classList.add('locked');
                } else {
                    if (cdBar.style.width !== '0%') cdBar.style.width = '0%';
                    squareEl.classList.remove('locked');
                }
            }
        }

        animationLayer.querySelectorAll('.animating-wrapper').forEach(wrap => {
            const cdEnd = parseFloat(wrap.dataset.cdEnd);
            const maxCd = parseFloat(wrap.dataset.maxCd);
            const floatBar = wrap.querySelector('.cd-bar');
            if (floatBar && cdEnd) {
                floatBar.style.width = cdEnd > now
                    ? `${Math.min(100, Math.max(0, ((cdEnd - now) / maxCd) * 100))}%`
                    : '0%';
            }
        });

        cooldownRafId = requestAnimationFrame(updateCooldowns);
    }

    if (window.Sfx) window.Sfx.mountFloatingToggle();
})();
