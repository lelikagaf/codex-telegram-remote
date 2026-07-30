$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
Set-Location -LiteralPath $projectDir

while ($true) {
    & $node (Join-Path $projectDir 'src\index.js')
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0 -or $exitCode -eq 78) {
        exit $exitCode
    }
    Start-Sleep -Seconds 5
}
