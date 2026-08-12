# Cagers Game Hub

Echtzeit-Schachvarianten mit Twitch-Login, Hub-Chat und Leaderboard.

| Modus | Pfad | Kurz |
|---|---|---|
| Cagers Quick Chess | `/chess` | Echtzeit, keine Züge — nur Cooldowns pro Figur |
| Mutant Merge Chess | `/mutant-chess` | Zugbasiert, eigene Figuren lassen sich fusionieren |
| VS Cager Bot | `/play-cager` | Stockfish mit Persönlichkeitsprofil (läuft im Browser) |

---

## Schnellstart

```bash
npm install
cp .env.example .env      # ausfüllen, mindestens SESSION_SECRET
npm run dev               # http://localhost:3000
```

Ohne `MONGODB_URI` startet der Server trotzdem — Login, Stats und Leaderboard
sind dann deaktiviert, die Spiele funktionieren. Ohne `TWITCH_CLIENT_ID` gilt
dasselbe für den Login.

`SESSION_SECRET` erzeugen:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In Produktion (`NODE_ENV=production`) **startet der Server ohne
`SESSION_SECRET` bewusst nicht** — ein hartkodiertes Fallback-Secret bedeutet
fälschbare Sessions.

---

## Projektstruktur

```
server.js                  Express + Socket.IO, beide Spiel-Namespaces
models/User.js             Mongoose-Schema inkl. Indizes
public/
  shared/                  Von allen Spielen gemeinsam genutzt
    move-gen.js            Isomorphe Zuggenerierung (Browser + Node)
    piece-assets.js        Figuren-Grafiken, Cooldown-Defaults
    dom-utils.js           Sicheres DOM-Bauen, Escaping, A11y-Helfer
    sounds.js              Sound-Manager
    sounds/*.mp3           11 selbst erzeugte Effekte (CC0)
    shared.css             Fokus-Sichtbarkeit, reduzierte Bewegung, Sound-Button
  hub/                     Startseite, Chat, Leaderboard, Achievements
  chess/                   Cagers Quick Chess
  mutant-chess/            Mutant Merge Chess
  play-cager/              Bot-Modus
  chaos-chess/             Prototyp, aktuell NICHT eingebunden (siehe unten)
test/
  move-gen.test.js         Unit-Tests der Zugregeln (ohne Abhängigkeiten)
  smoke-socket.js          Protokolltests gegen einen laufenden Server
  smoke-ui.js              Zwei echte Browser spielen eine Partie
```

### Warum `public/shared/move-gen.js` der Kern ist

Client und Server benutzen **dieselbe** Funktion zur Zuggenerierung. Der
Server kann dadurch jeden Zug prüfen, ohne dass legale Züge fälschlich
abgelehnt werden — und Regeländerungen können nicht mehr auseinanderlaufen.
Die Datei darf deshalb weder DOM- noch Node-APIs benutzen.

---

## Tests

```bash
npm test                                  # Zugregeln, ohne Abhängigkeiten
npm start &                               # Server für die Smoketests
npm run test:smoke  -- http://localhost:3000   # Protokoll & Cheat-Abwehr
npm run test:ui     -- http://localhost:3000   # UI (braucht playwright)
```

Für den UI-Test:

```bash
npm i -D playwright && npx playwright install chromium
```

---

## Sicherheitsmodell

**Der Server ist die Autorität.** Der Client rendert und schlägt vor.

- Jeder Zug wird serverseitig gegen `move-gen.js` geprüft (Gangart, blockierte
  Felder, Rochade-Rechte, En Passant, Fusionsregeln).
- Brett, Uhren, Cooldowns, Rochade-Rechte und das Ergebnis liegen im Server.
- `apply_move` / `apply_mutant_move` enthalten **nur** vom Server erzeugte
  Werte — nichts wird vom Client durchgereicht.
- Alle Koordinaten werden vor jedem Board-Zugriff auf `0..7` geprüft, und alle
  Socket-Handler laufen in einem `try/catch`. Ein einzelnes fehlerhaftes Event
  kann den Prozess nicht mehr beenden.
- Statistiken für Quick Chess und Mutant bucht der Server selbst beim
  Spielende. Der Client kann sie nicht melden.
- Der Hub-Chat nimmt Absendername und Bild ausschließlich aus der
  Passport-Session.

### Bekannte Einschränkung: Bot-Statistiken

Der Bot-Modus läuft vollständig im Browser — der Server sieht die Partie nie.
Deshalb ist `POST /api/stats/update` weiterhin eine Client-Meldung, aber:

- nur `mode: "bot"` wird akzeptiert (alles andere: `403`),
- maximal ein Ergebnis pro 20 Sekunden und 100 pro Tag und Konto,
- Login ist Pflicht.

Wer die Bot-Achievements wirklich fälschungssicher haben will, müsste die
Partie serverseitig nachspielen (chess.js im Server, PGN mitschicken). Das ist
bewusst nicht umgesetzt.

---

## Sounds

Alle Effekte unter `public/shared/sounds/` wurden mit einem Python-Skript
prozedural synthetisiert (gefilterte Rauschimpulse + gestimmte Körper) und
sind damit **CC0 / gemeinfrei**: keine Attribution nötig, kein Lizenzrisiko,
keine externe Abhängigkeit. Zusammen 68 KB.

`move`, `capture`, `castle`, `check`, `promote`, `game-start`, `game-end`,
`low-time`, `notify`, `illegal`, `cooldown-ready`

Der Sound-Manager (`shared/sounds.js`) kümmert sich um Autoplay-Policy
(Freischaltung bei der ersten Interaktion), einen kleinen Pool je Effekt gegen
Abschneiden bei schnellen Zügen und um die Mute-Einstellung, die über
`localStorage` für alle Spiele gilt. Der Umschalter oben rechts kommt aus
`Sfx.mountFloatingToggle()`.

Neu erzeugen bzw. anpassen: siehe `tools/gen_sounds.py`.

---

## Offene Punkte

- **`public/chaos-chess/` ist nicht eingebunden.** Es fehlt nicht nur die
  Route: der Client verbindet auf den Namespace `/chaos-chess`, den der Server
  gar nicht registriert, und es gibt keinerlei serverseitige Handler für
  `create_chaos_room`, `request_chaos_move` oder `cast_vote`. Der Ordner ist
  absichtlich unverändert geblieben — entweder den Server-Teil nachbauen oder
  den Ordner in einen Feature-Branch verschieben.
- **SRI für externe Skripte.** `play-cager/index.html` lädt chess.js von
  cdnjs ohne `integrity`. Der Hash muss aus der tatsächlich ausgelieferten
  Datei berechnet werden (ein falscher Hash blockiert das Skript und macht die
  Seite unbrauchbar). Noch besser: chess.js und Stockfish lokal ablegen — dann
  kann `connect-src`/`script-src` in der CSP auf `'self'` reduziert werden.
- **chess.js 0.10.3 ist die Legacy-API** (`in_check()`, `game_over()`). Ein
  Upgrade auf 1.x ist ein Breaking Change und wird mit der Zeit teurer.
- **Bot-Engine extrahieren.** `play-cager/client.js` mischt Engine-Anbindung,
  Entscheidungsmatrix, UI, Uhr, Chat, PGN und Persistenz. Eine reine
  `chooseMove(fen, config, clockState) → move` in `engine.js` wäre testbar.

---

## Deployment-Hinweise

- Hinter einem Reverse Proxy ist `app.set('trust proxy', 1)` gesetzt — bei
  mehreren Proxy-Ebenen anpassen, sonst greift das IP-Rate-Limit daneben.
- `NODE_ENV=production` schaltet `cookie.secure`, HSTS und Asset-Caching ein.
  Das setzt HTTPS voraus.
- `ALLOWED_ORIGIN` nur setzen, wenn der Client von einer anderen Domain kommt.
  Leer bedeutet: Socket.IO akzeptiert ausschließlich Same-Origin.
- `GET /healthz` liefert Uptime, DB-Status, Verbindungen und die Anzahl
  offener Räume — gut geeignet für einen Uptime-Check.
- Der Prozess reagiert auf `SIGTERM`/`SIGINT` mit einem sauberen Shutdown.
