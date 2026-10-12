<div align="center">

<img src="packaging/icons/icon.svg" width="96" height="96" alt="">

# streamFree

**Lo studio di live streaming gratuito che gira sul tuo computer.**

Invita ospiti con un link, aggiungi il tuo branding, trasmetti su YouTube,
Twitch, Facebook e qualsiasi server RTMP contemporaneamente e registra in MP4.
Un'app desktop sotto i 5 MB, senza account, abbonamento né watermark.

[![Ultima versione](https://img.shields.io/github/v/release/iamvinbas/streamFree?color=6d5efc&label=versione)](https://github.com/iamvinbas/streamFree/releases/latest)
[![CI](https://github.com/iamvinbas/streamFree/actions/workflows/ci.yml/badge.svg)](https://github.com/iamvinbas/streamFree/actions/workflows/ci.yml)
[![Licenza: MIT](https://img.shields.io/badge/licenza-MIT-6d5efc)](LICENSE)

**[Sito](https://iamvinbas.github.io/streamFree/)** · **[Download](#download)** · [English](README.md) · **Italiano**

</div>

![Lo studio di streamFree: due persone in scena, un banner, un ticker e il pannello dei banner](docs/assets/studio.jpg)

## Download

| Sistema | Download | Note |
|---|---|---|
| **macOS** 11+, Apple Silicon | [streamFree-macOS-AppleSilicon.dmg](https://github.com/iamvinbas/streamFree/releases/latest/download/streamFree-macOS-AppleSilicon.dmg) | Aprilo e trascina streamFree in Applicazioni |
| **macOS** 11+, Intel | [streamFree-macOS-Intel.dmg](https://github.com/iamvinbas/streamFree/releases/latest/download/streamFree-macOS-Intel.dmg) | |
| **Windows** 10/11, 64 bit | [streamFree-Windows-Setup.exe](https://github.com/iamvinbas/streamFree/releases/latest/download/streamFree-Windows-Setup.exe) | Installer per utente, senza permessi di amministratore; [.zip portabile](https://github.com/iamvinbas/streamFree/releases/latest/download/streamfree-x86_64-pc-windows-msvc.zip) |
| **Linux** x86-64 / ARM64 | [x86-64](https://github.com/iamvinbas/streamFree/releases/latest/download/streamfree-x86_64-unknown-linux-gnu.tar.gz) · [ARM64](https://github.com/iamvinbas/streamFree/releases/latest/download/streamfree-aarch64-unknown-linux-gnu.tar.gz) | Richiede Chrome, Edge o Brave; vedi i [limiti](#stato) |

Ogni file ha il suo checksum `.sha256` nella [pagina delle release](https://github.com/iamvinbas/streamFree/releases).

**Oppure installa con un comando.** Lo script verifica il checksum SHA-256 e aggiunge l'app al sistema, senza sudo:

```sh
# macOS e Linux
curl -fsSL https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.ps1 | iex
```

**Primo avvio.** L'app non è ancora firmata da Apple o Microsoft, quindi il sistema chiede conferma una volta:

- **macOS:** clic destro sull'app e scegli **Apri**. Se macOS la blocca ancora, vai in Impostazioni di Sistema → Privacy e sicurezza → **Apri comunque**. Il comando di installazione evita questo passaggio.
- **Windows:** se SmartScreen avvisa, scegli **Ulteriori informazioni** → **Esegui comunque**.

## Cosa ottieni

- **Un'app vera.** Su macOS e Windows streamFree ha una sua finestra, un'icona nel Dock o nella barra delle applicazioni, una barra dei menu e i suoi permessi. L'interfaccia gira nel motore web del sistema (WebKit su macOS, WebView2 su Windows), come Slack o VS Code: non serve un browser. Su Linux lo studio si apre in una finestra di Chrome, Edge o Brave.
- **Ospiti con un link.** Fino a 16 ospiti entrano da qualsiasi browser moderno, senza installare nulla:
  - aspettano nel backstage finché non li porti in scena;
  - vedono il programma in onda;
  - sentono tutti tranne se stessi (*mix-minus*), quindi senza eco;
  - possono scriverti in privato.
- **Multistreaming.** Trasmetti su tutte le destinazioni RTMP/RTMPS che la tua connessione regge: YouTube, Twitch, Facebook, LinkedIn, Kick, X o un tuo server. Ogni destinazione si riconnette da sola e una lenta non rallenta le altre.
- **Registrazione a prova di crash.** L'MP4 locale (H.264 + AAC) viene scritto a frammenti: anche dopo un crash il file si riproduce fino agli ultimi secondi.
- **Strumenti per lo show:**
  - 7 layout: singolo, griglia, affiancati, leader, picture in picture, presentazione, cinema;
  - logo, overlay a tutto schermo, sfondi a colore o immagine;
  - targhette dei nomi nei tuoi colori;
  - sottopancia preparati prima della diretta e ticker scorrevole;
  - condivisione schermo con audio;
  - clip video per intro e outro.
- **Commenti a schermo.** Leggi la chat di Twitch senza login e metti in onda un commento con un clic, oppure inserisci domande a mano.
- **Qualità.** 720p o 1080p a 30 o 60 fps, con l'encoder hardware del tuo computer.
- **Privato per scelta.** Lo studio ascolta solo su `127.0.0.1`. Le chiavi di stream non lasciano mai il tuo computer, e non ci sono telemetria né server di streamFree.

La mappa completa delle funzionalità, comprese quelle in arrivo, è in [docs/feature-spec.md](docs/feature-spec.md).

## Primi passi

1. **Apri streamFree** e consenti videocamera e microfono quando il sistema lo chiede.
2. **Aggiungi le destinazioni** (facoltativo): in **Destinations** scegli YouTube, Twitch, Facebook o un server RTMP personalizzato e incolla la chiave di stream.
3. **Invita gli ospiti** con il pulsante **Invite** (vedi [Ospiti fuori dal tuo computer](#ospiti-fuori-dal-tuo-computer)).
4. Prepara **Brand**, **Banners** e layout.
5. Premi **Record** per registrare soltanto, oppure **Go live** per trasmettere su tutte le destinazioni scelte e, se vuoi, registrare insieme.
6. Chiudi la finestra per uscire. Una registrazione in corso viene prima finalizzata.

Le registrazioni finiscono in `~/Movies/streamFree` su macOS e in `~/Videos/streamFree` su Windows e Linux. La finestra di fine diretta apre la cartella.

## Ospiti fuori dal tuo computer

I browser consentono la videocamera solo su pagine sicure (HTTPS), quindi il modo in cui gli ospiti ti raggiungono dipende da dove si trovano. Per ora si sceglie avviando streamFree da terminale:

| Dove sono gli ospiti? | Avvia streamFree con | Cosa fanno gli ospiti |
|---|---|---|
| Nella rete di casa o dell'ufficio | `streamfree --app --lan` | Aprono il link e accettano una volta l'avviso del certificato |
| Ovunque su internet | `streamfree --app --tunnel` | Aprono il link `https://….trycloudflare.com` |
| Dietro un tuo proxy HTTPS | `streamfree --app --public-url https://studio.example.com` | Aprono il link |

- `--tunnel` richiede [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). Nel tunnel passano solo la pagina ospite e la segnalazione; audio e video viaggiano direttamente tra te e gli ospiti.
- Se alcuni ospiti non riescono a connettersi (reti aziendali o mobili restrittive), aggiungi un server TURN in **Settings → Guests → ICE servers**.

## Riga di comando

Gli installer a comando aggiungono anche il comando `streamfree` (con il `.dmg` o l'`.exe`, usa il binario dentro la cartella dell'app):

```text
streamfree [--app [--browser]] [--port 8787] [--lan] [--tunnel] [--public-url URL]
           [--data-dir DIR] [--recordings-dir DIR] [--no-open]
```

| Opzione | Effetto |
|---|---|
| *(nessuna)* | Studio in una scheda del browser predefinito (consigliati Chrome, Edge o Brave); Ctrl+C per uscire |
| `--app` | La finestra di streamFree (quella che apre l'icona); chiudendola si esce |
| `--browser` | Con `--app`: una finestra di Chrome/Edge/Brave invece della WebView di sistema |
| `--lan`, `--tunnel`, `--public-url` | Come ti raggiungono gli ospiti (vedi sopra) |

Impostazioni, destinazioni e immagini caricate stanno in:

- `~/Library/Application Support/streamFree` su macOS;
- `%APPDATA%\streamFree` su Windows;
- `~/.local/share/streamFree` su Linux.

Il log dell'app è `streamfree.log`, nella stessa cartella.

## Come funziona

```text
 browser degli ospiti ──WebRTC──▶  streamFree sul tuo computer  ──RTMP(S)──▶ YouTube · Twitch · Facebook · qualsiasi server
                                   ├─ studio (WebView di sistema)       └────▶ registrazione.mp4
                                   │   camera, schermo, ospiti → worker di composizione → H.264 + AAC (WebCodecs)
                                   └─ core Rust: invio RTMP, registratore MP4, segnalazione, impostazioni
```

- **Studio.** Cattura, compone e codifica in un worker in background con l'encoder hardware (WebCodecs).
- **Core Rust.** Fa ciò che una pagina web non può fare:
  - pubblica su ogni destinazione via RTMP/RTMPS;
  - scrive l'MP4;
  - inoltra la segnalazione WebRTC agli ospiti;
  - custodisce le chiavi di stream.
- **Dimensioni.** Tutto sta in un unico binario di circa 7 MB.

Dettagli in [docs/architecture.md](docs/architecture.md). Protocolli e paper alla base del progetto in [docs/references.md](docs/references.md).

## Stato

streamFree è giovane. Cosa è stato verificato, e come:

| Area | Verificata con |
|---|---|
| Registrazione, due destinazioni RTMP in contemporanea, ospiti WebRTC, sincronia audio/video | Test automatici nel browser (Chrome vero, videocamera simulata) a ogni push |
| Uscita RTMP e file MP4 | FFmpeg come verificatore indipendente nella suite di test |
| App macOS: finestra nativa, 30 fps con la finestra ridotta a icona, audio sincronizzato | Smoke test integrato (`streamfree --smoke-test 8`) |
| App macOS: permessi di videocamera e microfono | Test manuale |
| Chat di Twitch, modalità LAN HTTPS, immagine disco macOS, script di installazione, link di download | Verifiche manuali e con script |

Non ancora verificato:

- **Invio alle piattaforme reali** (YouTube, Twitch, Facebook…). Segnala cosa funziona per te.
- **Windows.** App e installer si compilano e passano i test in CI, ma non sono ancora stati eseguiti su un PC Windows.
- **Condurre da Linux.** Chrome su Linux sembra non avere un encoder AAC, quindi su Linux streamFree potrebbe funzionare solo per gli ospiti; in quel caso mostra un errore chiaro.
- **Condivisione schermo nell'app macOS** e **`--tunnel`** dall'inizio alla fine.

In programma:

- registrazioni multitraccia per ospite;
- scene e uscita verticale;
- chat di YouTube;
- sfocatura dello sfondo;
- sottotitoli locali;
- scelta di LAN o tunnel direttamente dall'app.

## Sviluppo

```sh
git clone https://github.com/iamvinbas/streamFree && cd streamFree
cargo build --release                       # target/release/streamfree
cargo test                                  # test unitari + test con FFmpeg come oracolo (se installato)
cd tests/e2e && npm install && npm test     # test nel browser: servono Google Chrome e ffmpeg
./target/release/streamfree --smoke-test 8  # macOS/Windows: registra nella finestra dell'app, metà ridotta a icona
```

Serve Rust 1.88 o successivo. Lo studio (`web/`) è HTML, CSS e JavaScript semplice, incorporato nel binario in fase di compilazione.

| Percorso | Contenuto |
|---|---|
| `src/` | Core Rust: `server.rs` (HTTP/WebSocket), `live.rs` (distribuzione alle destinazioni), `rtmp/`, `mp4.rs`, `flv.rs`, `desktop.rs` (finestra nativa), `app.rs`, `chat.rs`, `net.rs`, `store.rs` |
| `web/` | Pagine dello studio e degli ospiti, worker di composizione, worklet di cattura audio |
| `site/` | Il sito, pubblicato su GitHub Pages a ogni push su `main` |
| `packaging/` | Icone, script per `.app` e `.dmg` macOS, installer Windows Inno Setup |
| `tests/` | Test di integrazione con FFmpeg e test end-to-end nel browser |
| `docs/` | Architettura, mappa delle funzionalità, riferimenti |

**Pubblicare una versione.** Fai push di un tag, per esempio `v0.4.0`. GitHub Actions compila per macOS (arm64, x64), Windows e Linux (x64, arm64), crea i `.dmg` e l'installer Windows e li pubblica con i checksum. I tag con un trattino (`v0.4.0-rc.1`) diventano pre-release.

## Licenza

[MIT](LICENSE). streamFree è un progetto indipendente, non affiliato ad alcun servizio di streaming. I nomi delle piattaforme sono marchi dei rispettivi proprietari.
