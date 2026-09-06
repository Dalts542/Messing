# Paddock Intelligence

A UK & Irish horse racing dashboard that runs entirely on your own PC.
No cloud account, no subscription, no paid API keys.

- Racing dashboard, racecards, runners, form, statistics, odds and results
- Bet tracker
- Optional local AI analysis via [Ollama](https://ollama.com) — free, runs on your machine
- Stores data in a local database file; nothing is sent to a third party

---

## Windows setup

**1. Install Node.js (only if you don't already have it).**
Go to <https://nodejs.org> and download the button marked **LTS**.
Run the installer and accept the defaults. You need version 22.5 or newer.

**2. Extract the project.**
If you downloaded a ZIP, right-click it and choose **Extract All**.
Make sure `start.bat` ends up sitting next to the `src` folder.

**3. Double-click `start.bat`.**
Windows may show an "Unknown Publisher" warning because the file was
downloaded. Choose **More info → Run anyway**. This is normal for any
downloaded script and is not a problem with the app.

**4. Wait until it says the server is ready.**
You'll see each stage as it happens:

```
[1/7] Checking Node.js
[2/7] Checking project files
[3/7] Checking for an existing instance
[4/7] Initialising database and starting server
[5/7] Waiting for health check
[6/7] Checking Ollama / local AI
[7/7] Opening Paddock V2
```

**5. Paddock V2 opens automatically** once the health check passes.

**6. Double-click `stop.bat`** when you want to stop it.

That's the whole process. Leave the `start.bat` window open while you use
the app — closing it stops the server.

### Addresses

| Page | URL |
| --- | --- |
| **Paddock V2** (the app) | <http://127.0.0.1:3000/> |
| NEXUS | <http://127.0.0.1:3000/nexus-standalone.html> |
| Bet Tracker | <http://127.0.0.1:3000/bet-tracker.html> |
| Health check | <http://127.0.0.1:3000/health> |
| AI diagnostics | <http://127.0.0.1:3000/api/ai/diagnose> |

Paddock V2 is the only Paddock interface. The original one has been removed;
`/paddock` and `/paddock.html` redirect to `/`.

The server binds to `127.0.0.1` only, so it is not reachable from other
machines on your network.

---

## Optional extras

Both are optional. **The dashboard starts and works without either of them.**

### Racing data

Without credentials the site runs normally but has no race data, and the
**Data Status** page explains why. To add data, open `src\.env` and fill in:

```
RACING_USER=your-username
RACING_PASS=your-password
```

Then restart with `stop.bat` followed by `start.bat`.

### Local AI

Install [Ollama](https://ollama.com) (free), then in a terminal run:

```
ollama pull llama3.1:8b
```

The app finds Ollama by itself. On startup it tries `127.0.0.1`, then `::1`,
then `localhost`, and will start Ollama for you if it is installed but not
running. It then sends a real test prompt, so "READY" means the AI genuinely
answered - not merely that Ollama exists.

**Do not set `OLLAMA_HOST` to `http://localhost:11434`.** On Windows,
`localhost` resolves to the IPv6 address `::1` first, while Ollama listens on
`127.0.0.1` only. Pinning it to `localhost` makes the AI look permanently
offline. Leave it unset unless Ollama is on a different port or machine.

The **AI Assistant** and **Data Status** screens show exactly what is wrong
when the AI is unavailable, and offer the matching action:

| Status | Meaning |
| --- | --- |
| `READY` | Ollama is running, the model is present, and a test prompt succeeded |
| `NOT_INSTALLED` | Ollama could not be found on this PC |
| `NOT_RUNNING` | Ollama is installed but nothing is listening on port 11434 |
| `UNREACHABLE` | Something is blocking the local connection |
| `NO_MODELS` | Ollama works but has no models - a download button is offered |
| `MODEL_MISSING` | Ollama works but `llama3.1:8b` is absent - shows what you do have |
| `MODEL_LOAD_FAILED` | The model exists but could not be loaded |
| `API_ERROR` / `TIMEOUT` | Ollama returned an error, or did not answer in time |

If the AI is unavailable the racing dashboard still loads in full - only AI
answers are affected.

---

## If something goes wrong

`start.bat` keeps its window open on failure and prints the exact error, an
exit code and a log location. The full log is at `data\startup.log`.

| Exit code | Meaning |
| --- | --- |
| 2 | Node.js is missing or too old, or project files are missing |
| 3 | Port 3000 is in use by another program |
| 4 | The server could not start |
| 5 | The server started but never became healthy |

**Port 3000 already in use.** The launcher will tell you and will *not* stop
the other program. Either close it, or set `PORT=3001` in `src\.env`.

**Already running.** Running `start.bat` a second time won't start a
duplicate — it just opens the dashboard you already have.

`stop.bat` only stops the process this project started. It never kills other
Node.js programs on your PC.

---

## Requirements

- Windows, macOS or Linux
- Node.js 22.5 or newer
- **No npm packages** — the app uses only Node's built-in modules,
  including its built-in SQLite database

---

## Running without the batch files

```bash
node src/launcher.js   # start (health-gated, opens browser)
node src/server.js     # start the server only
node src/stop.js       # stop
npm test               # run the test suite
```

## Tests

```bash
npm test
```

Four suites, no dependencies:

- **batch lint** - guards the startup bug where an unescaped `)` inside an
  `echo` closed an `if` block early and made `start.bat` exit before running
  the server.
- **smoke** - server startup, health endpoint, Paddock V2 routing, legacy
  redirects, every page, API degradation with no credentials, port conflicts.
- **ai** - every Ollama state (missing, stopped, no models, wrong model,
  timeout, API error, empty reply), model pulling, and the complete
  Paddock V2 -> Node -> Ollama -> model -> streamed response chain against a
  mock Ollama, including the IPv4-only regression.
- **launcher** - start/stop/restart, duplicate-launch detection, and surviving
  a failed browser launch.
