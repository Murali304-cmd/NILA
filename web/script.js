/* ============================================================
   NILA — frontend logic
   Fast chat · search · documents · voice · settings
   ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  conversations: [],
  currentConversationId: null,
  currentTitle: "New Chat",
  currentMessages: [],
  attachments: [],            // [{id, name, size, status}] in current chat
  activeDocumentId: null,
  streaming: false,
  aborted: false,
  recording: false,
  mediaRecorder: null,
  audioChunks: [],
  recSeconds: 0,
  settings: {},
  speaking: false,
  models: [],
};

/* ============================================================
   Helpers
   ============================================================ */

function toast(text, isError = false, ms = 3000) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast"), ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = "Server error " + res.status;
    try {
      const data = await res.json();
      detail = data.detail || data.message || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ============================================================
   Confirm dialog (replaces confirm())
   ============================================================ */

let _confirmCb = null;

function confirmDialog(title, text, onOk, okLabel = "Yes, do it") {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  $("confirm-overlay").classList.remove("hidden");
  _confirmCb = onOk;
}

$("confirm-ok").addEventListener("click", () => {
  $("confirm-overlay").classList.add("hidden");
  const cb = _confirmCb; _confirmCb = null;
  if (cb) cb();
});
$("confirm-cancel").addEventListener("click", () => {
  $("confirm-overlay").classList.add("hidden");
  _confirmCb = null;
});
$("confirm-overlay").addEventListener("click", (e) => {
  if (e.target === $("confirm-overlay")) { $("confirm-overlay").classList.add("hidden"); _confirmCb = null; }
});

/* ============================================================
   Theme + appearance (localStorage)
   ============================================================ */

const THEME_KEY = "nila-theme2";
const systemLight = window.matchMedia("(prefers-color-scheme: light)");

function themePref() { return localStorage.getItem(THEME_KEY) || "light"; }

function resolvedTheme() {
  const p = themePref();
  if (p === "system") return systemLight.matches ? "light" : "dark";
  return p;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  const seg = $("set-theme");
  if (seg) seg.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.val === themePref()));
}

function toggleTheme() {
  const next = resolvedTheme() === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}

$("theme-toggle").addEventListener("click", toggleTheme);
systemLight.addEventListener("change", () => { if (themePref() === "system") applyTheme(); });

function applyAppearance() {
  document.body.dataset.fontsize = localStorage.getItem("nila-fontsize") || "md";
  document.body.dataset.density = localStorage.getItem("nila-density") || "comfortable";
  if (localStorage.getItem("nila-animations") === "0") {
    document.body.classList.add("no-anim");
    $("set-animations").checked = false;
  } else {
    document.body.classList.remove("no-anim");
    $("set-animations").checked = true;
  }
}

/* ============================================================
   Markdown rendering (local, offline, XSS-safe) + citations
   ============================================================ */

function inline(text) {
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return text;
}

function citationChips(html) {
  // [Excerpt 1 from 'file.pdf'] -> clickable chip
  return html.replace(/\[Excerpt\s*(\d+)\s*from\s*&#39;([^&#]+?)&#39;\]/g,
    (_, n, f) => `<button class="citation-chip" title="Source: ${f}" onclick="showCitation('${f.replace(/"/g, "&quot;")}')">📎 ${n} · ${f}</button>`);
}

function showCitation(filename) {
  const docs = state.attachments;
  toast(`Source: ${filename}`);
}

function renderSources(bubble, sources) {
  const seen = new Set();
  const chips = sources.filter((s) => {
    if (!s.filename || seen.has(s.filename)) return false;
    seen.add(s.filename);
    return true;
  }).map((s) =>
    `<button class="citation-chip" title="${escapeHtml(s.text)}" ` +
    `onclick="showCitation('${s.filename.replace(/"/g, "&quot;")}')">` +
    `📎 ${s.excerpt} · ${escapeHtml(s.filename)}</button>`).join("");
  if (!chips) return;
  const row = document.createElement("div");
  row.className = "sources-row";
  row.innerHTML = `<span class="sources-label">Sources</span>${chips}`;
  bubble.appendChild(row);
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let list = null;
  let para = [];

  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushPara = () => {
    if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara(); closeList();
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]); i++;
      }
      html += `<pre><code class="lang-${lang}">${code.join("\n")}</code></pre>`;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); closeList(); html += "<hr>"; continue;
    }

    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushPara(); closeList();
      html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      continue;
    }

    if (/^\s*&gt;\s?/.test(line)) {
      flushPara(); closeList();
      html += `<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`;
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(ul[1])}</li>`;
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(ol[1])}</li>`;
      continue;
    }

    if (!line.trim()) { flushPara(); closeList(); continue; }

    para.push(inline(line));
  }

  flushPara(); closeList();
  return citationChips(html);
}

/* ============================================================
   Chat rendering
   ============================================================ */

function chatEl() {
  let inner = document.querySelector(".chat-inner");
  if (!inner) {
    inner = document.createElement("div");
    inner.className = "chat-inner";
    $("chat").appendChild(inner);
  }
  return inner;
}

function clearChat() {
  const chat = $("chat");
  chat.innerHTML = "";
}

function scrollToBottom() {
  const chat = $("chat");
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
}

function addMessage(role, text) {
  const inner = chatEl();
  hideWelcome();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "assistant" ? "N" : "You";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  inner.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function showError(text) {
  const bubble = addMessage("assistant", "");
  bubble.classList.add("error");
  bubble.textContent = "⚠ " + text;
}

function hideWelcome() {
  const w = document.querySelector(".welcome");
  if (w) w.remove();
}

function showWelcome() {
  const inner = chatEl();
  if (document.querySelector(".welcome")) return;
  const div = document.createElement("div");
  div.className = "welcome";
  div.innerHTML = `
    <div class="welcome-icon">✦</div>
    <h2>Hello, I'm NILA</h2>
    <p>Your private AI assistant. It runs entirely on your laptop — free, fast and offline.
    Ask questions, upload documents, or try one of these:</p>
    <div class="suggestions">
      <button class="suggestion">What can you help me with?</button>
      <button class="suggestion">Explain how a neural network learns</button>
      <button class="suggestion">Add "practice SQL tomorrow" to my tasks</button>
      <button class="suggestion">Remember that I am learning machine learning</button>
    </div>`;
  inner.appendChild(div);
  div.querySelectorAll(".suggestion").forEach((btn) => {
    btn.onclick = () => sendMessage(btn.textContent);
  });
}

/* ---------- File cards in chat ---------- */

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📕";
  if (ext === "docx") return "📘";
  if (ext === "pptx") return "📙";
  return "📄";
}

function addFileCard(doc) {
  hideWelcome();
  const inner = chatEl();
  const card = document.createElement("div");
  card.className = "file-card";
  card.dataset.docId = doc.id;
  card.innerHTML = `
    <div class="fc-ic">${fileIcon(doc.name)}</div>
    <div class="fc-info">
      <div class="fc-name">${escapeHtml(doc.name)}</div>
      <div class="fc-meta">
        <span class="fc-size">${formatBytes(doc.size || 0)}</span>
        <span class="fc-status processing"><span class="spinner"></span> Processing…</span>
      </div>
    </div>
    <button class="fc-remove" title="Remove">✕</button>`;
  inner.appendChild(card);
  scrollToBottom();

  card.querySelector(".fc-remove").addEventListener("click", () => {
    confirmDialog("Delete this document?",
      `"${doc.name}" will be removed from the library and can no longer be searched.`,
      () => removeDocument(doc.id));
  });

  const idx = state.attachments.findIndex((a) => a.id === doc.id);
  const att = idx >= 0 ? state.attachments[idx]
    : { id: doc.id, name: doc.name, size: doc.size, status: "processing" };
  if (idx < 0) state.attachments.push(att);
  pollDocumentStatus(att, card);
  updateDocPicker();
  return card;
}

async function pollDocumentStatus(att, card) {
  let tries = 0;
  while (tries < 60) {
    try {
      const d = await api(`/api/documents/${att.id}`);
      const statusEl = card.querySelector(".fc-status");
      if (d.status === "ready") {
        att.status = "ready";
        statusEl.className = "fc-status ready";
        statusEl.textContent = `✓ Ready · ${d.chunks || 0} chunks`;
        toast(`"${d.filename}" indexed ✓`, false, 2000);
        refreshDocPicker();
        return;
      }
      if (d.status === "failed") {
        att.status = "failed";
        statusEl.className = "fc-status failed";
        statusEl.textContent = "⚠ Failed";
        toast(`Failed to index "${d.filename}": ${d.error || "unknown error"}`, true);
        return;
      }
    } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 1500));
    tries++;
  }
}

async function removeDocument(id) {
  try {
    await api(`/api/documents/${id}`, { method: "DELETE" });
    state.attachments = state.attachments.filter((a) => a.id !== id);
    if (state.activeDocumentId === id) state.activeDocumentId = null;
    document.querySelectorAll(`.file-card[data-doc-id="${id}"]`).forEach((el) => el.remove());
    updateDocPicker();
    toast("Document deleted");
  } catch (err) { toast(err.message, true); }
}

/* ============================================================
   Sidebar conversations (grouped)
   ============================================================ */

async function refreshConversations() {
  try {
    state.conversations = await api("/api/conversations");
  } catch (_) {
    state.conversations = [];
  }
  renderConversations();
}

function groupLabel(d) {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 6);
  if (d >= today) return "Today";
  if (d >= yesterday) return "Yesterday";
  if (d >= week) return "Previous 7 Days";
  return "Earlier";
}

function renderConversations() {
  const nav = $("convo-nav");
  nav.innerHTML = "";
  if (!state.conversations.length) {
    const empty = document.createElement("div");
    empty.className = "convo-group-label";
    empty.textContent = "No conversations yet";
    nav.appendChild(empty);
    return;
  }

  const groups = {};
  state.conversations.forEach((c) => {
    const d = new Date((c.updated_at || c.created_at).replace(" ", "T"));
    const label = groupLabel(d);
    (groups[label] = groups[label] || []).push(c);
  });
  const order = ["Today", "Yesterday", "Previous 7 Days", "Earlier"];
  for (const label of order) {
    if (!groups[label]) continue;
    const lbl = document.createElement("div");
    lbl.className = "convo-group-label";
    lbl.textContent = label;
    nav.appendChild(lbl);
    groups[label].forEach((c) => {
      const item = document.createElement("div");
      item.className = "convo-item" + (c.id === state.currentConversationId ? " active" : "");
      const title = document.createElement("span");
      title.className = "convo-title";
      title.textContent = c.title;
      title.title = c.summary || c.title;
      title.addEventListener("click", () => openConversation(c.id));
      const del = document.createElement("button");
      del.className = "convo-del";
      del.textContent = "🗑";
      del.title = "Delete conversation";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDialog("Delete this conversation?", `"${c.title}" will be permanently removed.`,
          () => deleteConversation(c.id));
      });
      item.appendChild(title);
      item.appendChild(del);
      nav.appendChild(item);
    });
  }
}

async function openConversation(id) {
  try {
    const data = await api(`/api/conversations/${id}/messages`);
    state.currentConversationId = id;
    state.currentTitle = data.conversation.title;
    state.currentMessages = data.messages.filter((m) => m.role === "user" || m.role === "assistant");
    state.activeDocumentId = null;
    state.attachments = [];

    clearChat();
    const inner = chatEl();
    (data.documents || []).forEach((d) => {
      addFileCard({ id: d.id, name: d.filename, size: d.size, status: d.status });
      state.attachments.push({ id: d.id, name: d.filename, size: d.size, status: d.status });
    });
    if (!state.currentMessages.length) {
      showWelcome();
    } else {
      state.currentMessages.forEach((m) => addMessage(m.role, m.content));
    }
    updateHeader();
    renderConversations();
    closeSidebar();
    scrollToBottom();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteConversation(id) {
  try {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    if (state.currentConversationId === id) newChat();
    else await refreshConversations();
  } catch (err) { toast(err.message, true); }
}

function newChat() {
  state.currentConversationId = null;
  state.currentTitle = "New Chat";
  state.currentMessages = [];
  state.attachments = [];
  state.activeDocumentId = null;
  clearChat();
  showWelcome();
  updateHeader();
  renderConversations();
  $("input").focus();
}

$("new-chat-btn").addEventListener("click", newChat);

function updateHeader() {
  $("main-title").textContent = state.currentTitle;
  const sub = state.currentConversationId
    ? `#${state.currentConversationId} · ${state.models[0] || state.settings.model || "local model"}`
    : "New conversation";
  $("header-sub").textContent = sub;
  updateDocPicker();
}

/* ============================================================
   Search (sidebar)
   ============================================================ */

$("search-input").addEventListener("input", debounce(async () => {
  const q = $("search-input").value.trim();
  if (q.length < 2) { $("search-results").classList.add("hidden"); return; }
  let results;
  try { results = await api("/api/search?q=" + encodeURIComponent(q)); }
  catch (_) { return; }

  const box = $("search-results");
  box.innerHTML = "";

  // current chat matches
  const chatHits = state.currentMessages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.content.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 4);
  if (chatHits.length) {
    const g = document.createElement("div");
    g.className = "sr-group"; g.textContent = "In this chat";
    box.appendChild(g);
    chatHits.forEach(({ m, i }) => {
      const it = document.createElement("div");
      it.className = "sr-item";
      it.innerHTML = `<span>${escapeHtml(m.content.slice(0, 60))}</span>
        <span class="sr-sub">${m.role === "user" ? "You" : "NILA"} · click to jump</span>`;
      it.addEventListener("click", () => {
        hideSearch();
        const msgs = document.querySelectorAll(".msg");
        if (msgs[i]) { msgs[i].scrollIntoView({ behavior: "smooth", block: "center" });
          msgs[i].style.outline = "2px solid var(--accent)";
          setTimeout(() => (msgs[i].style.outline = ""), 2000); }
      });
      box.appendChild(it);
    });
  }

  if (results.conversations.length) {
    const g = document.createElement("div");
    g.className = "sr-group"; g.textContent = "Conversations";
    box.appendChild(g);
    results.conversations.forEach((c) => {
      const it = document.createElement("div");
      it.className = "sr-item";
      it.innerHTML = `<span>💬 ${escapeHtml(c.title)}</span>
        <span class="sr-sub">${escapeHtml((c.summary || "").slice(0, 70))}</span>`;
      it.addEventListener("click", () => { hideSearch(); openConversation(c.id); });
      box.appendChild(it);
    });
  }

  if (results.documents.length) {
    const g = document.createElement("div");
    g.className = "sr-group"; g.textContent = "Documents";
    box.appendChild(g);
    results.documents.forEach((d) => {
      const it = document.createElement("div");
      it.className = "sr-item";
      it.innerHTML = `<span>${fileIcon(d.filename)} ${escapeHtml(d.filename)}</span>
        <span class="sr-sub">${d.status} · ${d.chunks} chunks</span>`;
      it.addEventListener("click", () => {
        hideSearch();
        openSettings("documents");
        toast("Manage documents in Settings → Documents");
      });
      box.appendChild(it);
    });
  }

  if (results.memories.length) {
    const g = document.createElement("div");
    g.className = "sr-group"; g.textContent = "Memories";
    box.appendChild(g);
    results.memories.forEach((m) => {
      const it = document.createElement("div");
      it.className = "sr-item";
      it.innerHTML = `<span>🧠 ${escapeHtml(m.value)}</span>
        <span class="sr-sub">${escapeHtml(m.key.replace(/_/g, " "))}</span>`;
      it.addEventListener("click", () => {
        hideSearch();
        openSettings("memory");
      });
      box.appendChild(it);
    });
  }

  if (!box.children.length) {
    box.innerHTML = '<div class="sr-empty">No matches for “' + escapeHtml(q) + '”</div>';
  }
  box.classList.remove("hidden");
}, 220));

function hideSearch() {
  $("search-results").classList.add("hidden");
  $("search-input").value = "";
}

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("input") &&
      !$("settings-overlay").classList.contains("hidden") === false) {
    e.preventDefault();
    $("search-input").focus();
  }
  if (e.key === "Escape") {
    hideSearch();
    if (!$("settings-overlay").classList.contains("hidden")) closeSettings();
  }
});

/* ============================================================
   Sending messages (SSE streaming)
   ============================================================ */

async function sendMessage(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || state.streaming) return;

  addMessage("user", trimmed);
  state.currentMessages.push({ role: "user", content: trimmed });
  $("input").value = "";
  autoResize();

  state.streaming = true;
  state.aborted = false;
  $("send-btn").disabled = true;
  $("stop-btn").classList.remove("hidden");

  const controller = new AbortController();
  state.abortController = controller;
  $("stop-btn").onclick = () => {
    state.aborted = true;
    controller.abort();
  };

  // Assistant bubble with live status chip (driven by real SSE status events)
  hideWelcome();
  const bubble = addMessage("assistant", "");
  bubble.innerHTML =
    '<div class="md"></div>' +
    '<div class="typing-status">✦ NILA is analyzing…</div>' +
    '<div class="typing-dots"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>';

  const STATUS_TEXT = {
    thinking: "✦ NILA is analyzing…",
    memory: "Checking memory…",
    context: "Understanding context…",
    search: "Searching your document…",
    reading: "Finding relevant information…",
    tool: "Using a tool…",
    generating: "✦ Generating…",
  };
  const setStatus = (phase) => {
    const el = bubble.querySelector(".typing-status");
    if (el) el.textContent = STATUS_TEXT[phase] || "✦ NILA is analyzing…";
  };

  let reply = "";
  let errored = false;
  let usedCache = false;
  let sources = [];
  let perf = null;
  let gotToken = false;

  // rAF-throttled markdown render: never re-render on every single token.
  let rafId = null;
  const renderNow = () => {
    rafId = null;
    if (!state.aborted && bubble.isConnected) {
      bubble.querySelector(".md").innerHTML = renderMarkdown(reply);
      scrollToBottom();
    }
  };
  const scheduleRender = () => {
    if (!rafId) rafId = requestAnimationFrame(renderNow);
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: trimmed,
        conversation_id: state.currentConversationId,
        document_id: state.activeDocumentId,
        document_ids: state.attachments.map((a) => a.id),
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) throw new Error("Server error " + res.status);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop();

      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { continue; }

        if (parsed.meta) {
          state.currentConversationId = parsed.meta.conversation_id;
          state.currentTitle = parsed.meta.title;
          if (parsed.meta.model) state.models[0] = parsed.meta.model;
          updateHeader();
          await refreshConversations();
        }

        if (parsed.status) {
          setStatus(parsed.status);
          if (parsed.status === "generating") {
            const dots = bubble.querySelector(".typing-dots");
            if (dots) dots.remove();
          }
        }

        if (parsed.token) {
          if (!gotToken) {
            gotToken = true;
            setStatus("generating");
            const dots = bubble.querySelector(".typing-dots");
            if (dots) dots.remove();
          }
          reply += parsed.token;
          scheduleRender();
        }

        if (parsed.error) {
          errored = true;
          bubble.classList.add("error");
          bubble.querySelector(".md").textContent = "⚠ " + parsed.error;
        }

        if (parsed.cached) usedCache = true;
        if (parsed.sources && parsed.sources.length) {
          sources = parsed.sources;
          sources.sort((a, b) => a.excerpt - b.excerpt);
        }
        if (parsed.first_token_ms != null) {
          perf = parsed;
        }
        if (parsed.done) break;
      }
    }

    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    if (!state.aborted) {
      state.currentMessages.push({ role: "assistant", content: reply });
      const statusEl = bubble.querySelector(".typing-status");
      if (statusEl) statusEl.remove();
      if (sources.length) renderSources(bubble, sources);
      if (!errored && perf && (state.settings?.show_perf_metrics !== false)) {
        renderPerfLine(bubble, perf, usedCache);
      }
      if (usedCache) toast("⚡ Replied from cache (identical question)", false, 1800);
      else if (!errored && reply && autoSpeakEnabled()) speak(reply);
      await refreshConversations();
      updateHeader();
    } else {
      toast("Stopped", false, 1500);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      if (bubble.isConnected) {
        bubble.classList.add("error");
        bubble.querySelector(".md").textContent = "⚠ Connection problem: " + err.message;
      }
    }
  } finally {
    state.streaming = false;
    $("send-btn").disabled = false;
    $("stop-btn").classList.add("hidden");
    $("input").focus();
  }
}

function renderPerfLine(bubble, perf, cached) {
  const parts = [];
  if (cached) parts.push("⚡ cached");
  if (perf.first_token_ms != null)
    parts.push(`first token ${(perf.first_token_ms / 1000).toFixed(2)}s`);
  if (perf.latency_ms != null)
    parts.push(`total ${(perf.latency_ms / 1000).toFixed(2)}s`);
  if (perf.tokens_per_sec != null)
    parts.push(`${perf.tokens_per_sec} tok/s`);
  if (perf.rag_ms) parts.push(`RAG ${perf.rag_ms}ms`);
  if (perf.db_ms) parts.push(`DB ${perf.db_ms}ms`);
  if (!parts.length) return;
  const row = document.createElement("div");
  row.className = "perf-line";
  row.textContent = "⚡ " + parts.join(" · ");
  bubble.appendChild(row);
}

function autoSpeakEnabled() {
  return localStorage.getItem("nila-voice") === "1" &&
         localStorage.getItem("nila-auto-speak") === "1";
}

/* ============================================================
   Input handling
   ============================================================ */

function autoResize() {
  const el = $("input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

$("input").addEventListener("input", autoResize);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage($("input").value);
  }
});
$("send-btn").addEventListener("click", () => sendMessage($("input").value));

/* ============================================================
   Document upload + picker
   ============================================================ */

$("attach-btn").addEventListener("click", () => $("file-input").click());
$("set-doc-upload").addEventListener("click", () => $("file-input").click());

$("file-input").addEventListener("change", async () => {
  const file = $("file-input").files[0];
  $("file-input").value = "";
  if (!file) return;

  const allowed = [".pdf", ".docx", ".pptx", ".txt", ".md"];
  const ext = "." + file.name.split(".").pop().toLowerCase();
  if (!allowed.includes(ext)) { toast("Unsupported file type. Use PDF, DOCX, PPTX, TXT or MD.", true); return; }
  if (file.size > 20 * 1024 * 1024) { toast("File is larger than the 20 MB limit.", true); return; }

  const card = addFileCard({ id: 0, name: file.name, size: file.size, status: "processing" });

  const form = new FormData();
  form.append("file", file);
  if (state.currentConversationId) form.append("conversation_id", state.currentConversationId);

  try {
    const result = await api("/api/documents", { method: "POST", body: form });
    const att = state.attachments.find((a) => a.name === file.name);
    if (att) att.id = result.id;
    card.dataset.docId = result.id;
    state.activeDocumentId = state.activeDocumentId || result.id;
    pollDocumentStatus(att || { id: result.id, name: file.name, status: "processing" }, card);
  } catch (err) {
    card.querySelector(".fc-status").className = "fc-status failed";
    card.querySelector(".fc-status").textContent = "⚠ Failed";
    toast(err.message, true);
  }
  refreshDocPicker();
});

/* Document picker chip in the header */
function updateDocPicker() {
  const btn = $("doc-picker-btn");
  const docs = state.attachments.filter((a) => a.id);
  if (!docs.length) { btn.classList.add("hidden"); return; }
  btn.classList.remove("hidden");
  const active = docs.find((d) => d.id === state.activeDocumentId) || docs[0];
  $("doc-picker-name").textContent = active ? active.name : "Ask a document";
  $("doc-picker-name").title = active ? active.name : "";
  renderDocMenu(docs, active);
}

function renderDocMenu(docs, active) {
  const menu = $("doc-menu");
  menu.innerHTML = "";
  docs.forEach((d) => {
    const it = document.createElement("div");
    it.className = "dm-item";
    it.innerHTML = `<span>${fileIcon(d.name)}</span>
      <span class="dm-name">${escapeHtml(d.name)}</span>
      <span class="dm-status">${d.status === "ready" ? "✓" : "…"}</span>
      ${d.id === (active && active.id) ? '<span class="dm-check">✓</span>' : ""}`;
    it.addEventListener("click", () => {
      state.activeDocumentId = d.id;
      updateDocPicker();
      $("doc-menu").classList.add("hidden");
      toast(`Asking NILA about "${d.name}"`);
    });
    menu.appendChild(it);
  });
  const clear = document.createElement("button");
  clear.className = "dm-clear";
  clear.textContent = "No specific document (search all)";
  clear.addEventListener("click", () => {
    state.activeDocumentId = null;
    updateDocPicker();
    $("doc-menu").classList.add("hidden");
  });
  menu.appendChild(clear);
}

function refreshDocPicker() {
  const docs = state.attachments.filter((a) => a.id);
  const active = docs.find((d) => d.id === state.activeDocumentId);
  updateDocPicker();
}

$("doc-picker-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("doc-menu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".doc-menu") && !e.target.closest("#doc-picker-btn")) {
    $("doc-menu").classList.add("hidden");
  }
});

/* ============================================================
   Voice — push-to-talk + voice replies
   ============================================================ */

const micBtn = $("mic-btn");
const mediaSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

function startRecording() {
  if (!mediaSupported) { toast("Microphone not supported in this browser.", true); return; }
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    state.recording = true;
    state.audioChunks = [];
    state.recSeconds = 0;
    micBtn.classList.add("recording");
    $("recording-chip").classList.remove("hidden");
    $("rec-timer").textContent = "0:00";
    state.recTimer = setInterval(() => {
      state.recSeconds++;
      const m = Math.floor(state.recSeconds / 60);
      const s = state.recSeconds % 60;
      $("rec-timer").textContent = `${m}:${String(s).padStart(2, "0")}`;
    }, 1000);

    const recorder = new MediaRecorder(stream);
    state.mediaRecorder = recorder;
    recorder.ondataavailable = (e) => state.audioChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(state.recTimer);
      state.recording = false;
      micBtn.classList.remove("recording");
      $("recording-chip").classList.add("hidden");
      if (state.cancelled) { state.cancelled = false; return; }
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(state.audioChunks, { type });
      if (state.audioChunks.length) sendAudio(blob);
    };
    recorder.start();
  }).catch(() => {
    state.recording = false;
    toast("Microphone not available — check OS/browser permissions.", true);
  });
}

function stopRecording() {
  if (state.recording && state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
}

$("rec-cancel").addEventListener("click", () => {
  state.cancelled = true;
  stopRecording();
});

// Hold-to-talk
micBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!state.recording) startRecording();
});
["pointerup", "pointerleave", "pointercancel"].forEach((ev) => {
  micBtn.addEventListener(ev, () => { if (state.recording) stopRecording(); });
});
window.addEventListener("pointerup", () => { if (state.recording) stopRecording(); });

async function sendAudio(blob) {
  const form = new FormData();
  form.append("file", blob, "voice.webm");
  try {
    const data = await api("/api/stt", { method: "POST", body: form });
    $("input").value = data.text;
    autoResize();
    $("input").focus();
    toast("✓ Transcribed — press Enter to send");
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- Voice replies ---------- */

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  const voices = speechSynthesis.getVoices();
  const pick = $("set-voice-pick");
  const current = localStorage.getItem("nila-voice-name") || "";
  pick.innerHTML = '<option value="">Default voice</option>';
  voices.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    opt.selected = v.name === current;
    pick.appendChild(opt);
  });
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  state.speaking = true;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 2000));
  u.rate = parseFloat(localStorage.getItem("nila-rate") || "1.0");
  u.volume = parseFloat(localStorage.getItem("nila-volume") || "1.0");
  const name = localStorage.getItem("nila-voice-name");
  if (name) {
    const v = speechSynthesis.getVoices().find((x) => x.name === name);
    if (v) u.voice = v;
  }
  u.onend = () => { state.speaking = false; };
  u.onerror = () => { state.speaking = false; };
  speechSynthesis.speak(u);
}

$("set-stop-speaking").addEventListener("click", () => {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.speaking = false;
});

/* ============================================================
   Settings
   ============================================================ */

function openSettings(section = null) {
  $("settings-overlay").classList.remove("hidden");
  if (section) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.section === section));
    document.querySelectorAll(".s-section").forEach((s) =>
      s.classList.toggle("active", s.id === "s-" + section));
  }
  loadSettings();
  if (section === "documents") refreshSettingsDocuments();
  if (section === "memory") refreshSettingsMemory();
  refreshStats();
}
function closeSettings() { $("settings-overlay").classList.add("hidden"); }

$("settings-btn").addEventListener("click", () => openSettings());
$("settings-btn-top").addEventListener("click", () => openSettings());
$("settings-close").addEventListener("click", closeSettings);
$("settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("settings-overlay")) closeSettings();
});

$("settings-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  document.querySelectorAll(".s-section").forEach((s) =>
    s.classList.toggle("active", s.id === "s-" + tab.dataset.section));
  if (tab.dataset.section === "documents") refreshSettingsDocuments();
  if (tab.dataset.section === "memory") refreshSettingsMemory();
  if (tab.dataset.section === "performance") refreshStats();
});

/* Server settings */
const saveServerSettings = debounce(async () => {
  const body = {
    temperature: parseFloat($("set-temperature").value),
    max_tokens: parseInt($("set-max-tokens").value),
    streaming: $("set-streaming").checked,
    style: $("set-style").value,
    context_length: parseInt($("set-context").value),
    cache_enabled: $("set-cache").checked,
    rag_enabled: $("set-rag").checked,
    rag_k: parseInt($("set-ragk").value),
    prev_chat_memory: $("set-prevchat").checked,
    auto_title: $("set-auto-title").checked,
    memory_enabled: $("set-memory-enabled").checked,
    auto_speak: $("set-auto-speak").checked,
    model: $("set-model").value,
  };
  try {
    await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) { toast(err.message, true); }
}, 500);

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    state.settings = s;
    state.models = s.models || [];

    const modelSel = $("set-model");
    if (modelSel.options.length === 0 && s.models?.length) {
      s.models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m; opt.textContent = m;
        modelSel.appendChild(opt);
      });
    }
    if (s.model) modelSel.value = s.model;

    $("set-temperature").value = s.temperature ?? 0.7;
    $("set-temperature-val").textContent = s.temperature ?? 0.7;
    $("set-max-tokens").value = s.max_tokens ?? 1024;
    $("set-max-tokens-val").textContent = s.max_tokens ?? 1024;
    $("set-context").value = s.context_length ?? 10;
    $("set-context-val").textContent = s.context_length ?? 10;
    $("set-ragk").value = s.rag_k ?? 4;
    $("set-ragk-val").textContent = s.rag_k ?? 4;
    $("set-style").value = s.style || "";
    $("set-streaming").checked = s.streaming !== false;
    $("set-cache").checked = s.cache_enabled !== false;
    $("set-rag").checked = s.rag_enabled !== false;
    $("set-prevchat").checked = s.prev_chat_memory !== false;
    $("set-auto-title").checked = s.auto_title !== false;
    $("set-memory-enabled").checked = s.memory_enabled !== false;
    $("set-auto-speak").checked = !!s.auto_speak;
  } catch (_) {}
}

["set-temperature", "set-max-tokens", "set-context", "set-ragk"].forEach((id) => {
  $(id).addEventListener("input", () => {
    const valEl = $(id + "-val");
    if (valEl) valEl.textContent = $(id).value;
  });
});

["set-temperature", "set-max-tokens", "set-style", "set-streaming",
 "set-context", "set-cache", "set-rag", "set-ragk", "set-prevchat",
 "set-auto-title", "set-memory-enabled", "set-auto-speak", "set-model"]
  .forEach((id) => $(id).addEventListener("change", saveServerSettings));

/* Local appearance */
$("set-theme").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  localStorage.setItem(THEME_KEY, btn.dataset.val);
  applyTheme();
});
$("set-fontsize").addEventListener("change", (e) => {
  localStorage.setItem("nila-fontsize", e.target.value);
  applyAppearance();
});
$("set-density").addEventListener("change", (e) => {
  localStorage.setItem("nila-density", e.target.value);
  applyAppearance();
});
$("set-animations").addEventListener("change", (e) => {
  localStorage.setItem("nila-animations", e.target.checked ? "1" : "0");
  applyAppearance();
});

/* Voice local prefs */
$("set-voice").addEventListener("change", (e) => {
  localStorage.setItem("nila-voice", e.target.checked ? "1" : "0");
});
$("set-auto-speak").addEventListener("change", (e) => {
  localStorage.setItem("nila-auto-speak", e.target.checked ? "1" : "0");
  // auto_speak is also a server setting; debounced PUT covers it
});
$("set-voice-pick").addEventListener("change", (e) => {
  localStorage.setItem("nila-voice-name", e.target.value);
});
$("set-rate").addEventListener("input", (e) => {
  $("set-rate-val").textContent = e.target.value;
});
$("set-rate").addEventListener("change", (e) => {
  localStorage.setItem("nila-rate", e.target.value);
  $("set-rate-val").textContent = e.target.value;
});
$("set-volume").addEventListener("input", (e) => {
  $("set-volume-val").textContent = e.target.value;
});
$("set-volume").addEventListener("change", (e) => {
  localStorage.setItem("nila-volume", e.target.value);
  $("set-volume-val").textContent = e.target.value;
});

/* Memory section */
$("set-memory-add").addEventListener("click", async () => {
  const text = $("set-memory-input").value.trim();
  if (!text) return;
  const value = text.replace(/^remember\s+(that\s+)?/i, "").replace(/[.!?]+$/, "");
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "").slice(0, 60) || "fact";
  try {
    await api("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    $("set-memory-input").value = "";
    toast("Saved to memory ✓");
  } catch (err) { toast(err.message, true); }
  refreshSettingsMemory();
});

async function refreshSettingsMemory() {
  const list = $("set-memory-list");
  try {
    const memories = await api("/api/memory");
    list.innerHTML = "";
    if (!memories.length) {
      list.innerHTML = '<div class="sl-empty s-hint">Nothing stored yet.</div>';
      return;
    }
    memories.forEach((m) => {
      const item = document.createElement("div");
      item.className = "sl-item";
      item.innerHTML = `
        <div class="sl-main">
          <div class="sl-name">${escapeHtml(m.value)}</div>
          <div class="sl-sub">${escapeHtml(m.key.replace(/_/g, " "))} · ${m.source}</div>
        </div>
        <div class="sl-actions">
          <button class="mini ok" data-edit="${m.id}" title="Edit">✏️</button>
          <button class="mini danger" data-del="${m.id}" title="Delete">✕</button>
        </div>`;
      list.appendChild(item);
    });
    list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", async () => {
      const mem = memories.find((x) => x.id === parseInt(b.dataset.edit));
      const value = prompt("Edit this memory:", mem.value);
      if (value == null || !value.trim()) return;
      try {
        await api(`/api/memory/${mem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: value.trim() }),
        });
        toast("Memory updated ✓");
      } catch (err) { toast(err.message, true); }
      refreshSettingsMemory();
    }));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api(`/api/memory/${b.dataset.del}`, { method: "DELETE" });
        toast("Forgotten ✓");
      } catch (err) { toast(err.message, true); }
      refreshSettingsMemory();
    }));
  } catch (_) { list.innerHTML = '<div class="s-hint">Cannot reach server.</div>'; }
}

$("set-memory-clear").addEventListener("click", () => {
  confirmDialog("Clear all memories?", "All long-term facts about you will be deleted.",
    async () => {
      try { await api("/api/memory", { method: "DELETE" }); toast("All memories cleared"); }
      catch (err) { toast(err.message, true); }
      refreshSettingsMemory();
    });
});

/* Chat section */
$("set-export-chat").addEventListener("click", () => {
  const lines = [`# ${state.currentTitle}`, "",
    `*Exported from NILA · ${new Date().toLocaleString()}*`, ""];
  state.currentMessages.forEach((m) => {
    lines.push(`**${m.role === "user" ? "You" : "NILA"}:**`, "", m.content, "");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.currentTitle.replace(/[^\w\- ]+/g, "").slice(0, 40) || "chat") + ".md";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Chat exported ✓");
});

$("set-clear-chats").addEventListener("click", () => {
  confirmDialog("Clear all conversations?",
    "Every conversation will be permanently deleted. Documents stay.",
    async () => {
      try {
        await api("/api/conversations", { method: "DELETE" });
        newChat();
        toast("All conversations cleared");
      } catch (err) { toast(err.message, true); }
    });
});

/* Documents section */
async function refreshSettingsDocuments() {
  const list = $("set-doc-list");
  try {
    const data = await api("/api/documents");
    const idx = data.index || {};
    $("set-doc-index").textContent =
      `${data.documents.length} docs · ${idx.chunks ?? 0} chunks · ${idx.embedding_model || ""}`;
    list.innerHTML = "";
    if (!data.documents.length) {
      list.innerHTML = '<div class="s-hint">No documents yet. Upload a PDF, DOCX, PPTX or TXT.</div>';
      return;
    }
    data.documents.forEach((d) => {
      const item = document.createElement("div");
      item.className = "sl-item";
      const statusIcon = d.status === "ready" ? "✓" : d.status === "failed" ? "⚠" : "…";
      const statusColor = d.status === "failed" ? "var(--danger)" : "var(--ok)";
      item.innerHTML = `
        <div class="sl-main">
          <div class="sl-name">${fileIcon(d.filename)} ${escapeHtml(d.filename)}</div>
          <div class="sl-sub"><span style="color:${statusColor}">${statusIcon} ${d.status}</span>
            · ${d.chunks} chunks · ${formatBytes(d.size)}</div>
        </div>
        <div class="sl-actions">
          <button class="mini ok" data-reidx="${d.id}" title="Re-index">↻</button>
          <button class="mini danger" data-del="${d.id}" title="Delete">✕</button>
        </div>`;
      list.appendChild(item);
    });
    list.querySelectorAll("[data-reidx]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api(`/api/documents/${b.dataset.reidx}/reindex`, { method: "POST" });
        toast("Re-indexing in the background…");
      } catch (err) { toast(err.message, true); }
      setTimeout(refreshSettingsDocuments, 2500);
    }));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      const d = data.documents.find((x) => x.id === parseInt(b.dataset.del));
      confirmDialog("Delete document?", `"${d.filename}" will be removed.`,
        async () => {
          try { await api(`/api/documents/${d.id}`, { method: "DELETE" }); toast("Deleted"); }
          catch (err) { toast(err.message, true); }
          refreshSettingsDocuments();
          refreshDocPicker();
        });
    }));
  } catch (_) { list.innerHTML = '<div class="s-hint">Cannot reach server.</div>'; }
}

$("set-doc-clear").addEventListener("click", () => {
  confirmDialog("Clear the vector database?", "All documents and their index will be deleted.",
    async () => {
      try {
        await api("/api/documents", { method: "DELETE" });
        toast("Vector database cleared");
      } catch (err) { toast(err.message, true); }
      refreshSettingsDocuments();
      refreshDocPicker();
    });
});

/* Privacy */
$("set-clear-all").addEventListener("click", () => {
  confirmDialog("Clear ALL local data?",
    "Deletes memories, conversations, documents and the vector index. This cannot be undone.",
    async () => {
      try {
        await Promise.all([
          api("/api/conversations", { method: "DELETE" }),
          api("/api/memory", { method: "DELETE" }),
          api("/api/documents", { method: "DELETE" }),
        ]);
        toast("All local data cleared");
        newChat();
        refreshSettingsMemory();
        refreshSettingsDocuments();
      } catch (err) { toast(err.message, true); }
    });
});

/* Performance */
async function refreshStats() {
  try {
    const s = await api("/api/stats");
    $("set-stats").textContent =
      `Chats completed     : ${s.chats}\n` +
      `Avg first token     : ${s.avg_first_token_ms ?? "-"} ms\n` +
      `Avg total latency   : ${s.avg_latency_ms ?? "-"} ms\n` +
      `Avg tokens / sec    : ${s.avg_tokens_per_sec ?? "-"}\n` +
      `Avg RAG retrieval   : ${s.avg_rag_ms ?? "-"} ms (${s.rag_searches} searches)\n` +
      `Avg DB time/chat    : ${s.avg_db_ms ?? "-"} ms\n` +
      `Cache               : ${s.cache_hits} hits · ${s.cache_misses} misses · ${s.cache_size} entries\n` +
      `Tokens streamed     : ${s.tokens_out}\n` +
      `Process RAM         : ${s.ram_mb ?? "-"} MB   CPU: ${s.cpu_pct ?? "-"}%\n` +
      `System RAM free     : ${s.ram_free_mb ?? "-"} / ${s.total_ram_mb ?? "-"} MB\n` +
      `Documents indexed   : ${s.documents}\n` +
      `Conversations saved : ${s.conversations}\n` +
      `Server started      : ${s.started}`;
  } catch (_) { $("set-stats").textContent = "Server unreachable."; }
}

/* ============================================================
   Status + boot
   ============================================================ */

async function checkStatus() {
  let ok = false;
  let model = "";
  try {
    const data = await api("/api/health");
    ok = data.available;
    model = data.model;
  } catch (_) { ok = false; }

  const chip = $("status-chip");
  chip.className = "status-chip " + (ok ? "ok" : "err");
  $("status-text").textContent = ok ? `Connected · ${model}` : "Server offline";
  $("input-note-model").textContent = model || "gemma3:4b";
}

$("status-chip").addEventListener("click", checkStatus);

/* Sidebar mobile */
$("menu-btn").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("backdrop").classList.add("show");
});
$("backdrop").addEventListener("click", closeSidebar);
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("backdrop").classList.remove("show");
}

/* Boot */
(async function init() {
  applyTheme();
  applyAppearance();
  $("set-fontsize").value = localStorage.getItem("nila-fontsize") || "md";
  $("set-density").value = localStorage.getItem("nila-density") || "comfortable";
  $("set-voice").checked = localStorage.getItem("nila-voice") === "1";
  $("set-rate").value = localStorage.getItem("nila-rate") || "1.0";
  $("set-rate-val").textContent = $("set-rate").value;
  $("set-volume").value = localStorage.getItem("nila-volume") || "1.0";
  $("set-volume-val").textContent = $("set-volume").value;

  showWelcome();
  $("input").focus();
  await refreshConversations();
  await loadSettings();
  checkStatus();
  setInterval(checkStatus, 15000);
})();
