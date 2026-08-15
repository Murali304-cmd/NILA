import urllib.request, json, time, sys

B = "http://127.0.0.1:8000"

def chat(msg):
    body = {"message": msg}
    t0 = time.perf_counter()
    r = urllib.request.urlopen(urllib.request.Request(
        B + "/api/chat", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}), timeout=900)
    out, statuses, done = "", [], None
    for raw in r:
        line = raw.decode().strip()
        if not line.startswith("data:"):
            continue
        obj = json.loads(line[5:].strip())
        if obj.get("status"):
            statuses.append(obj["status"])
        if "token" in obj:
            out += obj["token"]
        if obj.get("done"):
            done = obj
    return out, statuses, done, int((time.perf_counter() - t0) * 1000)

tests = sys.argv[1:]
for msg in tests:
    t0 = time.time()
    out, st, done, client = chat(msg)
    if done:
        print(f"[{time.time()-t0:6.1f}s] {msg[:36]:38} first={done.get('first_token_ms')}ms "
              f"total={done.get('latency_ms')}ms tps={done.get('tokens_per_sec')} "
              f"len={len(out)} statuses={st}", flush=True)
    else:
        print(f"[{time.time()-t0:6.1f}s] {msg[:36]:38} NO DONE", flush=True)
