"""
NILA - Memory
-------------
Two kinds of memory:

  Short-term: the current conversation (stored in SQLite as messages,
              reloaded on each turn so context survives refresh).

  Long-term : personal facts about the user, stored in the 'memories'
              table. Supports:
                "remember my <key> is <value>"
                "remember (that) <fact>"
                "forget <something>"
                "what do you remember about me?"
              Useful facts can also be auto-extracted from conversation.
"""

import re
import uuid

from . import database
from . import llm

# ---------------------------------------------------------------------------
# Explicit memory commands
# ---------------------------------------------------------------------------

# "remember my project is called NILA"  -> key="project", value="NILA"
_REMEMBER_KEY_VALUE = re.compile(
    r"remember\s+my\s+(?P<key>.+?)\s+(?:is|are)\s+(?P<value>.+?)[.!?]?$",
    re.I,
)
# "remember that I like Python" / "remember I like Python"
_REMEMBER_THAT = re.compile(
    r"remember\s+(?:that\s+)?(?P<fact>.+?)[.!?]?$", re.I,
)
# "forget X" / "remove X from memory"
_FORGET = re.compile(r"(?:forget|remove|erase)\s+(?:that\s+)?(?P<text>.+?)[.!?]?$", re.I)
# "what do you remember (about me)?" / "show my memories"
_LIST = re.compile(
    r"what do you remember|what (?:do|does) nila remember|show my memories|"
    r"list my memories|my memories", re.I,
)

# Phrases that hint the sentence may contain a fact worth saving.
_AUTO_HINT = re.compile(
    r"\b(i\s+(?:am|like|want|work|study|learn|live|love|prefer|hate|need|enjoy|"
    r"plan|will|have|speak|play|read|watch|go|use))"
    r"|my\s+\w+\s+is\b"
    r"|i\s+don'?t\s+like\b",
    re.I,
)


def _slug(key: str) -> str:
    """'My Project Name' -> 'my_project_name' (a stable unique key)."""
    slug = re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_")
    return slug[:60] or f"fact_{uuid.uuid4().hex[:8]}"


def _readable(memory) -> str:
    return f"{memory['key'].replace('_', ' ')}: {memory['value']}"


# ---------------------------------------------------------------------------
# Public API used by app.py
# ---------------------------------------------------------------------------

def handle_memory_intent(message: str):
    """
    If the message is an explicit memory command, handle it and return
    a short reply string. Returns None if it's a normal chat message.
    """
    msg = message.strip()

    m = _REMEMBER_KEY_VALUE.search(msg)
    if m:
        key = _slug(m.group("key"))
        value = m.group("value").strip()
        database.save_memory(key, value, source="manual")
        return f"Got it — I'll remember your {m.group('key').strip()}: {value}."

    m = _REMEMBER_THAT.search(msg)
    if m and msg.lower().startswith("remember"):
        fact = m.group("fact").strip()
        database.save_memory(_slug(fact), fact, source="manual")
        return "Got it, I've saved that: " + fact + "."

    m = _FORGET.search(msg)
    if m and msg.lower().startswith(("forget", "remove", "erase")):
        text = m.group("text").strip()
        matches = database.find_memory(text)
        if not matches:
            return f"I don't have anything matching \"{text}\" in memory."
        for mem in matches:
            database.delete_memory(mem["id"])
        return "Done — I've forgotten " + _readable(matches[0]) + "."

    if _LIST.search(msg):
        memories = database.get_memories()
        if not memories:
            return "I don't have any long-term memories about you yet. "
            "Tell me something like 'remember that I am learning SQL'."
        lines = ["Here's what I remember about you:"]
        for mem in memories:
            lines.append(f"- {_readable(mem)}")
        return "\n".join(lines)

    return None


def memory_context_text() -> str:
    """Facts to inject into the system prompt (only the useful ones).
    Capped at ~1000 chars: long memory dumps slow down every reply's
    prompt-processing on small CPUs."""
    memories = database.get_memories()
    if not memories:
        return ""
    facts = []
    total = 0
    for m in memories[:12]:
        line = f"- {_readable(m)}"
        if total + len(line) > 1000:
            break
        facts.append(line)
        total += len(line)
    if not facts:
        return ""
    return "Facts you know about the user:\n" + "\n".join(facts)


def maybe_auto_extract(user_message: str):
    """
    Best-effort: if the user shares something personal, ask the LLM to
    turn it into short memory facts and store them. Never raises.
    """
    if not _AUTO_HINT.search(user_message.lower()):
        return

    if database.memory_count() >= 200:
        return  # keep the table small

    prompt = (
        "Extract personal facts about the user from this message. "
        "Output each fact as exactly one short line, 'key = value'. "
        "Only output facts that are clearly stated, omit everything else. "
        "If there are none, output nothing.\n\nMessage: " + user_message
    )
    try:
        output = llm.complete(prompt, max_tokens=120).strip()
    except Exception:
        return  # silent: never block the conversation on memory

    for line in output.splitlines():
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not key or not value:
            continue
        database.save_memory(_slug(key), value, source="auto")
