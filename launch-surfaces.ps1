param(
  [switch]$OpenBrowser = $true,
  [string]$HttpsConfig = "C:\TournamentPrivate\https\server.json"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = "node"
$serverScript = Join-Path $repoRoot "server-launcher.js"
if (!(Test-Path -LiteralPath $HttpsConfig -PathType Leaf)) { throw "HTTPS configuration not found. Run setup-https.ps1 first. HTTP-only startup is no longer supported." }
$HttpsConfig = (Resolve-Path -LiteralPath $HttpsConfig -ErrorAction Stop).Path
& $nodeExe -e "require(process.argv[1]).loadHttpsConfig(process.argv[2])" (Join-Path $repoRoot "backend\httpsConfig.js") $HttpsConfig
if ($LASTEXITCODE -ne 0) { throw "Invalid HTTPS installation. No surface processes were launched." }
$httpsSettings = Get-Content -LiteralPath $HttpsConfig -Raw | ConvertFrom-Json
$entryHost = $httpsSettings.hostname

$surfaces = @(
  [pscustomobject]@{
    Name = "pre"
    Port = 3443
    Url = "https://${entryHost}:3443/tournament-management/"
  },
  [pscustomobject]@{
    Name = "monitoring"
    Port = 3445
    Url = "https://${entryHost}:3445/event-progress/"
  },
  [pscustomobject]@{
    Name = "adminProgress"
    Port = 3447
    Url = "https://${entryHost}:3447/administration-progress/"
  }
)

$groupId = [guid]::NewGuid().ToString('N')
$groupPipe = "\\.\pipe\tournament-services-$groupId"
$groupToken = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
foreach ($surface in $surfaces) {
  $port = $surface.Port
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
  try { $probe.Start() }
  catch { throw "Port $port is already in use. Stop the existing services before launching this coordinated group. No services were launched." }
  finally { $probe.Stop() }
}

function Start-Surface {
  param(
    [Parameter(Mandatory = $true)]$Surface
  )

  $command = @"
Set-Location '$($repoRoot.Replace("'", "''"))'
`$env:TOURNAMENT_SURFACE = '$($Surface.Name)'
`$env:TOURNAMENT_HTTPS_CONFIG = '$($HttpsConfig.Replace("'", "''"))'
`$env:TOURNAMENT_SERVICE_GROUP = '$groupPipe'
`$env:TOURNAMENT_SERVICE_TOKEN = '$groupToken'
`$env:TOURNAMENT_HOME_URL = '$($surfaces[0].Url)'
`$env:TOURNAMENT_OPEN_HOME = '$(if ($OpenBrowser) { '1' } else { '0' })'
`$env:TOURNAMENT_CONSOLE_PID = [string]`$PID
Write-Host 'Starting surface: $($Surface.Name) ($($Surface.Port))'
Write-Host 'Entry URL: $($Surface.Url)'
& '$nodeExe' '$($serverScript.Replace("'", "''"))'
"@

  Start-Process -FilePath "powershell.exe" -WindowStyle Minimized -WorkingDirectory $repoRoot -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    $command
  ) | Out-Null
}

foreach ($surface in $surfaces) {
  Start-Surface -Surface $surface
}

Write-Host 'Three minimized service windows launched.'
if ($OpenBrowser) { Write-Host 'Tournament Management home opens when all services report ready.' }
