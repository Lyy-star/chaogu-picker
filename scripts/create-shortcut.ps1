# Create a desktop shortcut (Chinese name) pointing to start.bat.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads
# BOM-less .ps1 files with the ANSI code page, which would mangle any literal
# Chinese text (and can even swallow the following "." of ".lnk").
# So the Chinese name is assembled from Unicode code points instead.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1

$ErrorActionPreference = 'Stop'

function ConvertFrom-CodePoints {
    param([int[]] $CodePoints)
    -join ($CodePoints | ForEach-Object { [char] $_ })
}

# l y y U+521B U+610F U+9009 U+80A1  ->  lyy创意选股
$appName = ConvertFrom-CodePoints @(0x6C, 0x79, 0x79, 0x521B, 0x610F, 0x9009, 0x80A1)
# lyy创意选股 + " - A" + U+80A1 + U+4E3B U+677F U+9009 U+80A1 U+5DE5 U+5177
$description = (ConvertFrom-CodePoints @(0x6C, 0x79, 0x79, 0x521B, 0x610F, 0x9009, 0x80A1)) +
    ' - A' + (ConvertFrom-CodePoints @(0x80A1)) +
    (ConvertFrom-CodePoints @(0x4E3B, 0x677F, 0x9009, 0x80A1, 0x5DE5, 0x5177))

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'start.bat'
if (-not (Test-Path -LiteralPath $target)) {
    throw "start.bat not found: $target"
}

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
if (-not (Test-Path -LiteralPath $desktop)) {
    throw "Desktop folder not found: $desktop"
}

$lnk = Join-Path $desktop ($appName + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = $description
$shortcut.WindowStyle = 7   # start minimized, so the console window does not flash

$icon = Join-Path $root 'assets\chaogu.ico'
if (Test-Path -LiteralPath $icon) {
    $shortcut.IconLocation = "$icon,0"
} else {
    $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (Test-Path -LiteralPath $electron) { $shortcut.IconLocation = "$electron,0" }
}

$shortcut.Save()
Write-Host "Desktop shortcut created: $lnk"
Write-Host "Target: $target"
