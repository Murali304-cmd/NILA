"""
NILA - SQLite database layer
-----------------------------
All database access lives here. The rest of the app never touches
SQL directly, so it would be easy to swap SQLite for PostgreSQL later.

Schema (designed with portable types so it can migrate later):
  users, memories, conversations, messages, tasks,
  documents, document_chunks, settings
"""

import os
import sqlite3
from datetime import datetime, timedelta

# DATABASE_URL is configurable, e.g. sqlite:///./nila.db
_DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./nila.db")
DB_PATH = _DATABASE_URL.replace("sqlite:///", "").replace("sqlite://", "")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isabs(DB_PATH):
    DB_PATH = os.path.join(BASE_DIR, DB_PATH)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_user_key ON memories(user_id, key);

CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    title      TEXT NOT NULL DEFAULT 'New Chat',
    summary    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    priority     TEXT NOT NULL DEFAULT 'normal',
    due          TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    filename     TEXT NOT NULL,
    stored_path  TEXT NOT NULL,
    content_type TEXT,
    size         INTEGER DEFAULT 0,
    chunks       INTEGER DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'ready',
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_documents (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, document_id)
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER DEFAULT 0,
    text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Performance + concurrency pragmas: WAL lets reads run while the
    # background indexing thread writes; NORMAL skips fsync per commit.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA cache_size = -20000")   # 20 MB page cache
    conn.execute("PRAGMA temp_store = MEMORY")
    return conn


def _migrate(conn):
    """Add columns/tables introduced after the first release."""
    conv_cols = {r["name"] for r in conn.execute("PRAGMA table_info(conversations)")}
    if "summary" not in conv_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN summary TEXT")
    doc_cols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
    if "status" not in doc_cols:
        conn.execute("ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'")
    if "error" not in doc_cols:
        conn.execute("ALTER TABLE documents ADD COLUMN error TEXT")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS conversation_documents (
               conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
               added_at        TEXT NOT NULL DEFAULT (datetime('now')),
               PRIMARY KEY (conversation_id, document_id))""")
    # Hot-path indexes (cheap to create; make sidebar + chat queries fast).
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conv_user_updated "
        "ON conversations(user_id, updated_at DESC)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conv_user_id "
        "ON conversations(user_id, id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_docs_user "
        "ON documents(user_id, created_at DESC)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_mem_user_updated "
        "ON memories(user_id, updated_at DESC)")


def init_db():
    """Create all tables. Call once at startup."""
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

def get_or_create_user(username="local_user"):
    """NILA is single-user for now; returns the default user row."""
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?",
                           (username,)).fetchone()
        if row:
            return dict(row)
        cur = conn.execute(
            "INSERT INTO users (username, display_name) VALUES (?, ?)",
            (username, "You"))
        conn.commit()
        return dict(cur) | {"id": cur.lastrowid}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Memories
# ---------------------------------------------------------------------------

def save_memory(key, value, source="manual", user_id=1):
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO memories (user_id, key, value, source, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(user_id, key) DO UPDATE SET
                   value = excluded.value,
                   source = excluded.source,
                   updated_at = excluded.updated_at""",
            (user_id, key, value, source, now()))
        conn.commit()
        return True
    finally:
        conn.close()


def get_memories(user_id=1):
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def find_memory(text, user_id=1):
    """Find a memory whose key or value contains text (for 'forget ...')."""
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT * FROM memories
               WHERE user_id = ? AND (key LIKE ? OR value LIKE ?)
               ORDER BY updated_at DESC""",
            (user_id, f"%{text}%", f"%{text}%")).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_memory(memory_id):
    conn = _connect()
    try:
        conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        conn.commit()
        return conn.total_changes > 0
    finally:
        conn.close()


def update_memory(memory_id, value):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE memories SET value = ?, updated_at = ? WHERE id = ?",
            (value, now(), memory_id))
        conn.commit()
        return conn.total_changes > 0
    finally:
        conn.close()


def clear_memories(user_id=1):
    conn = _connect()
    try:
        conn.execute("DELETE FROM memories WHERE user_id = ?", (user_id,))
        conn.commit()
        return conn.total_changes
    finally:
        conn.close()


def memory_count(user_id=1):
    conn = _connect()
    try:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM memories WHERE user_id = ?",
            (user_id,)).fetchone()["c"]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Conversations & messages
# ---------------------------------------------------------------------------

def create_conversation(title="New Chat", user_id=1):
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
            (user_id, title))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_conversations(user_id=1, limit=50):
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT * FROM conversations
               WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?""",
            (user_id, limit)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_conversation(conversation_id):
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?",
            (conversation_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def rename_conversation(conversation_id, title):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title, now(), conversation_id))
        conn.commit()
    finally:
        conn.close()


def touch_conversation(conversation_id):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now(), conversation_id))
        conn.commit()
    finally:
        conn.close()


def delete_conversation(conversation_id):
    conn = _connect()
    try:
        conn.execute("DELETE FROM conversations WHERE id = ?",
                     (conversation_id,))
        conn.commit()
        return conn.total_changes > 0
    finally:
        conn.close()


def add_message(conversation_id, role, content):
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
            (conversation_id, role, content))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_messages(conversation_id, limit=60):
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT * FROM (
                   SELECT * FROM messages
                   WHERE conversation_id = ?
                   ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC""",
            (conversation_id, limit)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def count_messages(conversation_id):
    """COUNT(*) — cheap alternative to fetching every message."""
    conn = _connect()
    try:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?",
            (conversation_id,)).fetchone()["c"]
    finally:
        conn.close()


def get_history_messages(conversation_id, limit=20):
    """Last N user/assistant turns, oldest first, for the LLM context."""
    rows = get_messages(conversation_id, limit=limit)
    return [{"role": r["role"], "content": r["content"]}
            for r in rows if r["role"] in ("user", "assistant")]


def set_conversation_summary(conversation_id, summary):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE conversations SET summary = ? WHERE id = ?",
            (summary, conversation_id))
        conn.commit()
    finally:
        conn.close()


def get_conversation_summaries(user_id=1, limit=200):
    """All (id, title, summary) pairs — used for previous-chat retrieval."""
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT id, title, COALESCE(summary, title) AS summary
               FROM conversations WHERE user_id = ?
               ORDER BY updated_at DESC LIMIT ?""",
            (user_id, limit)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def clear_conversations(user_id=1):
    conn = _connect()
    try:
        conn.execute("DELETE FROM conversations WHERE user_id = ?", (user_id,))
        conn.commit()
        return conn.total_changes
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Conversation ↔ document links (files shown inside a chat)
# ---------------------------------------------------------------------------

def link_document_to_conversation(conversation_id, document_id):
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO conversation_documents "
            "(conversation_id, document_id) VALUES (?, ?)",
            (conversation_id, document_id))
        conn.commit()
    finally:
        conn.close()


def get_conversation_documents(conversation_id):
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT d.* FROM conversation_documents cd
               JOIN documents d ON d.id = cd.document_id
               WHERE cd.conversation_id = ? ORDER BY cd.added_at DESC""",
            (conversation_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

def add_task(title, due=None, priority="normal", user_id=1):
    conn = _connect()
    try:
        cur = conn.execute(
            """INSERT INTO tasks (user_id, title, priority, due)
               VALUES (?, ?, ?, ?)""",
            (user_id, title, priority, due))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_tasks(status="all", user_id=1):
    conn = _connect()
    try:
        if status == "all":
            rows = conn.execute(
                "SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC",
                (user_id,)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY created_at DESC",
                (user_id, status)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def update_task(task_id, status):
    conn = _connect()
    try:
        conn.execute(
            """UPDATE tasks SET status = ?,
                   completed_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END
               WHERE id = ?""",
            (status, status, now(), task_id))
        conn.commit()
        return conn.total_changes > 0
    finally:
        conn.close()


def delete_task(task_id):
    conn = _connect()
    try:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return conn.total_changes > 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Documents (metadata lives here; chunk text too)
# ---------------------------------------------------------------------------

def add_document(filename, stored_path, content_type, size, user_id=1):
    conn = _connect()
    try:
        cur = conn.execute(
            """INSERT INTO documents (user_id, filename, stored_path, content_type, size, status)
               VALUES (?, ?, ?, ?, ?, 'processing')""",
            (user_id, filename, stored_path, content_type, size))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def set_document_status(document_id, status, error=None):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE documents SET status = ?, error = ? WHERE id = ?",
            (status, error, document_id))
        conn.commit()
    finally:
        conn.close()


def list_documents(user_id=1):
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_document(document_id):
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM documents WHERE id = ?",
                           (document_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_document_record(document_id):
    conn = _connect()
    try:
        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        conn.commit()
        return conn.total_changes > 0
    finally:
        conn.close()


def replace_chunks(document_id, chunks):
    """Delete a document's old chunks and insert new ones."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM document_chunks WHERE document_id = ?",
                     (document_id,))
        conn.executemany(
            "INSERT INTO document_chunks (document_id, chunk_index, text) VALUES (?, ?, ?)",
            [(document_id, i, c) for i, c in enumerate(chunks)])
        conn.execute("UPDATE documents SET chunks = ? WHERE id = ?",
                     (len(chunks), document_id))
        conn.commit()
    finally:
        conn.close()


def get_all_chunks():
    """[(chunk_id, document_id, chunk_index, text), ...] for rebuilding FAISS."""
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT c.id, c.document_id, c.chunk_index, c.text, d.filename
               FROM document_chunks c JOIN documents d ON d.id = c.document_id
               ORDER BY c.id ASC""").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_chunk_ids_for_document(document_id):
    """Chunk ids belonging to one document (to filter FAISS hits)."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id FROM document_chunks WHERE document_id = ?",
            (document_id,)).fetchall()
        return [r["id"] for r in rows]
    finally:
        conn.close()


def get_chunk(chunk_id):
    conn = _connect()
    try:
        row = conn.execute(
            """SELECT c.id, c.document_id, c.chunk_index, c.text, d.filename
               FROM document_chunks c JOIN documents d ON d.id = c.document_id
               WHERE c.id = ?""", (chunk_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_chunks_by_ids(chunk_ids):
    """Batched chunk fetch — one query instead of N for RAG retrieval."""
    if not chunk_ids:
        return {}
    conn = _connect()
    try:
        placeholders = ",".join("?" * len(chunk_ids))
        rows = conn.execute(
            f"""SELECT c.id, c.document_id, c.chunk_index, c.text, d.filename
                FROM document_chunks c JOIN documents d ON d.id = c.document_id
                WHERE c.id IN ({placeholders})""",
            list(chunk_ids)).fetchall()
        return {r["id"]: dict(r) for r in rows}
    finally:
        conn.close()


def delete_chunks_for_document(document_id):
    conn = _connect()
    try:
        conn.execute("DELETE FROM document_chunks WHERE document_id = ?",
                     (document_id,))
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_setting(key, default=None):
    conn = _connect()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?",
                           (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def get_all_settings():
    """All settings in one query (the app calls this on every chat)."""
    conn = _connect()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()


def set_setting(key, value):
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)))
        conn.commit()
    finally:
        conn.close()


def due_date_for_when(when):
    """'tomorrow'/'today' → ISO date string, else None."""
    w = when.lower().strip()
    today = datetime.now()
    if "tomorrow" in w or "next day" in w:
        return (today + timedelta(days=1)).strftime("%Y-%m-%d")
    if "today" in w or "now" in w:
        return today.strftime("%Y-%m-%d")
    return None


# ---------------------------------------------------------------------------
# Fast search (conversations / documents / memories)
# ---------------------------------------------------------------------------

def search_all(q, user_id=1, limit=8):
    """LIKE-based search across the three text stores. Personal scale data
    (hundreds of rows) makes this effectively instant without FTS complexity."""
    like = f"%{q}%"
    conn = _connect()
    try:
        convs = conn.execute(
            """SELECT id, title, summary, created_at, updated_at FROM conversations
               WHERE user_id = ? AND (title LIKE ? OR COALESCE(summary, '') LIKE ?)
               ORDER BY updated_at DESC LIMIT ?""",
            (user_id, like, like, limit)).fetchall()
        docs = conn.execute(
            """SELECT id, filename, status, chunks, created_at FROM documents
               WHERE user_id = ? AND (filename LIKE ?
                 OR id IN (SELECT DISTINCT document_id FROM document_chunks
                           WHERE text LIKE ?))
               ORDER BY created_at DESC LIMIT ?""",
            (user_id, like, like, limit)).fetchall()
        mems = conn.execute(
            """SELECT id, key, value FROM memories
               WHERE user_id = ? AND (key LIKE ? OR value LIKE ?)
               ORDER BY updated_at DESC LIMIT ?""",
            (user_id, like, like, limit)).fetchall()
        return {
            "conversations": [dict(r) for r in convs],
            "documents": [dict(r) for r in docs],
            "memories": [dict(r) for r in mems],
        }
    finally:
        conn.close()
