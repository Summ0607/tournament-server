$ErrorActionPreference = 'Stop'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("launcher-check-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type @'
public class LauncherTestListener {
  public static int FailPort = -1;
  public static System.Collections.Generic.List<int> Ports = new System.Collections.Generic.List<int>();
  public int Port;
  public LauncherTestListener(System.Net.IPAddress address, int port) { Port = port; }
  public void Start() { Ports.Add(Port); if (Port == FailPort) throw new System.Exception("Occupied"); }
  public void Stop() {}
}
'@
function node { $global:LASTEXITCODE = 0 }
function Start-Process {
  param($FilePath, $WindowStyle, $WorkingDirectory, $ArgumentList)
  $global:launcherStarted.Add([pscustomobject]@{ File = $FilePath; Style = $WindowStyle; Arguments = $ArgumentList })
}
try {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\launch-surfaces.ps1') -Raw
  $fixture = Join-Path $root 'launch-surfaces.ps1'
  $source.Replace('[System.Net.Sockets.TcpListener]', '[LauncherTestListener]') | Set-Content -LiteralPath $fixture
  $config = Join-Path $root 'server.json'
  '{"hostname":"test.home.arpa"}' | Set-Content -LiteralPath $config
  foreach ($mode in @('default', 'no-browser')) {
    [LauncherTestListener]::Ports.Clear()
    $global:launcherStarted = [System.Collections.Generic.List[object]]::new()
    if ($mode -eq 'default') { & $fixture -HttpsConfig $config }
    elseif ($mode -eq 'no-browser') { & $fixture -HttpsConfig $config -OpenBrowser:$false }
    if ($launcherStarted.Count -ne 3) { throw "Expected exactly three service consoles, not a fourth browser console." }
    $pipes = @()
    foreach ($process in $launcherStarted) {
      if ($process.File -ne 'powershell.exe' -or $process.Style -ne 'Minimized') { throw 'Service console was not minimized.' }
      $command = $process.Arguments[-1]
      if ($command -notmatch "TOURNAMENT_SERVICE_GROUP = '([^']+)'") { throw 'Missing coordinator pipe.' }
      $pipes += $Matches[1]
      $browserFlag = if ($mode -eq 'no-browser') { '0' } else { '1' }
      if (!$command.Contains("TOURNAMENT_OPEN_HOME = '$browserFlag'")) { throw 'Wrong initial browser policy.' }
      $expectedHomeUrl = 'https://test.home.arpa:3443/tournament-management/'
      if (!$command.Contains("TOURNAMENT_HOME_URL = '$expectedHomeUrl'")) { throw 'Home URL was not Tournament Management.' }
      if (!$command.Contains("TOURNAMENT_CONSOLE_PID = [string]")) { throw 'Console identity missing for restart minimization.' }
    }
    if (($pipes | Select-Object -Unique).Count -ne 1) { throw 'Services did not share one coordinator.' }
    if (([LauncherTestListener]::Ports -join ',') -ne '3443,3445,3447') { throw 'Launcher must preflight only the three HTTPS ports.' }
  }
  [LauncherTestListener]::FailPort = 3445
  $launcherStarted.Clear()
  $rejected = $false
  try { & $fixture -HttpsConfig $config } catch {
    if ($_.Exception.Message -notmatch 'already in use') { throw }
    $rejected = $true
  }
  if (!$rejected -or $launcherStarted.Count -ne 0) { throw 'Occupied port must reject the entire launch before starting any services.' }
  foreach ($mode in @('http-only', 'missing-config', 'invalid-config')) {
    $launcherStarted.Clear()
    $rejected = $false
    try {
      if ($mode -eq 'http-only') { & $fixture -HttpOnly }
      elseif ($mode -eq 'missing-config') { & $fixture -HttpsConfig (Join-Path $root 'missing.json') }
      else {
        function node { $global:LASTEXITCODE = 1 }
        & $fixture -HttpsConfig $config
      }
    } catch { $rejected = $true }
    if (!$rejected -or $launcherStarted.Count -ne 0) { throw "$mode must fail without launching services." }
  }
  Write-Output 'Launcher checks passed'
} finally {
  Remove-Item -LiteralPath $fixture, $config -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -ErrorAction SilentlyContinue
}
