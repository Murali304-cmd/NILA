"""
NILA - Tools
------------
Safe, read-only tools NILA can use:

  * calculator    - evaluate arithmetic expressions (no shell, no eval)
  * tasks         - add / list / complete / delete personal tasks
  * system_info   - OS, CPU, RAM, disk (read-only)

No arbitrary command execution. Any future "dangerous" tool must be
opt-in with explicit user confirmation.
"""

import ast
import math
import os
import platform
import re

from . import database

# ---------------------------------------------------------------------------
# Safe calculator
# ---------------------------------------------------------------------------

# Nodes allowed inside an arithmetic expression.
_ALLOWED_NODES = (
    ast.Expression, ast.Constant, ast.BinOp, ast.UnaryOp,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.FloorDiv,
    ast.USub, ast.UAdd,
)

_MATH_FUNCS = {
    "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "log": math.log, "log10": math.log10, "abs": abs, "round": round,
    "ceil": math.ceil, "floor": math.floor, "pi": math.pi, "e": math.e,
    "tau": math.tau, "factorial": math.factorial,
}

# Find an arithmetic expression inside free text, e.g.
#   "Calculate 125 * 48"  ->  "125 * 48"
#   "what is sqrt(16) + 3" -> "sqrt(16) + 3"
_EXPR_RE = re.compile(
    r"[-+]?\d+(?:\.\d+)?(?:\s*[\+\-\*/\^%\u00D7\u00F7]\s*[-+]?\d+(?:\.\d+)?)+"
    r"|[-+]?\d+(?:\.\d+)?\s*[\+\-\*/\^]\s*[-+]?\d+(?:\.\d+)?"
)


def _safe_eval(expr: str) -> float:
    """Evaluate a math expression without executing arbitrary code."""
    expr = expr.replace("^", "**").replace("×", "*").replace("÷", "/")
    expr = expr.replace("%", " % ")
    tree = ast.parse(expr, mode="eval")

    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ValueError("Only numbers and math operators are allowed")
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id in _MATH_FUNCS):
                raise ValueError("Unknown function in expression")
            if len(node.args) > 2:
                raise ValueError("Too many arguments")

    result = eval(compile(tree, "<calc>", "eval"), {"__builtins__": {}}, _MATH_FUNCS)
    if isinstance(result, float) and result.is_integer():
        result = int(result)
    return result


def calculate(message: str):
    """Try to extract and evaluate an expression. Returns (ok, result|error)."""
    # Special phrases: "square root of 16", "16 squared", "20 percent of 50"
    m = re.search(r"(?:square root of|sqrt of)\s+([\d.]+)", message, re.I)
    if m:
        return True, round(math.sqrt(float(m.group(1))), 8)

    m = re.search(r"([\d.]+)\s+squared", message, re.I)
    if m:
        return True, float(m.group(1)) ** 2

    m = re.search(r"([\d.]+)\s*(?:percent|%)\s*of\s*([\d.]+)", message, re.I)
    if m:
        return True, round(float(m.group(1)) / 100.0 * float(m.group(2)), 8)

    match = _EXPR_RE.search(message)
    if not match:
        return False, "No arithmetic expression found"

    try:
        return True, _safe_eval(match.group(0))
    except Exception as exc:
        return False, f"Could not calculate: {exc}"


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

_TASK_ADD_RE = re.compile(
    r"(?:add|create|make|set)\s+(?:a\s+|the\s+|new\s+)?(?:task|reminder|remind me)?"
    r"(?:to\s+)?(?:\"|'|:)?(?P<title>.+?)(?:\"|'|:)?\s*(?:to\s+my\s+(?:tasks|list))?\s*$",
    re.I,
)
_REMIND_RE = re.compile(r"remind me to\s+(?P<title>.+)$", re.I)


def _clean_task_title(title: str) -> str:
    """Strip trailing time words so 'study SQL tomorrow' keeps a clean title."""
    return re.sub(r"\s+(tomorrow|today|tonight|now)\s*$", "", title).strip()


def add_task_from_message(message: str):
    """Returns (ok, text) after inserting a task from a natural sentence."""
    m = _REMIND_RE.search(message) or _TASK_ADD_RE.search(message)
    if not m:
        return False, "I couldn't find a task to add. Try: add 'study SQL' to my tasks"

    raw = m.group("title").strip(" ,.")
    if not raw:
        return False, "The task title was empty."

    due = database.due_date_for_when(message)
    title = _clean_task_title(raw)
    task_id = database.add_task(title, due=due)
    due_txt = f" (due {due})" if due else ""
    return True, f"Task added: \"{title}\"{due_txt}"


def list_tasks_text():
    tasks = database.list_tasks(status="pending")
    if not tasks:
        return "You have no pending tasks."
    lines = ["Your pending tasks:"]
    for i, t in enumerate(tasks, 1):
        due = f"  due {t['due']}" if t["due"] else ""
        lines.append(f"{i}. {t['title']}{due}")
    return "\n".join(lines)


def complete_task_from_message(message: str):
    """'complete task 2' / 'mark 2 as done' / 'complete study SQL'."""
    tasks = database.list_tasks(status="pending")
    if not tasks:
        return False, "There are no pending tasks to complete."

    m = re.search(r"task\s*#?\s*(\d+)|(?:mark|complete)\s*(\d+)", message, re.I)
    if m:
        idx = int(m.group(1) or m.group(2)) - 1
        if 0 <= idx < len(tasks):
            task = tasks[idx]
            database.update_task(task["id"], "done")
            return True, f"Completed: {task['title']}"
        return False, "That task number doesn't exist."

    # Try to match by title text.
    for task in tasks:
        if task["title"].lower() in message.lower():
            database.update_task(task["id"], "done")
            return True, f"Completed: {task['title']}"

    return False, "I couldn't find that task. Try: complete task 1"


def handle_task_intent(message: str):
    """Route a task-related message to the right tool."""
    q = message.lower()
    has_task_kw = "task" in q or "remind" in q or "reminder" in q
    if has_task_kw and (_TASK_ADD_RE.search(q) or _REMIND_RE.search(q)):
        return add_task_from_message(message)

    if any(w in message.lower() for w in ("complete task", "mark task",
                                          "mark it done", "task done",
                                          "finish task")):
        return complete_task_from_message(message)

    if any(w in message.lower() for w in ("list my tasks", "my tasks",
                                          "what tasks", "show tasks",
                                          "pending tasks")):
        return True, list_tasks_text()

    return None  # not a task message


# ---------------------------------------------------------------------------
# System info (read-only)
# ---------------------------------------------------------------------------

def _total_ram_gb():
    """Total physical RAM in GB (Windows + fallbacks)."""
    try:
        import ctypes
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return stat.ullTotalPhys / (1024 ** 3)
    except Exception:
        pass
    return None


def system_info():
    """Safe, read-only facts about the computer."""
    disk = {}
    try:
        import shutil
        usage = shutil.disk_usage(os.getcwd())
        disk = {
            "free_gb": round(usage.free / (1024 ** 3), 1),
            "total_gb": round(usage.total / (1024 ** 3), 1),
        }
    except Exception:
        pass

    ram = _total_ram_gb()
    return {
        "os": platform.system(),
        "os_version": platform.version(),
        "machine": platform.machine(),
        "cpu": platform.processor() or "Unknown",
        "cores": os.cpu_count(),
        "ram_total_gb": round(ram, 1) if ram else None,
        "disk_gb": disk,
        "python": platform.python_version(),
        "hostname": platform.node(),
    }


def is_system_question(message: str) -> bool:
    q = message.lower()
    return any(k in q for k in ("ram", "memory", "operating system", "os ",
                                "cpu", "processor", "disk", "storage",
                                "computer", "system info", "hardware"))


def run_system_tool(message: str):
    info = system_info()
    return True, (
        f"Here is your system info:\n"
        f"- OS: {info['os']} ({info['os_version']})\n"
        f"- CPU: {info['cpu']} ({info['cores']} cores)\n"
        f"- RAM: {info['ram_total_gb']} GB\n"
        f"- Disk free: {info['disk_gb'].get('free_gb')} GB / {info['disk_gb'].get('total_gb')} GB\n"
        f"- Host: {info['hostname']}"
    )


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def try_tool(message: str):
    """
    Try to handle message with a tool. Returns None if no tool applies,
    or (ok, result_text) if a tool handled it.
    """
    q = message.strip().lower()

    if len(q) < 5:
        return None

    # Calculator: "calculate ...", "what is 2+2", or an obvious expression.
    if q.startswith(("calculate", "calc ", "compute", "what is", "what's",
                     "solve", "whats")):
        ok, res = calculate(message)
        if ok:
            return True, f"The answer is {res}."
        # Not a calc message after all -> fall through to normal chat.

    if re.search(r"\d+\s*[\+\-\*/x×÷%]\s*\d+", q) and len(q) < 60:
        ok, res = calculate(message)
        if ok:
            return True, f"The answer is {res}."

    task_result = handle_task_intent(message)
    if task_result is not None:
        return task_result

    if is_system_question(message):
        return run_system_tool(message)

    return None
