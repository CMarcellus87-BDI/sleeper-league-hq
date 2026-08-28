# One-time local setup. Safe to re-run: it never overwrites existing config.
$ErrorActionPreference = 'Stop'

function Copy-IfMissing($from, $to) {
  if (Test-Path $to) {
    Write-Host "kept    $to (already exists)" -ForegroundColor DarkGray
  } else {
    Copy-Item $from $to
    Write-Host "created $to" -ForegroundColor Green
  }
}

Copy-IfMissing 'config.local.example.js' 'config.local.js'
Copy-IfMissing 'wrangler.example.toml' 'wrangler.toml'

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Edit config.local.js  - set proxyBase to your deployed worker URL'
Write-Host '  2. Edit wrangler.toml    - set ALLOWED_ORIGINS to your site origin'
Write-Host '  3. npx wrangler secret put FANTASYPROS_API_KEY'
Write-Host '  4. npx wrangler deploy'
Write-Host ''
Write-Host 'Both files are gitignored and excluded from release archives,' -ForegroundColor DarkGray
Write-Host 'so upgrades will not overwrite them.' -ForegroundColor DarkGray
