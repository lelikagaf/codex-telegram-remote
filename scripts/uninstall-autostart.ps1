$ErrorActionPreference = 'Stop'
$taskName = 'Codex Telegram Remote'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Автозапуск удалён: $taskName"
