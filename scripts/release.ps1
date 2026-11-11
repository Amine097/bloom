# Publishes an update:  scripts/release.ps1 0.2.0 "What changed, in words she will read"
# Bumps the version everywhere, writes the notes shown in the app, commits, tags and pushes.
# GitHub Actions then builds the release; installed copies offer it at their next launch.
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory)][string]$Notes
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (git status --porcelain) { throw "Commit or discard your changes first." }
if (git tag --list "v$Version") { throw "v$Version already exists." }
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed; nothing was released." }

function Set-Version($path, $pattern, $replacement) {
    $text = [IO.File]::ReadAllText($path)
    $new = [regex]::new($pattern, 'Multiline').Replace($text, $replacement, 1)
    if ($new -eq $text) { throw "Could not set the version in $path" }
    [IO.File]::WriteAllText($path, $new)
}
Set-Version "$root\package.json"              '"version": "[^"]+"' "`"version`": `"$Version`""
Set-Version "$root\src-tauri\tauri.conf.json" '"version": "[^"]+"' "`"version`": `"$Version`""
Set-Version "$root\src-tauri\Cargo.toml"      '^version = "[^"]+"'  "version = `"$Version`""
[IO.File]::WriteAllText("$root\release-notes.md", $Notes.Trim() + "`n")

git add -A
git commit -m "Release $Version"
git tag "v$Version"
git push origin main "v$Version"
Write-Host "Released v$Version. Build: https://github.com/Amine097/bloom/actions"
