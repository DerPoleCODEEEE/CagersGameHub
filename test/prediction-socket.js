/**
 * Protokolltest für Prediction Chess.
 *
 *   PORT=3112 PREDICTION_START_COINS=20 node server.js &
 *   node test/prediction-socket.js http://localhost:3112
 */
'use strict';

const { io } = require('socket.io-client');
const URL = process.argv[2] || 'http://localhost:3112';
const NS = URL + '/prediction-chess';

let passed = 0, failed = 0;
const log = (ok, name, extra) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function once(socket, event, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout: ' + event)), timeout);
        socket.once(event, (d) => { clearTimeout(t); resolve(d); });
    });
}
const maybe = (s, e, ms = 1200) => once(s, e, ms).catch(() => null);

/** e2 = {r:6,c:4} */
const sq = (name) => ({ r: 8 - parseInt(name[1], 10), c: name.charCodeAt(0) - 97 });
const mv = (from, to) => {
    const a = sq(from), b = sq(to);
    return { fromR: a.r, fromC: a.c, toR: b.r, toC: b.c };
};

async function newGame(name) {
    const w = io(NS, { transports: ['websocket'] });
    const b = io(NS, { transports: ['websocket'] });
    await Promise.all([once(w, 'connect'), once(b, 'connect')]);
    w.emit('create_prediction_room', { playerName: 'Alice', colorChoice: 'w' });
    const created = await once(w, 'prediction_room_created');
    b.emit('join_prediction_room', { roomCode: created.roomCode, playerName: 'Bob' });
    await once(b, 'prediction_room_joined');
    const started = once(w, 'match_started', 8000);
    w.emit('player_ready', { roomCode: created.roomCode });
    b.emit('player_ready', { roomCode: created.roomCode });
    await once(w, 'start_match_countdown');
    await started;
    return { w, b, code: created.roomCode };
}

/** Zieht und wartet auf die Bestätigung beim Gegner. */
async function play(sock, otherSock, code, from, to, prediction, extra) {
    const applied = once(otherSock, 'apply_prediction_move', 5000);
    const mine = once(sock, 'apply_prediction_move', 5000);
    sock.emit('request_prediction_move', Object.assign(
        { roomCode: code }, mv(from, to),
        { prediction: prediction ? mv(prediction[0], prediction[1]) : null },
        extra || {}
    ));
    const [res] = await Promise.all([mine, applied]);
    return res;
}

(async () => {
    console.log(`\nPrediction Chess gegen ${NS}\n`);

    // =================================================================
    console.log('— Grundablauf —');
    let g = await newGame();
    log(true, 'Raum, Beitritt und Countdown laufen durch');

    // Weiß zieht e2-e4 und tippt auf e7-e5
    let st = await play(g.w, g.b, g.code, 'e2', 'e4', ['e7', 'e5']);
    log(st.turn === 'b', 'Zugrecht wechselt zu Schwarz');
    log(st.board[4][4] === 'P', 'Bauer steht auf e4');
    log(st.coins.w === 20, 'Noch keine Münze — der Tipp ist erst offen');

    // Schwarz erfüllt den Tipp
    st = await play(g.b, g.w, g.code, 'e7', 'e5', ['g1', 'f3']);
    log(st.predictionResult.by === 'w' && st.predictionResult.hit === true, 'Treffer wird erkannt');
    log(st.coins.w === 21, `Treffer bringt genau 1 Münze (${st.coins.w})`);
    log(st.streak.w === 1, 'Streak steht auf 1');
    log(st.predictionResult.arrows.length === 1, 'Der Pfeil wird für beide aufgedeckt');

    // Weiß tippt falsch
    st = await play(g.w, g.b, g.code, 'g1', 'f3', ['b8', 'c6']);
    st = await play(g.b, g.w, g.code, 'g8', 'f6', null);
    log(st.predictionResult.hit === false, 'Fehlschuss wird erkannt');
    log(st.coins.w === 21, 'Fehlschuss bringt keine Münze');
    log(st.streak.w === 0, 'Fehlschuss setzt die Streak zurück');

    // Kein Tipp abgegeben → Streak bleibt bei 0, kein Absturz
    st = await play(g.w, g.b, g.code, 'f1', 'c4', null);
    log(st.turn === 'b', 'Zug ohne Tipp funktioniert');

    // =================================================================
    console.log('\n— Regelverstöße —');
    let err = once(g.b, 'error_msg', 2000);
    g.b.emit('request_prediction_move', Object.assign({ roomCode: g.code }, mv('a7', 'a4')));
    log(/illegal/i.test(await err), 'Illegaler Zug wird abgelehnt');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('request_prediction_move', Object.assign({ roomCode: g.code }, mv('a2', 'a3')));
    log(/not your turn/i.test(await err), 'Zug außerhalb der Reihe wird abgelehnt');

    err = once(g.b, 'error_msg', 2000);
    g.b.emit('request_prediction_move', { roomCode: g.code, fromR: 99, fromC: -3, toR: 'x', toC: {} });
    await err;
    await wait(200);
    const alive = await fetch(URL + '/healthz').then(r => r.ok).catch(() => false);
    log(alive, 'Server überlebt Müll-Koordinaten');

    g.w.close(); g.b.close();

    // =================================================================
    console.log('\n— Shop: Absicherung —');
    g = await newGame();

    err = once(g.b, 'error_msg', 2000);
    g.b.emit('buy_item', { roomCode: g.code, itemId: 'pawn_storm', targets: [] });
    log(/not your turn/i.test(await err), 'Kauf außerhalb der Reihe wird abgelehnt');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'nonsense', targets: [] });
    log(/no such item/i.test(await err), 'Erfundene Item-ID wird abgelehnt');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'freeze', targets: [{ r: 0, c: 4 }] });
    log(/king/i.test(await err), 'Der König lässt sich nicht fesseln');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'freeze', targets: [{ r: 6, c: 4 }] });
    log(/your own piece/i.test(await err), 'Eigene Figur lässt sich nicht fesseln');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'recruit', targets: [{ r: 2, c: 3 }] });
    log(/own half/i.test(await err), 'Rekrut nur in der eigenen Hälfte');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'resurrect', targets: [{ index: 0 }, { r: 5, c: 3 }] });
    log(/not lost a piece/i.test(await err), 'Wiedergeburt ohne Verlust wird abgelehnt');

    // =================================================================
    console.log('\n— Shop: Wirkung —');
    let bought = once(g.w, 'item_purchased', 3000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'freeze', targets: [{ r: 0, c: 1 }] });
    let st2 = await bought;
    log(st2.coins.w === 17, `Fesselung kostet 3 Münzen (${st2.coins.w})`);
    log(st2.effects.some(e => e.id === 'freeze'), 'Effekt erscheint in der Effektleiste');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'pawn_storm', targets: [] });
    log(/already used an item/i.test(await err), 'Nur ein Item pro Zug');

    // Der gefesselte Springer b8 darf nicht ziehen
    await play(g.w, g.b, g.code, 'e2', 'e4', null);
    err = once(g.b, 'error_msg', 2000);
    g.b.emit('request_prediction_move', Object.assign({ roomCode: g.code }, mv('b8', 'c6')));
    log(/illegal/i.test(await err), 'Gefesselter Springer kann nicht ziehen');
    st = await play(g.b, g.w, g.code, 'd7', 'd5', null);
    log(st.effects.some(e => e.id === 'freeze' && e.pliesLeft === 1), 'Fesselung zählt herunter');

    // Cavalry: Turm a1 bekommt Springerzüge
    bought = once(g.w, 'item_purchased', 3000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'cavalry', targets: [{ r: 7, c: 0 }] });
    await bought;
    st = await play(g.w, g.b, g.code, 'a1', 'b3', null);
    log(st.board[5][1] === 'R', 'Turm springt dank Kavallerie nach b3');

    // Doppelmünzen und Streak-Schutz sind Ladungen, keine Dauer
    st = await play(g.b, g.w, g.code, 'd5', 'e4', null);
    bought = once(g.w, 'item_purchased', 3000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'streak_shield', targets: [] });
    st2 = await bought;
    log(st2.effects.some(e => e.id === 'streak_shield' && e.chargesLeft === 1), 'Streak-Schutz hat eine Ladung');

    g.w.close(); g.b.close();

    // =================================================================
    console.log('\n— Doppelzug —');
    g = await newGame();
    // Erst eine schlagbare Figur aufs Brett bringen: e4 kann später d5 nehmen.
    await play(g.w, g.b, g.code, 'e2', 'e4', null);
    await play(g.b, g.w, g.code, 'd7', 'd5', null);

    bought = once(g.w, 'item_purchased', 3000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'double_move', targets: [] });
    st2 = await bought;
    log(st2.coins.w === 14, `Doppelzug kostet 6 Münzen (${st2.coins.w})`);

    // Zur Sicherheit: exd5 wäre jetzt ein ganz normaler legaler Zug.
    st = await play(g.w, g.b, g.code, 'b1', 'c3', null);
    log(st.turn === 'w' && st.extraMove === true, 'Nach dem ersten Zug bleibt Weiß am Zug');

    err = once(g.w, 'error_msg', 2000);
    g.w.emit('request_prediction_move', Object.assign({ roomCode: g.code }, mv('e4', 'd5')));
    log(/illegal/i.test(await err), 'Zweiter Zug darf nicht schlagen');

    st = await play(g.w, g.b, g.code, 'd2', 'd4', null);
    log(st.turn === 'b', 'Nach dem zweiten (stillen) Zug ist Schwarz dran');
    log(st.board[3][3] === 'p', 'Der schwarze Bauer auf d5 steht unangetastet');

    // Und danach greift die Beschränkung nicht mehr.
    await play(g.b, g.w, g.code, 'g8', 'f6', null);
    st = await play(g.w, g.b, g.code, 'e4', 'd5', null);
    log(st.board[3][3] === 'P', 'Ohne Doppelzug ist exd5 wieder erlaubt');

    g.w.close(); g.b.close();

    // =================================================================
    console.log('\n— Matt —');
    g = await newGame();
    // Narrenmatt: f2-f3, e7-e5, g2-g4, Dd8-h4#
    await play(g.w, g.b, g.code, 'f2', 'f3', null);
    await play(g.b, g.w, g.code, 'e7', 'e5', null);
    await play(g.w, g.b, g.code, 'g2', 'g4', null);
    const over = once(g.w, 'game_over', 4000);
    g.b.emit('request_prediction_move', Object.assign({ roomCode: g.code }, mv('d8', 'h4')));
    const result = await over;
    log(result.winnerColor === 'b' && result.reason === 'checkmate', 'Narrenmatt wird erkannt');
    log(!!result.summary && typeof result.summary.hits === 'object', 'Abschlussstatistik wird mitgeschickt');
    g.w.close(); g.b.close();

    // =================================================================
    console.log('\n— Nebel des Krieges —');
    g = await newGame();
    bought = once(g.w, 'item_purchased', 3000);
    g.w.emit('buy_item', { roomCode: g.code, itemId: 'fog', targets: [] });
    st2 = await bought;
    log(st2.fogPlies === 8, `Nebel läuft 8 Halbzüge (${st2.fogPlies})`);
    log(st2.board[0][0] === null, 'Gegnerischer Turm a8 ist unsichtbar');
    log(st2.board[7][4] === 'K', 'Eigene Figuren bleiben sichtbar');
    log(Array.isArray(st2.visible) && st2.visible.length > 0, 'Sichtfeld wird mitgeschickt');
    log(st2.board[1][4] === null, 'Auch die gegnerischen Bauern sind weg (kein Leak)');

    g.w.close(); g.b.close();

    console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('\nTest abgebrochen:', err.message);
    process.exit(1);
});
