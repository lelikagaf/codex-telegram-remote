param(
    [string]$SpoolPath = (Join-Path $env:LOCALAPPDATA 'CodexTelegramRemote\elevation'),
    [string]$TaskName = 'Codex Telegram Elevated Helper',
    [int]$MaxRuntimeSeconds = 600,
    [switch]$NoSelfElevate
)

$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principalCheck.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
    if ($NoSelfElevate) { throw 'Run this installer as Administrator.' }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"",
        '-SpoolPath', "`"$SpoolPath`"",
        '-TaskName', "`"$TaskName`"",
        '-MaxRuntimeSeconds', [string]$MaxRuntimeSeconds,
        '-NoSelfElevate'
    )
    $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

$helper = Join-Path $PSScriptRoot 'run-elevated-helper.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Elevated helper not found: $helper"
}

[System.IO.Directory]::CreateDirectory($SpoolPath) | Out-Null
foreach ($name in @('requests', 'approved', 'results')) {
    [System.IO.Directory]::CreateDirectory((Join-Path $SpoolPath $name)) | Out-Null
}

$currentUser = $identity.Name
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $SpoolPath /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to secure the elevation spool directory: $SpoolPath" }

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$actionArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$helper`" -SpoolPath `"$SpoolPath`" -MaxRuntimeSeconds $MaxRuntimeSeconds"
$action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArguments
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Principal $taskPrincipal `
    -Settings $settings `
    -Description 'Executes Telegram-approved Codex commands with Windows administrator privileges' `
    -Force | Out-Null

Write-Host "Elevated helper installed: $TaskName"
Write-Host "Spool: $SpoolPath"
