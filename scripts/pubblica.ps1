# Marathon Coach: pubblicazione con un doppio clic su PUBBLICA.cmd
# Fa tutto da solo: Node.js, componenti, accesso a Cloudflare, database, segreti, pubblicazione.
# Ti chiede solo di accedere a Cloudflare nel browser e di incollare la chiave di intervals.icu.
# 'Continue': in Windows PowerShell gli avvisi di wrangler su stderr non devono fermare lo script (gli errori li controllo io)
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
function Passo($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Casuale($n) { $c = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; -join (1..$n | ForEach-Object { $c[(Get-Random -Maximum $c.Length)] }) }
# Esegue un comando unendo output ed errori (via cmd: niente eccezioni di PowerShell sugli avvisi)
# "< nul": nessuna domanda interattiva nascosta (wrangler risponde da solo o dà errore, mai si blocca)
function Esegui($cmd) { $o = (cmd /c "$cmd < nul 2>&1" | Out-String); return @{ out = $o; ok = ($LASTEXITCODE -eq 0) } }
# Prende la lista JSON dall'output di wrangler, ignorando righe tipo [WARNING] prima e dopo
function JsonDa($testo) {
  if ($testo -match '(?m)^\s*\[\]\s*$') { return @() }
  $m = [regex]::Match($testo, '(?ms)^\s*\[\s*$.*?^\s*\]\s*$')
  if (-not $m.Success) { $m = [regex]::Match($testo, '(?ms)^\s*\[\s*\{.*\}\s*\]\s*$') }
  if ($m.Success) { try { return @($m.Value | ConvertFrom-Json) } catch { } }
  return $null
}
function Segreto($nome, $valore) { $r = ($valore | cmd /c "npx wrangler secret put $nome 2>&1" | Out-String); if ($LASTEXITCODE -ne 0) { Write-Host $r; throw "Non riesco a salvare il segreto $nome" } }

try {
  Passo "1/6 Controllo Node.js"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js non c'e': lo installo (puo' chiederti una conferma di Windows)..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js installato: chiudi questa finestra e rilancia PUBBLICA.cmd" }
  }
  Write-Host "Node.js $(node -v): ok"

  Passo "2/6 Installo i componenti (un minuto)"
  $r = Esegui 'npm install --no-audit --no-fund --loglevel=error'
  if (-not $r.ok) { Write-Host $r.out; throw "npm install non riuscito" }

  Passo "3/6 Accesso a Cloudflare"
  $who = (Esegui 'npx wrangler whoami').out
  if ($who -match 'not authenticated|You are not|login') {
    Write-Host "Si apre il browser: accedi a Cloudflare e premi 'Allow', poi torna qui." -ForegroundColor Yellow
    npx wrangler login
    if ($LASTEXITCODE -ne 0) { throw "Accesso a Cloudflare non riuscito" }
  } else { Write-Host "Gia' collegato a Cloudflare: ok" }

  Passo "4/6 Database"
  $toml = Get-Content wrangler.toml -Raw
  if ($toml -match 'INCOLLA_QUI_ID_KV') {
    $r = Esegui 'npx wrangler kv namespace list'
    $lista = JsonDa $r.out
    if ($null -eq $lista) { Write-Host $r.out; throw "Non riesco a leggere i database di Cloudflare" }
    $ns = @($lista | Where-Object { $_.title -match '^marathon-coach' }) + @($lista | Where-Object { $_.title -eq 'KV' }) | Select-Object -First 1
    if ($ns) { $id = $ns.id; Write-Host "Trovato il database gia' esistente ($($ns.title)): lo riuso" }
    else {
      $out = (Esegui 'npx wrangler kv namespace create KV').out
      if ($out -notmatch '([0-9a-f]{32})') { Write-Host $out; throw "Non riesco a creare il database" }
      $id = $Matches[1]; Write-Host "Database creato"
    }
    $toml = $toml -replace 'INCOLLA_QUI_ID_KV', $id
    [IO.File]::WriteAllText((Join-Path (Get-Location) 'wrangler.toml'), $toml)
  } else { Write-Host "Database gia' configurato: ok" }

  Passo "5/6 Segreti"
  $esistenti = @()
  $sl = JsonDa (Esegui 'npx wrangler secret list').out   # se il Worker non esiste ancora: nessun segreto
  if ($sl) { $esistenti = @($sl | ForEach-Object { $_.name }) }
  $note = @()
  if ($esistenti -notcontains 'INTERVALS_API_KEY') {
    Write-Host "Serve la API key di intervals.icu: sul sito vai in Settings, scorri fino a 'Developer Settings' e copiala." -ForegroundColor Yellow
    $k = Read-Host "Incolla qui la API key di intervals.icu e premi Invio"
    if (-not $k.Trim()) { throw "API key di intervals.icu mancante" }
    Segreto 'INTERVALS_API_KEY' $k.Trim()
  } else { Write-Host "Chiave intervals.icu: gia' impostata" }
  if ($esistenti -notcontains 'DASH_TOKEN') {
    $pw = Casuale 32
    Segreto 'DASH_TOKEN' $pw
    $note += "Password della dashboard (DASH_TOKEN): $pw"
  } else { $note += "Password della dashboard: e' quella che usi gia' (non cambiata)" }
  if ($esistenti -notcontains 'MCP_SECRET') {
    $mcp = Casuale 48
    Segreto 'MCP_SECRET' $mcp
  } else { $mcp = $null }
  Write-Host "Segreti: ok"

  Passo "6/6 Pubblico la dashboard"
  $r = Esegui 'npx wrangler deploy'
  $dep = $r.out
  Write-Host $dep
  if (-not $r.ok) {
    if ($dep -match 'workers\.dev subdomain|register') { throw "Su Cloudflare manca il tuo sottodominio workers.dev: apri dash.cloudflare.com, entra in 'Workers e Pages' una volta (lo crea), poi rilancia PUBBLICA.cmd" }
    throw "Pubblicazione non riuscita"
  }
  $url = ([regex]::Match($dep, 'https://[^\s]+\.workers\.dev')).Value
  $txt = @("MARATHON COACH - indirizzi e chiavi (tienili per te)", "", "Dashboard: $url") + $note
  if ($mcp) { $txt += "Indirizzo del connettore per Claude (Impostazioni > Connettori > Aggiungi connettore personalizzato):"; $txt += "$url/mcp/$mcp" }
  else { $txt += "Connettore: il segreto era gia' impostato (MCP_SECRET), usa l'indirizzo che avevi gia'." }
  $file = Join-Path (Get-Location) 'INDIRIZZI-E-CHIAVI.txt'
  [IO.File]::WriteAllLines($file, $txt)
  Write-Host ""
  Write-Host "FATTO! Ho salvato indirizzi e password in INDIRIZZI-E-CHIAVI.txt (nella cartella del progetto)." -ForegroundColor Green
  Start-Process notepad.exe $file
  if ($url) { Start-Process $url }
} catch {
  Write-Host ""
  Write-Host "Qualcosa non e' andato: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Fai uno screenshot di questa finestra e mandalo a Claude."
}
