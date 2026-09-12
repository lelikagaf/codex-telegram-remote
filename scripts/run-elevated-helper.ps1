param(
    [Parameter(Mandatory = $true)]
    [string]$SpoolPath,
    [int]$MaxRuntimeSeconds = 600
)

$ErrorActionPreference = 'Stop'
$approvedPath = Join-Path $SpoolPath 'approved'
$requestsPath = Join-Path $SpoolPath 'requests'
$resultsPath = Join-Path $SpoolPath 'results'
$utf8 = New-Object System.Text.UTF8Encoding($false)

foreach ($directory in @($approvedPath, $requestsPath, $resultsPath)) {
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
}

function Write-JsonAtomic {
    param([string]$Path, [object]$Value)

    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $json = $Value | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($temporary, "$json`n", $utf8)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-RequestDigest {
    param([object]$Request)

    $source = @(
        [string]$Request.id,
        [string]$Request.threadId,
        [string]$Request.cwd,
        [string]$Request.command,
        [string]$Request.reason,
        [string]$Request.createdAt,
        [string]$Request.expiresAt,
        [string]$Request.maxRuntimeSeconds
    ) -join "`n"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($source)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Limit-Text {
    param([string]$Text, [int]$Limit = 200000)
    if ($null -eq $Text) { return '' }
    if ($Text.Length -le $Limit) { return $Text }
    return $Text.Substring(0, $Limit) + "`n...[output truncated by elevated helper]"
}

function Normalize-ErrorText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    if ($Text.StartsWith('#< CLIXML') -and $Text -notmatch 'S="Error"') { return '' }
    return $Text
}

function Complete-Job {
    param([string]$Id, [hashtable]$Result)

    $Result.id = $Id
    $Result.completedAt = [DateTime]::UtcNow.ToString('o')
    Write-JsonAtomic -Path (Join-Path $resultsPath "$Id.json") -Value $Result
    Remove-Item -LiteralPath (Join-Path $approvedPath "$Id.json") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $requestsPath "$Id.json") -Force -ErrorAction SilentlyContinue
}

function Invoke-ElevatedJob {
    param([System.IO.FileInfo]$File)

    $id = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
    try {
        if ($id -notmatch '^[a-f0-9]{32}$') { throw 'Invalid request ID.' }
        $job = Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$job.id -ne $id) { throw 'The file ID does not match the request ID.' }
        if ([string]$job.digest -ne (Get-RequestDigest -Request $job)) {
            throw 'The elevated command digest does not match.'
        }
        if ([DateTime]::Parse([string]$job.expiresAt).ToUniversalTime() -le [DateTime]::UtcNow) {
            Complete-Job -Id $id -Result @{ status = 'expired'; message = 'The approval request expired.' }
            return
        }
        if (-not [System.IO.Path]::IsPathRooted([string]$job.cwd)) {
            throw 'The working directory must be absolute.'
        }
        if (-not (Test-Path -LiteralPath ([string]$job.cwd) -PathType Container)) {
            throw "The working directory does not exist: $($job.cwd)"
        }

$command = @"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(`$false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding(`$false)
`$ProgressPreference = 'SilentlyContinue'
$($job.command)
"@
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $powershell
        $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand $encoded"
        $startInfo.WorkingDirectory = [string]$job.cwd
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = $utf8
        $startInfo.StandardErrorEncoding = $utf8

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'Failed to start the elevated command.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $jobRuntimeSeconds = [Math]::Max(30, [int]$job.maxRuntimeSeconds)
        $runtimeSeconds = [Math]::Min([Math]::Max(30, $MaxRuntimeSeconds), $jobRuntimeSeconds)
        $timedOut = -not $process.WaitForExit($runtimeSeconds * 1000)
        if ($timedOut) {
            try { $process.Kill() } catch {}
            $process.WaitForExit()
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = Normalize-ErrorText -Text ($stderrTask.GetAwaiter().GetResult())
        $exitCode = if ($timedOut) { -1 } else { $process.ExitCode }
        $process.Dispose()

        Complete-Job -Id $id -Result @{
            status = 'completed'
            exitCode = $exitCode
            stdout = Limit-Text -Text $stdout
            stderr = Limit-Text -Text $stderr
            timedOut = $timedOut
        }
    }
    catch {
        Complete-Job -Id $id -Result @{
            status = 'failed'
            message = $_.Exception.Message
        }
    }
}

$quietDeadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    $jobs = @(Get-ChildItem -LiteralPath $approvedPath -Filter '*.json' -File -ErrorAction SilentlyContinue)
    if ($jobs.Count -gt 0) {
        foreach ($jobFile in $jobs) { Invoke-ElevatedJob -File $jobFile }
        $quietDeadline = [DateTime]::UtcNow.AddSeconds(5)
    }
    else {
        Start-Sleep -Milliseconds 250
    }
} while ([DateTime]::UtcNow -lt $quietDeadline)
