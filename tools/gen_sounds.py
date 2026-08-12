"""
Erzeugt alle Sound-Effekte für CagersGameHub prozedural mit numpy.
Damit sind sie zu 100% eigenproduziert und lizenzfrei (CC0) — keine
Fremd-Samples, keine Attribution nötig, kein CDN.
"""
import numpy as np, subprocess, os, wave, struct

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "shared", "sounds")
os.makedirs(OUT, exist_ok=True)

rng = np.random.default_rng(1337)


def t(dur):
    return np.linspace(0, dur, int(SR * dur), endpoint=False)


def env(sig, attack=0.002, decay=None, power=2.5):
    n = len(sig)
    e = np.ones(n)
    a = max(1, int(SR * attack))
    e[:a] = np.linspace(0, 1, a)
    d = n - a
    if d > 0:
        e[a:] = np.linspace(1, 0, d) ** power
    return sig * e


def lowpass(sig, cutoff):
    """Einpoliger IIR-Tiefpass."""
    alpha = 1.0 - np.exp(-2 * np.pi * cutoff / SR)
    out = np.empty_like(sig)
    acc = 0.0
    for i, v in enumerate(sig):
        acc += alpha * (v - acc)
        out[i] = acc
    return out


def highpass(sig, cutoff):
    return sig - lowpass(sig, cutoff)


def noise(dur):
    return rng.uniform(-1, 1, int(SR * dur))


def tone(freq, dur, harm=(1.0, 0.35, 0.12)):
    x = t(dur)
    s = np.zeros_like(x)
    for i, amp in enumerate(harm, start=1):
        s += amp * np.sin(2 * np.pi * freq * i * x)
    return s / sum(harm)


def click(freq, dur, noise_amt, cutoff):
    """Holziges Klacken: Rauschimpuls + gestimmter Körper."""
    body = tone(freq, dur, (1.0, 0.5, 0.25, 0.1))
    n = lowpass(noise(dur), cutoff)
    s = (1 - noise_amt) * body + noise_amt * n
    return env(s, attack=0.0008, power=3.0)


def norm(sig, peak=0.85):
    m = np.max(np.abs(sig))
    return sig * (peak / m) if m > 0 else sig


def pad(sig, ms=25):
    return np.concatenate([sig, np.zeros(int(SR * ms / 1000))])


def write(name, sig):
    sig = norm(pad(sig))
    wav = os.path.join(OUT, name + ".wav")
    data = (sig * 32767).astype("<i2").tobytes()
    with wave.open(wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    mp3 = os.path.join(OUT, name + ".mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav,
         "-codec:a", "libmp3lame", "-b:a", "96k", "-ar", "44100", "-ac", "1", mp3],
        check=True,
    )
    os.remove(wav)
    print(f"  {name}.mp3  {os.path.getsize(mp3):>6} B")


def silence(ms):
    return np.zeros(int(SR * ms / 1000))


print("Erzeuge Sounds…")

# --- move: kurzes, trockenes Holz-Klack ---------------------------------
write("move", click(430, 0.085, noise_amt=0.45, cutoff=2600) * 0.9)

# --- capture: härter, mit Knirschen und tieferem Körper ------------------
cap = click(250, 0.13, noise_amt=0.62, cutoff=3800)
cap += 0.5 * env(lowpass(noise(0.13), 900), attack=0.001, power=1.8)
write("capture", cap)

# --- castle: zwei Schläge kurz hintereinander ----------------------------
write("castle", np.concatenate([
    click(400, 0.075, 0.45, 2600) * 0.85,
    silence(55),
    click(330, 0.095, 0.5, 2200),
]))

# --- check: zwei aufsteigende, warnende Töne -----------------------------
write("check", np.concatenate([
    env(tone(784, 0.09, (1.0, 0.3)), attack=0.004, power=2.0),
    silence(20),
    env(tone(1047, 0.16, (1.0, 0.25)), attack=0.004, power=2.2),
]))

# --- promote: aufsteigendes Arpeggio (C-E-G-C) ---------------------------
prom = []
for i, f in enumerate([523.25, 659.25, 783.99, 1046.50]):
    prom.append(env(tone(f, 0.13, (1.0, 0.3, 0.1)), attack=0.005, power=2.0) * (0.75 + i * 0.08))
    prom.append(silence(8))
write("promote", np.concatenate(prom))

# --- game-start: freundlicher Zweiklang ----------------------------------
write("game-start", np.concatenate([
    env(tone(523.25, 0.16, (1.0, 0.35, 0.12)), attack=0.006, power=1.8),
    silence(10),
    env(tone(783.99, 0.30, (1.0, 0.3, 0.1)), attack=0.006, power=1.6),
]))

# --- game-end: absteigend, abschließend ----------------------------------
write("game-end", np.concatenate([
    env(tone(659.25, 0.17, (1.0, 0.3, 0.1)), attack=0.006, power=1.8),
    silence(10),
    env(tone(523.25, 0.17, (1.0, 0.3, 0.1)), attack=0.006, power=1.8),
    silence(10),
    env(tone(392.00, 0.42, (1.0, 0.35, 0.15)), attack=0.008, power=1.4),
]))

# --- low-time: trockener Warn-Piep ---------------------------------------
write("low-time", env(tone(1200, 0.075, (1.0, 0.15)), attack=0.002, power=2.5) * 0.8)

# --- notify: weiches Ping (Chat, Gegner beigetreten) ---------------------
write("notify", env(tone(880, 0.22, (1.0, 0.22, 0.06)), attack=0.008, power=1.6) * 0.7)

# --- illegal: dumpfes, kurzes Brummen ------------------------------------
ill = env(tone(140, 0.14, (1.0, 0.6, 0.3)), attack=0.003, power=2.0)
ill += 0.35 * env(lowpass(noise(0.14), 400), attack=0.003, power=2.0)
write("illegal", ill * 0.75)

# --- cooldown-ready: kurzes helles Tick (Quick Chess) --------------------
write("cooldown-ready", env(tone(1568, 0.05, (1.0, 0.12)), attack=0.001, power=3.0) * 0.45)

print("Fertig.")
