param(
  [string]$PrivateDirectory = "C:\TournamentPrivate",
  [string]$Hostname = "tourn-svr.home.arpa",
  [string]$IpAddress = "192.168.4.42",
  [string]$OpenSslPath = "C:\Program Files\Git\usr\bin\openssl.exe"
)

$ErrorActionPreference = "Stop"
if (!(Test-Path -LiteralPath $OpenSslPath -PathType Leaf)) { throw "OpenSSL not found: $OpenSslPath" }
if (![System.IO.Path]::IsPathRooted($PrivateDirectory)) { throw "PrivateDirectory must be absolute." }
if ($Hostname -notmatch '^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$') { throw "Invalid DNS hostname." }
$parsedIp = $null
if (![System.Net.IPAddress]::TryParse($IpAddress, [ref]$parsedIp) -or
    $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw "Invalid IPv4 address." }
$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\')
$privateRoot = [System.IO.Path]::GetFullPath($PrivateDirectory).TrimEnd('\')
if ($privateRoot -eq $repoRoot -or $privateRoot.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Private storage must be outside the web-served repository."
}
if (Test-Path -LiteralPath $privateRoot) {
  throw "PrivateDirectory already exists. Refusing to overwrite keys or change existing directory permissions. Use a new directory or inspect the existing installation."
}

function Invoke-OpenSsl {
  param([string[]]$Arguments)
  & $OpenSslPath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed (exit $LASTEXITCODE). No trust was installed. Inspect $privateRoot before retrying." }
}

New-Item -ItemType Directory -Path $privateRoot | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($identity.User)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity.User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
    (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $privateRoot -AclObject $acl
$caDirectory = Join-Path $privateRoot "root-ca"
$tlsDirectory = Join-Path $privateRoot "https"
New-Item -ItemType Directory -Path $caDirectory, $tlsDirectory | Out-Null
$caKey = Join-Path $caDirectory "root-ca-key.pem"
$caCert = Join-Path $caDirectory "root-ca.pem"
$serverKey = Join-Path $tlsDirectory "server-key.pem"
$serverCert = Join-Path $tlsDirectory "server.pem"
$csr = Join-Path $tlsDirectory "server.csr"
$serial = Join-Path $caDirectory "root-ca.srl"

Invoke-OpenSsl -Arguments @('req', '-x509', '-newkey', 'rsa:4096', '-nodes', '-sha256', '-days', '3650',
  '-subj', '/CN=Tournament Local Root CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', $caKey, '-out', $caCert)
Invoke-OpenSsl -Arguments @('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
  '-subj', "/CN=$Hostname", '-addext', "subjectAltName=DNS:$Hostname,IP:$IpAddress",
  '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
  '-addext', 'extendedKeyUsage=serverAuth', '-keyout', $serverKey, '-out', $csr)
Invoke-OpenSsl -Arguments @('x509', '-req', '-in', $csr, '-CA', $caCert, '-CAkey', $caKey,
  '-CAserial', $serial, '-CAcreateserial', '-days', '397', '-sha256', '-copy_extensions', 'copy', '-out', $serverCert)
Invoke-OpenSsl -Arguments @('verify', '-CAfile', $caCert, '-verify_hostname', $Hostname, $serverCert)
Invoke-OpenSsl -Arguments @('verify', '-CAfile', $caCert, '-verify_ip', $IpAddress, $serverCert)
Remove-Item -LiteralPath $csr
Copy-Item -LiteralPath $caCert -Destination (Join-Path $tlsDirectory "root-ca.pem")
$configFile = Join-Path $tlsDirectory "server.json"
@{
  hostname = $Hostname
  ipAddress = $IpAddress
  keyFile = $serverKey
  certFile = $serverCert
  caFile = (Join-Path $tlsDirectory "root-ca.pem")
  accountDatabase = (Join-Path $privateRoot "accounts.db")
  sourceLimit = @{ maxAttempts = 50; windowMs = 900000 }
} | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding ASCII
Write-Host "Certificates created and verified. NO trust store was changed."
Write-Host "Configuration: $configFile"
Write-Host "Distribute ONLY the public CA certificate: $(Join-Path $tlsDirectory 'root-ca.pem')"
Write-Host "Keep the Root CA private key protected and back it up securely/offline. Never distribute private keys."
Write-Host "Create the first administrator interactively before using the account UI."
