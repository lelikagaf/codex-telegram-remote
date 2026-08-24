$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDir '.env'
$installAutostart = Join-Path $PSScriptRoot 'install-autostart.ps1'
$taskName = 'Codex Telegram Remote'

function Read-PlainTextSecret {
    param([string]$Prompt)

    $secureValue = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Invoke-TelegramApi {
    param(
        [string]$Method,
        [hashtable]$Payload = @{}
    )

    try {
        $body = $Payload | ConvertTo-Json -Depth 8 -Compress
        $response = Invoke-RestMethod `
            -Method Post `
            -Uri "$script:telegramBaseUrl/$Method" `
            -ContentType 'application/json; charset=utf-8' `
            -Body $body `
            -TimeoutSec 30

        if (-not $response.ok) {
            throw 'Telegram returned an unsuccessful response.'
        }
        return $response.result
    }
    catch {
        throw "Telegram API request '$Method' failed. Check the token and Internet connection."
    }
}

function New-ClaimCode {
    $bytes = New-Object byte[] 4
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return 100000 + ([BitConverter]::ToUInt32($bytes, 0) % 900000)
}

Write-Host ''
Write-Host 'Secure owner setup for a Telegram bot'
Write-Host '1. Create a bot in @BotFather or request a fresh token with /token.'
Write-Host '2. Paste the token below. It will not be echoed.'
Write-Host ''

$token = (Read-PlainTextSecret 'New Telegram bot token').Trim()
if ($token -notmatch '^\d+:[A-Za-z0-9_-]{30,}$') {
    throw 'The token format is invalid. Nothing was saved.'
}

$script:telegramBaseUrl = "https://api.telegram.org/bot$token"
$botInfo = Invoke-TelegramApi -Method 'getMe'
$botUsername = [string]$botInfo.username
if ([string]::IsNullOrWhiteSpace($botUsername)) {
    throw 'Telegram did not return the bot username. Nothing was saved.'
}

# Remove any webhook and discard messages sent before this secure setup.
Invoke-TelegramApi -Method 'deleteWebhook' -Payload @{ drop_pending_updates = $true } | Out-Null

$claimCode = New-ClaimCode
$claimCommand = "/claim $claimCode"
$deadline = [DateTime]::UtcNow.AddMinutes(5)
$offset = 0
$ownerMessage = $null

Write-Host ''
Write-Host "Open Telegram and send this exact message to @${botUsername}:"
Write-Host ''
Write-Host "    $claimCommand" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Waiting up to 5 minutes...'

while ([DateTime]::UtcNow -lt $deadline -and $null -eq $ownerMessage) {
    $updates = Invoke-TelegramApi -Method 'getUpdates' -Payload @{
        offset = $offset
        timeout = 20
        allowed_updates = @('message')
    }

    foreach ($update in @($updates)) {
        $offset = [int64]$update.update_id + 1
        $message = $update.message
        if (
            $message.chat.type -eq 'private' -and
            $message.text -ceq $claimCommand -and
            $null -ne $message.from.id
        ) {
            $ownerMessage = $message
            break
        }
    }
}

if ($null -eq $ownerMessage) {
    throw 'Timed out waiting for the claim command. Nothing was saved.'
}

$ownerId = [int64]$ownerMessage.from.id
$defaultCwd = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Codex'
$envText = @"
TELEGRAM_BOT_TOKEN=$token
TELEGRAM_ALLOWED_USER_ID=$ownerId
CODEX_DEFAULT_CWD=$defaultCwd
CODEX_BINARY=
CODEX_APPROVAL_POLICY=never
CODEX_FULL_ACCESS=false
TELEGRAM_NOTIFY_ON_START=true
TELEGRAM_NOTIFY_AFTER_SLEEP=false
TELEGRAM_MAX_FILE_SIZE_MB=0
RESUME_NOTIFICATION_GAP_SECONDS=120
DESKTOP_SYNC_POLL_SECONDS=3
CODEX_WRITER_IDLE_SECONDS=90
LOG_LEVEL=info
"@

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envPath, $envText, $utf8WithoutBom)

# Restrict the plaintext token file to the current Windows account.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity.User,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($accessRule)
    Set-Acl -LiteralPath $envPath -AclObject $acl
}
catch {
    # Some Windows PowerShell installations cannot autoload
    # Microsoft.PowerShell.Security. icacls is available on supported Windows
    # versions and accepts the current account SID without localized names.
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $envPath '/inheritance:r' '/grant:r' "*$($identity.User.Value):(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to restrict access to .env with Set-Acl and icacls.'
    }
}

Invoke-TelegramApi -Method 'sendMessage' -Payload @{
    chat_id = $ownerMessage.chat.id
    text = "Owner confirmed. Telegram user ID: $ownerId. Starting the Codex bot..."
} | Out-Null

& $installAutostart
Start-ScheduledTask -TaskName $taskName

$displayName = (@($ownerMessage.from.first_name, $ownerMessage.from.last_name) |
    Where-Object { $_ }) -join ' '

Write-Host ''
Write-Host "Owner configured: $displayName (Telegram ID $ownerId)" -ForegroundColor Green
Write-Host 'Autostart is installed and the bot is starting.'
Write-Host 'Return to Telegram and send /start or /chats.'
Write-Host ''
Write-Host 'You may close this window.'
