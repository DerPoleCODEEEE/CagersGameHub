# Cagers Game Hub

Echtzeit-Schachvarianten mit Twitch-Login, Hub-Chat und Leaderboard.

| Modus | Pfad | Kurz |
|---|---|---|
| Cagers Quick Chess | `/chess` | Echtzeit, keine Züge — nur Cooldowns pro Figur |
| Mutant Merge Chess | `/mutant-chess` | Zugbasiert, eigene Figuren lassen sich fusionieren |
| VS Cager Bot | `/play-cager` | Stockfish mit Persönlichkeitsprofil (läuft im Browser) |
| Prediction Chess | `/prediction-chess` | Normales Schach — plus Zugvorhersage, Münzen und Item-Shop |

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
server.js                  Express + Socket.IO, Namespaces der Spielmodi
prediction-chess.js        Server-Logik für Prediction Chess (eigener Namespace)
models/User.js             Mongoose-Schema inkl. Indizes
public/
  shared/                  Von allen Spielen gemeinsam genutzt
    move-gen.js            Isomorphe Zuggenerierung (Browser + Node)
    board-arrows.js        Zeichenpfeile zum Rechnen (rein lokal)
    items.js               Item-Registry für Prediction Chess (isomorph)
    piece-assets.js        Figuren-Grafiken, Cooldown-Defaults
    dom-utils.js           Sicheres DOM-Bauen, Escaping, A11y-Helfer
    sounds.js              Sound-Manager
    sounds/*.mp3           11 selbst erzeugte Effekte (CC0)
    shared.css             Fokus-Sichtbarkeit, reduzierte Bewegung, Sound-Button
  hub/                     Startseite, Chat, Leaderboard, Achievements
  chess/                   Cagers Quick Chess
  mutant-chess/            Mutant Merge Chess
  prediction-chess/        Prediction Chess
  play-cager/              Bot-Modus
  chaos-chess/             Prototyp, aktuell NICHT eingebunden (siehe unten)
test/
  move-gen.test.js         Unit-Tests der Zugregeln (ohne Abhängigkeiten)
  smoke-socket.js          Protokolltests gegen einen laufenden Server
  smoke-ui.js              Zwei echte Browser spielen eine Partie
  prediction-socket.js     Protokoll & Shop-Absicherung für Prediction Chess
  prediction-ui.js         Zwei Browser spielen mit Tipps und Käufen
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

# Prediction Chess (Startguthaben, damit Käufe prüfbar sind)
PORT=3112 PREDICTION_START_COINS=20 npm start &
npm run test:prediction     -- http://localhost:3112
npm run test:prediction:ui  -- http://localhost:3112
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

## Prediction Chess

Normales Schach mit einer zweiten Ebene: Wer zieht, sagt im selben Paket den
nächsten Zug des Gegners voraus. Ein Treffer bringt Münzen, Münzen kaufen Items,
die sofort wirken.

### Regeln in Kurzform

- **Keine Schachuhr**, sondern **90 Sekunden pro Zug** (`PREDICTION_MOVE_MS`).
  Kein Zeitdruck, aber niemand kann die Partie blockieren.
- **Erst ziehen, dann tippen, dann bestätigen.** Zug und Pfeil werden lokal
  vorgemerkt und sind für den Gegner unsichtbar. Erst „Send turn" (oder Enter)
  schickt beides in einem Paket raus. Bis dahin lässt sich der Pfeil beliebig
  neu ziehen und der Zug zurücknehmen.
- **Hilfspfeile zum Rechnen**: Rechtsklick ziehen, orange, rein lokal. In
  Prediction Chess nur während der Gegner denkt — in der eigenen Zugphase
  gehört der Rechtsklick dem Tipp. Nach jedem Zug sind sie weg.
- **Raum-Chat** links neben dem Brett. Der Absendername kommt ausschließlich aus
  dem Raum-Zustand des Servers, Nachrichten werden als Text gerendert.
- **Tippen ist Pflicht.** Ausnahme: der zweite Zug eines Double Move.
- **Swap Places, Recruit und Revival sind Züge.** Sie verbrauchen den Zug, dürfen
  kein Schach geben, und ein falscher Tipp auf sie **reißt die Serie nicht** —
  niemand kann ein Item kommen sehen.
- **Nur exakte Treffer** zählen (Start- *und* Zielfeld). Danach wird der Pfeil
  für **beide** aufgedeckt — grün oder rot.
- Streak-Multiplikator: ×2 ab 3, ×3 ab 5, ×4 ab 8.
- **Double Coins und Long Shot zahlen flach** (2 bzw. 3) und ignorieren die
  Serie — mit Multiplikator kämen sonst zweistellige Beträge zusammen.
- **Kaufen nur am Zug, nur ein Item pro Zug, nie im Schach.** Der Shop ist in
  diesen Fällen sichtbar gesperrt (ausgegraut, Schloss, Grund im Klartext).

### Auslieferung

Code und Markup werden mit `Cache-Control: no-cache` ausgeliefert und über ETag
revalidiert (Antwort ist fast immer ein leeres `304`). Vorher lag `/shared/*`
sieben Tage im Browser-Cache — nach einem Deploy mischte der Client dann eine
alte `move-gen.js` mit neuem Code, was sich als `MoveGen.legalMoves is not a
function` äußerte. Bilder und Sounds bleiben einen Tag im Cache.

Der Client prüft beim Start, ob die gemeinsamen Dateien die erwarteten Funktionen
mitbringen, und zeigt sonst eine sichtbare Meldung statt einer stumm toten Seite.

### Warum kein Item die Partie gewinnt

Beim Entwurf sind bewusst mehrere Ideen rausgeflogen: alles, was den Zug des
Gegners *erzwingt* (nimmt ihm die Kontrolle, führt zum sofortigen Aufgeben),
alles, was den **König einfriert** (wäre Matt per Knopfdruck), und alles, was
eine **Engine auf dem Server** bräuchte („sieh die nächsten fünf Züge" ist
faktisch legales Cheaten). Übrig bleiben 16 Items, die sich sämtlich als
`opts`-Flag in `move-gen.js` ausdrücken lassen — es gibt keine Sonderpfade im
Server.

Zusätzlich prüft der Server vor jedem Kauf, dass der Gegner **noch legale Züge
behält**. Ein Minenfeld oder eine Fesselung, die ihn patt setzen würde, wird
abgelehnt statt ausgeführt.

### Zwei Regelentscheidungen, die man kennen muss

- Eine **gefesselte Figur gibt weiterhin Schach** und deckt weiterhin Felder.
- Ein **vermintes Feld schützt den König nicht**: Angriffskarten ignorieren
  Minenfelder.

Beides hätte man andersherum bauen können — dann entstehen aber Stellungen, in
denen man im Schach steht, ohne dass es sichtbar wäre.

### Nebel des Krieges

Der Nebel wird **serverseitig maskiert**: Jeder Client bekommt ausschließlich
sein eigenes Sichtfeld, gegnerische Figuren sind aus dem Datenpaket *entfernt*,
nicht nur ausgeblendet. Sonst stünde die komplette Stellung im
Netzwerk-Tab der DevTools und das Item wäre in fünf Minuten geknackt.

### Umgebungsvariablen

| Variable | Standard | Zweck |
|---|---|---|
| `PREDICTION_MOVE_MS` | `90000` | Bedenkzeit pro Zug |
| `PREDICTION_START_COINS` | `0` | Startguthaben — **nur für Tests** |

---

## Zeichenpfeile

`public/shared/board-arrows.js` hängt eine eigene SVG-Ebene ins Brett und wertet
Rechtsklick-Ziehen aus. Sie liegt bewusst **im** Brett: ein gedrehtes Brett
(`#board.flipped`) dreht die Ebene mit, dadurch braucht es keine Spiegelrechnung.
Weil die Modi ihr Brett neu aufbauen und die Ebene dabei mitentfernen würden,
hängt sie sich per `MutationObserver` selbst wieder ein.

Eingebunden in Mutant Merge, VS Cager Bot und Prediction Chess. **Quick Chess
bewusst nicht** — dort ist der Rechtsklick in einer Echtzeitpartie eher im Weg.

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

- **Prediction Chess hat noch kein eigenes Vorschaubild.** Die Hub-Kachel
  benutzt derzeit eine Farbfläche mit Emoji statt eines `-preview.jpg` wie die
  anderen Modi.
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
