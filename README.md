# NILA — Your Personal AI Assistant (100% local, free, private)

NILA is a ChatGPT-style assistant that runs **entirely on your own laptop**.
No paid APIs, no cloud, no subscriptions. It chats, remembers facts about
you, reads your documents (PDF / PPTX / DOCX / TXT), manages tasks, does
calculations, and can talk (optional local Whisper + Piper voice).

> **v2.1** — light-first redesign, instant sidebar search, prior-chat memory
> with auto-summaries, file cards with background indexing, document Q&A with
> citations, query cache, performance stats, 8-section settings page,
> push-to-talk voice. See "What's new in v2.1" below.

```
                    NILA
                     │
             ┌───────┴────────┐
             ↓                ↓
          WEBSITE          ANDROID
             │                │
             └───────┬────────┘
                     ↓
                 FastAPI
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
     Gemma         SQLite         FAISS
    + Ollama       Memory          RAG
       │
       ├── Voice / Whisper
       ├── Piper TTS
       └── Tools
```

## ✅ What works

- 💬 Streaming chat with **Gemma 3 4B** via Ollama (markdown + code blocks)
- ⚡ **Fast**: streaming tokens, reply cache (identical questions instant), context-limit control
- 🧠 **Long-term memory** — "remember my X is Y", "forget …", auto-learned facts
- 💾 **Conversation history** — auto-titled, **auto-summarized**, grouped by day, sidebar, resume anytime
- 🔍 **Search** — one box for conversations, documents and memories
- 📄 **RAG** — upload PDF/PPTX/DOCX/TXT with **live indexing status** in chat, ask questions, **sources cited** (FAISS + local embeddings)
- 🧠 **Prior-chat memory** — new chats pick up relevant old conversations automatically
- ✅ **Tasks** — "Add 'study SQL' to my tasks", "Remind me to …", full panel
- 🧮 **Calculator** — "Calculate 125 × 48", "what is 20% of 80", sqrt/squared
- 🖥️ **System info** — "What is my RAM?" (read-only, safe)
- 🎨 **Light/dark/system theme**, 8-section Settings, responsive (desktop, laptop, mobile)
- 🎤 **Voice** — push-to-talk mic, auto-speak replies, voice/rate/volume control
- 📱 **Android app** (Jetpack Compose) talking to the same backend

## 📁 Structure

```
NILA/
├── backend/
│   ├── app.py          # FastAPI server — all REST + SSE chat endpoints
│   ├── llm.py          # LLM layer (swap models via .env, no code changes)
│   ├── database.py     # SQLite schema + all queries
│   ├── memory.py       # long-term + short-term memory logic
│   ├── rag.py          # document parsing, chunking, FAISS search
│   ├── tools.py        # safe calculator / tasks / system info
│   └── voice.py        # optional Whisper (STT) + Piper (TTS)
├── web/                # ChatGPT-style frontend (no frameworks, no CDN)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── android/NILA/       # Android app (Kotlin + Jetpack Compose)
├── documents/          # uploaded files (stored locally)
├── vector_db/          # FAISS index (stored locally)
├── nila.db             # SQLite database (created automatically)
├── requirements.txt
├── .env.example        # copy to .env to configure
└── README.md
```

## 🖥️ Installation (Windows)

### 1. Python
Download 3.10+ from https://www.python.org/downloads — tick
**"Add python.exe to PATH"**.

### 2. Ollama + model
Download from https://ollama.com/download, then:

```powershell
ollama pull gemma3:4b
```

> On a very slow 8 GB laptop you can switch to the smaller `gemma3:1b` by
> putting `LLM_MODEL=gemma3:1b` in your `.env`.

### 3. Virtual environment + dependencies

```powershell
cd D:\NILA
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 4. Configure (optional)

```powershell
copy .env.example .env
```

### 5. Start NILA

**Always use the launcher** — it starts everything (dedicated Ollama on port
11435, the server, and the browser):

```powershell
.\start-nila.ps1
```

or double-click **`Start NILA.bat`**.

Why a *dedicated* Ollama: other apps on this PC (e.g. the Evalvix project's
qwen3) use the default Ollama port 11434. On an 8 GB laptop two loaded models
don't fit — they evict each other and every reply re-loads the model (50-70 s
first token). NILA runs on its own instance (`127.0.0.1:11435`, configured in
`.env`) with `OLLAMA_MAX_LOADED_MODELS=1` and `OLLAMA_KEEP_ALIVE=-1`, so
gemma3:4b stays resident and other apps can't touch it.

Manual start (not recommended):
```powershell
$env:OLLAMA_HOST = "127.0.0.1:11435"
$env:OLLAMA_MAX_LOADED_MODELS = "1"
ollama serve                       # in one window
uvicorn backend.app:app --host 0.0.0.0 --port 8000   # in another
```

Open **http://127.0.0.1:8000** in your browser.

## ✨ What's new in v2.1

- **Light-first design** — a fresh, bright UI with NILA purple + teal accents;
  dark mode preserved; density / font-size / animations controls.
- **Fast** — reply cache (identical questions answered instantly), streaming
  tokens, adjustable context length, latency shown in stats.
- **Prior-chat memory** — after 4 messages a conversation is auto-summarized;
  new chats pull in relevant older summaries, so NILA remembers the thread
  without dumping full history in.
- **Search** — Ctrl+K / `/` opens search across conversations (titles +
  summaries), document files *and their contents*, and memories.
- **Documents in chat** — uploads appear as file cards with live status
  (⏳ processing → ✓ ready / ⚠ failed); pick a document per message to ask
  about it; answers come back with **source citations**.
- **Settings page** — 8 sections: Appearance, AI & model, Voice, Memory,
  Chat, Documents, Privacy, Performance (e.g. `context_length`, `rag_k`,
  temperature, style, cache toggle).
- **Voice** — hold-to-talk mic with recording chip, auto-speak replies,
  voice / rate / volume pickers.
- **Performance tab** — chat count, cache hits, RAG searches, tokens, latency.

## ⚡ Performance on this machine

Measured on this laptop (i3-1215U, 8 GB RAM, gemma3:4b, `num_ctx=2048`):

| Request | First token | Total | Tokens/s |
|---|---|---|---|
| Cache hit (identical question) | ~80–130 ms | ~100 ms | — |
| Simple ("Hi NILA!") | ~8 s | ~11 s | ~1.1 |
| Normal question | ~9 s | ~11–70 s | ~1–3 |
| Document Q&A (RAG) | ~10 s | — | ~1–2 |

This is the realistic CPU ceiling for a 4B model on this hardware. To get the
best numbers: **close heavy apps while chatting** (OpenCode, Antigravity IDE,
ChatGPT Classic), and always launch via `Start NILA.bat`. If replies are too
slow, switching the model to `gemma3:1b` (set `LLM_MODEL` in `.env`) roughly
doubles speed — at some quality cost.

Everything in the pipeline is already optimized: model stays resident
(`KEEP_ALIVE=-1`), reply cache, simple-message fast path (greetings skip
memory/RAG), RAG only when relevant, single settings query + TTL cache,
batched document chunks, SQLite WAL + indexes, background summaries and
memory extraction, and a truthful status line ("✦ NILA is analyzing…" →
"✦ Generating…") so you always know what's happening.

## 🔬 Quick API test (no browser)

```powershell
curl http://127.0.0.1:8000/api/health
curl -X POST http://127.0.0.1:8000/api/chat -H "Content-Type: application/json" -d "{\"message\":\"Hi, who are you?\",\"conversation_id\":null}"
```

Interactive API docs: http://127.0.0.1:8000/docs

## 🧪 Test cases

| You say | NILA does |
|---------|-----------|
| `Hi` | natural greeting (no RAG, no tools) |
| `Remember that my project is called NILA` | stores a long-term memory |
| `What am I learning?` (after "I am learning SQL") | answers from memory/context |
| `What is machine learning?` | normal LLM answer |
| `Calculate 125 * 48` | runs the safe calculator |
| `Add "Practice SQL" to my tasks` | creates a task |
| `What is my RAM?` | safe read-only system info |
| Upload a PDF then `Explain Module 1 from my PDF` | retrieves chunks + answers from it |

## 📄 RAG details

1. Upload a file (📎 in the chat or the Documents panel) — validated type (PDF/DOCX/PPTX/TXT/MD) and 20 MB limit. A file card appears in chat with live status.
2. Text is extracted, cleaned and split into overlapping chunks — **indexing runs in the background** (upload returns instantly).
3. Chunks are embedded locally (`all-MiniLM-L6-v2`) and stored in FAISS (`vector_db/`).
4. Ask about a specific document via the document picker, or NILA auto-retrieves when your message looks like a real question; it answers **only from the chunks** and cites the source.
5. Documents are treated as **untrusted data** — instructions inside them are never followed.

## 🎤 Voice (optional)

Backend voice uses **faster-whisper** (STT) and **Piper** (TTS):

```powershell
pip install faster-whisper av piper-tts
```

Download a Piper voice (`*.onnx` + `.onnx.json`) from https://github.com/rhasspy/piper/releases,
then set `PIPER_MODEL`/`PIPER_CONFIG` in `.env`.

Without them NILA still works: mic button shows a helpful message, and voice
replies fall back to your browser's built-in voices (Settings → Voice replies).

## 📱 Android

The `android/NILA/` folder is a Jetpack Compose app that talks to this backend.
Open it in **Android Studio** (it generates the Gradle wrapper), then:

1. On your PC, find your LAN IP: `ipconfig` → e.g. `192.168.1.10`.
2. Start NILA with `--host 0.0.0.0`.
3. In the app's Settings screen, set the server URL to `http://192.168.1.10:8000`.
4. Build & run on your phone (same Wi-Fi).

`usesCleartextTraffic` is enabled only for local development.

## 🔧 Configuration (.env)

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `ollama` | switch LLM backend later |
| `LLM_MODEL` | `gemma3:4b` | which local model |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `DATABASE_URL` | `sqlite:///./nila.db` | database path |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | RAG embeddings |
| `STT_MODEL` | `small` | Whisper size |
| `PIPER_BIN/MODEL/CONFIG` | — | Piper TTS (optional) |

## 🛠️ Common errors

| Problem | Fix |
|---------|-----|
| `Cannot reach Ollama` | Start Ollama (tray icon) |
| `Model 'gemma3:4b' is not pulled` | `ollama pull gemma3:4b` |
| `Missing 'faiss'/'sentence-transformers'` | `pip install -r requirements.txt` |
| `ModuleNotFoundError: python-multipart` | `pip install python-multipart` |
| Slow answers | close heavy apps, try `gemma3:1b` |
| Port 8000 busy | add `--port 8001` |

## 🔒 Privacy & security

- Everything runs locally; no external service is ever contacted.
- No arbitrary shell execution. Tools are read-only or sandboxed.
- File types and sizes are validated; stored names are hashed.
- Document content can never override NILA's system instructions.
- Conversation and memory data lives in `nila.db` on your machine.
