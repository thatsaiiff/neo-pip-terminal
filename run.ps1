$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python 3.10+ is required.' }
if (-not (Test-Path '.venv')) { python -m venv .venv }
& .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host 'Created .env from .env.example. Review it before connecting Kotak Neo.' }
New-Item -ItemType Directory -Force -Path 'data' | Out-Null
Write-Host 'Neo PIP local service: http://127.0.0.1:8000'
Write-Host 'Press Ctrl+C to stop. Live trading is disabled by default.'
$lanEnabled = (Select-String -Path '.env' -Pattern '^LAN_ACCESS_ENABLED=true\s*$' -Quiet)
if ($lanEnabled) {
    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.InterfaceAlias -notlike '*Loopback*' } | Select-Object -First 1 -ExpandProperty IPAddress)
    if ($lanIp) { Write-Host "Phone address on this Wi-Fi: http://${lanIp}:8000" }
    Write-Host 'LAN access is enabled. Enter LAN_ACCESS_TOKEN from .env when prompted on the phone.'
    Write-Host 'Keep this on a trusted private Wi-Fi network; disable LAN_ACCESS_ENABLED when finished.'
    python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
} else {
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
}
