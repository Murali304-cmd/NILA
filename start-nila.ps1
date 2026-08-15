# NILA launcher - starts a DEDICATED Ollama (port 11435) + the NILA server,
# then opens the browser. Used by "Start NILA.bat" (double-click).
# Why port 11435: other apps on this PC use Ollama's default port 11434;
# a dedicated instance guarantees nothing can evict gemma3:4b from RAM.

$ErrorActionPreference = "Stop"
$Nila = "D:\NILA"
$Python = "$Nila\venv\Scripts\python.exe"
$OllamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$ServerLog = "$Nila\server.log"
$OllamaPort = 11435

function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# 1) Dedicated Ollama (port 11435)
if (-not (Test-Port $OllamaPort)) {
    if (Test-Path $OllamaExe) {
        Write-Host "Starting dedicated Ollama (port $OllamaPort)..."
        # Perf: only ONE model in RAM at a time, keep it resident.
        $env:OLLAMA_HOST = "127.0.0.1:$OllamaPort"
        $env:OLLAMA_MAX_LOADED_MODELS = "1"
        $env:OLLAMA_KEEP_ALIVE = "-1"
        Start-Process -FilePath $OllamaExe -ArgumentList "serve" -WorkingDirectory (Split-Path $OllamaExe)
        $i = 0
        while (-not (Test-Port $OllamaPort) -and $i -lt 40) { Start-Sleep -Seconds 2; $i++ }
    } else {
        Write-Host "WARNING: Ollama not found. Install it, then run again."
    }
}
if (Test-Port $OllamaPort) { Write-Host "Dedicated Ollama: running (port $OllamaPort)" } else { Write-Host "Ollama: NOT running" }

# 2) NILA server (port 8000)
if (-not (Test-Port 8000)) {
    Write-Host "Starting NILA server..."
    Start-Process -FilePath $Python -ArgumentList "-m","uvicorn","backend.app:app","--host","0.0.0.0","--port","8000" -WorkingDirectory $Nila -WindowStyle Hidden -RedirectStandardOutput $ServerLog -RedirectStandardError "$ServerLog.err"
    $i = 0
    while (-not (Test-Port 8000) -and $i -lt 30) { Start-Sleep -Seconds 2; $i++ }
} else {
    Write-Host "NILA server: already running"
}

if (Test-Port 8000) {
    Write-Host "NILA is up -> opening browser"
    Start-Process "http://127.0.0.1:8000/"
} else {
    Write-Host "NILA server failed to start. See $ServerLog.err"
    Start-Sleep -Seconds 5
}
