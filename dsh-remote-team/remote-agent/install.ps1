<#
.SYNOPSIS
Install dsh-remote-agent behind the plugin wss-proxy on a Windows machine.

.DESCRIPTION
Generates a self-signed CA (once), a per-machine server certificate, a random
token, two launcher scripts, firewall rule, file ACLs and two at-startup
scheduled tasks. Run in an elevated PowerShell on the REMOTE machine.
All output is ASCII on purpose: Windows PowerShell 5.1 is the baseline.

.EXAMPLE
.\install.ps1 -MachineId dev-win -ControlHost 192.168.1.10
.EXAMPLE
.\install.ps1 -MachineId dev-win -DryRun
#>
param(
  [Parameter(Mandatory = $true)][string]$MachineId,
  [string]$InstallDir = "$env:LOCALAPPDATA\dsh-remote-team",
  [string]$CaDir = "$env:LOCALAPPDATA\dsh-remote-team\ca",
  [int]$ListenPort = 8787,
  [int]$AgentPort = 8788,
  [string]$Allow = 'pi,node',
  [string]$ControlHost = 'Any',
  [string]$AgentCommand = 'dsh-remote-agent',
  [string]$NodeCommand = 'node',
  [switch]$RotateCert,
  [switch]$SkipWsInstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param([string]$Message) Write-Host "[dsh-remote-team] $Message" }
function Write-Plan { param([string]$Message) Write-Host "  DRYRUN: $Message" }

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
  throw 'Run this script in an elevated PowerShell (scheduled tasks and firewall rules need admin). Use -DryRun to preview.'
}

# Locate openssl. Git for Windows ships a usable build.
$openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $openssl) {
  $candidates = @(
    "$env:ProgramFiles\Git\usr\bin\openssl.exe",
    "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
    "C:\Program Files\Git\usr\bin\openssl.exe"
  )
  $gitExe = (Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($gitExe) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitExe)
    $candidates += (Join-Path $gitRoot 'usr\bin\openssl.exe')
  }
  foreach ($candidate in $candidates) { if ($candidate -and (Test-Path $candidate)) { $openssl = $candidate; break } }
}
if (-not $openssl) { throw 'openssl.exe not found. Install Git for Windows, or put openssl on PATH.' }

$caKey = Join-Path $CaDir 'ca.key'
$caPem = Join-Path $CaDir 'ca.pem'
$certDir = Join-Path $InstallDir $MachineId
$srvKey = Join-Path $certDir 'server.key'
$srvPem = Join-Path $certDir 'server.pem'
$srvCsr = Join-Path $certDir 'server.csr'
$sanFile = Join-Path $certDir 'san.cnf'
$tokenFile = Join-Path $certDir 'agent-token.txt'
$agentLauncher = Join-Path $certDir 'start-remote-agent.cmd'
$proxyLauncher = Join-Path $certDir 'start-wss-proxy.cmd'
$proxyScript = Join-Path $certDir 'wss-proxy.js'

$localIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
  Select-Object -First 1).IPAddress
if (-not $localIp) { $localIp = '127.0.0.1' }

if ($DryRun) {
  Write-Plan "openssl: $openssl"
  Write-Plan "CA: $caPem (reuse if exists)"
  Write-Plan "cert dir: $certDir"
  Write-Plan "SAN: DNS=$MachineId, IP=$localIp"
  Write-Plan "agent: $AgentCommand --host 127.0.0.1 --port $AgentPort --allow $Allow"
  Write-Plan "proxy: $NodeCommand wss-proxy.js --port $ListenPort --target ws://127.0.0.1:$AgentPort"
  Write-Plan "firewall: TCP $ListenPort from $ControlHost"
  Write-Plan 'scheduled tasks: dsh-remote-agent-* and dsh-remote-wss-proxy-* (at startup, S4U)'
  return
}

New-Item -ItemType Directory -Force -Path $InstallDir, $CaDir, $certDir | Out-Null

# 1) CA, created once and reused for every machine in this deployment.
if (-not (Test-Path $caPem)) {
  Write-Step 'Generating self-signed CA (keep ca.key offline after installation)'
  & $openssl req -x509 -newkey rsa:2048 -nodes -keyout $caKey -out $caPem -days 3650 `
    -subj '/CN=dsh-remote-team CA' -addext 'basicConstraints=critical,CA:TRUE' 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'openssl CA generation failed' }
} else {
  Write-Step "Reusing existing CA: $caPem"
}

# 2) Per-machine server certificate with SAN containing its name and LAN IP.
if ($RotateCert -or -not (Test-Path $srvPem)) {
  Write-Step "Generating server certificate for $MachineId (SAN: $MachineId, $localIp)"
  $san = @(
    '[v3_req]',
    'subjectAltName=@alt',
    '[alt]',
    "DNS.1=$MachineId",
    "DNS.2=$MachineId.local",
    "IP.1=$localIp"
  ) -join "`n"
  Set-Content -Path $sanFile -Value $san -Encoding ascii
  & $openssl req -newkey rsa:2048 -nodes -keyout $srvKey -out $srvCsr -subj "/CN=$MachineId" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'openssl CSR generation failed' }
  & $openssl x509 -req -in $srvCsr -CA $caPem -CAkey $caKey -CAcreateserial `
    -out $srvPem -days 825 -extfile $sanFile -extensions v3_req 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'openssl certificate signing failed' }
}

# 3) Random token, stored in a file with a narrow ACL (never in cordis.yml).
if (-not (Test-Path $tokenFile)) {
  Write-Step 'Generating remote-agent token'
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $token = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '')
  Set-Content -Path $tokenFile -Value $token -Encoding ascii -NoNewline
} else {
  Write-Step "Reusing existing token: $tokenFile"
}
& icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
& icacls $srvKey /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
& icacls $caKey /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null

# 4) Launchers. The token is read at runtime, not embedded in a command line.
Copy-Item -Path (Join-Path $PluginDir 'wss-proxy.js') -Destination $proxyScript -Force
$agentCmd = @(
  '@echo off',
  "for /f `"delims=`" %%t in ('type `"%~dp0agent-token.txt`"') do set DSH_TOKEN=%%t",
  "`"$AgentCommand`" --host 127.0.0.1 --port $AgentPort --token %DSH_TOKEN% --allow $Allow"
) -join "`r`n"
Set-Content -Path $agentLauncher -Value $agentCmd -Encoding ascii
$proxyCmd = @(
  '@echo off',
  "cd /d `"%~dp0`"",
  "`"$NodeCommand`" `"%~dp0wss-proxy.js`" --host 0.0.0.0 --port $ListenPort --cert `"%~dp0server.pem`" --key `"%~dp0server.key`" --target ws://127.0.0.1:$AgentPort"
) -join "`r`n"
Set-Content -Path $proxyLauncher -Value $proxyCmd -Encoding ascii

if (-not $SkipWsInstall -and -not (Test-Path (Join-Path $certDir 'node_modules\ws'))) {
  Write-Step 'Installing ws@8 next to wss-proxy.js'
  & npm install ws@8 --prefix $certDir --no-audit --no-fund --no-save 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning 'npm install ws failed; install it manually in the cert directory' }
}

# 5) Firewall: expose only the TLS port, optionally restricted to the control host.
$ruleName = "dsh-remote-team wss $ListenPort"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Step "Adding firewall rule for TCP/$ListenPort"
  $fwArgs = @{
    DisplayName = $ruleName
    Direction = 'Inbound'
    Protocol = 'TCP'
    LocalPort = $ListenPort
    Action = 'Allow'
    Profile = 'Private,Domain'
  }
  if ($ControlHost -ne 'Any') { $fwArgs['RemoteAddress'] = $ControlHost }
  New-NetFirewallRule @fwArgs | Out-Null
}

# 6) At-startup scheduled tasks (S4U needs no stored password).
function Register-Launcher {
  param([string]$TaskName, [string]$ScriptPath)
  try {
    $action = New-ScheduledTaskAction -Execute $ScriptPath
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Step "Registered scheduled task: $TaskName"
  } catch {
    Write-Warning "Could not register $TaskName automatically: $($_.Exception.Message)"
    Write-Host "  Manual: schtasks /Create /TN `"$TaskName`" /TR `"$ScriptPath`" /SC ONSTART /F"
  }
}
Register-Launcher -TaskName "dsh-remote-agent-$MachineId" -ScriptPath $agentLauncher
Register-Launcher -TaskName "dsh-remote-wss-proxy-$MachineId" -ScriptPath $proxyLauncher

Write-Step 'DONE. On the CONTROL host, before starting dsh, set:'
Write-Host "  `$env:NODE_EXTRA_CA_CERTS = `"$caPem`""
Write-Host "  `$env:REMOTE_AGENT_TOKEN_<ID> = (content of $tokenFile)"
Write-Host "  cordis.patch.yml url: wss://$MachineId`:$ListenPort  (or wss://$localIp`:$ListenPort)"
Write-Step 'The remote-agent itself stays bound to 127.0.0.1 and only the TLS port is exposed.'
