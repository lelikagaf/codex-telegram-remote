param(
    [string]$TaskName = 'Codex Telegram Elevated Helper'
)

$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Elevated helper removed: $TaskName"
