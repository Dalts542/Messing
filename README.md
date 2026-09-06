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
[1/6] Checking Node.js
[2/6] Checking project files
[3/6] Checking for an existing instance
[4/6] Initialising database and starting server
[5/6] Waiting for health check
[6/6] Opening dashboard
```

**5. The dashboard opens automatically** once the health check passes.

**6. Double-click `stop.bat`** when you want to stop it.

That's the whole process. Leave the `start.bat` window open while you use
the app — closing it stops the server.

### Addresses

| Page | URL |
| --- | --- |
| Paddock | <http://127.0.0.1:3000/paddock.html> |
| Dashboard | <http://127.0.0.1:3000/> |
| NEXUS | <http://127.0.0.1:3000/nexus-standalone.html> |
| Bet Tracker | <http://127.0.0.1:3000/bet-tracker.html> |
| Health check | <http://127.0.0.1:3000/health> |

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

Restart the app. If Ollama isn't installed the AI panel says it's offline
and everything else carries on working.

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

Covers batch launcher linting (a regression guard for the startup bug where
an unescaped `)` inside an `echo` closed an `if` block early and made
`start.bat` exit before running the server), server startup, the health
endpoint, every page, API degradation with no credentials, port-conflict
handling, and the start/stop/restart lifecycle.
