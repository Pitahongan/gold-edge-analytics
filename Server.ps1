# ===================================================================
# Gold Edge Analytics - Serveur local
# ===================================================================
# Ce script fait 2 choses en meme temps :
#   1. Il sert les fichiers du dashboard (index.html, app.js, etc.)
#      sur http://localhost:8934/
#   2. Il ecoute les demandes du bouton "Actualiser" du navigateur
#      (POST /refresh) et relance alors le script Update-Data.ps1
#      pour aller chercher de vraies nouvelles donnees.
#
# Laissez cette fenetre ouverte pendant que vous utilisez le dashboard.
# Fermez-la (ou Ctrl+C) pour arreter le serveur.
# ===================================================================

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$port = 8934
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host ""
    Write-Host "[ERREUR] Impossible de demarrer le serveur sur le port $port." -ForegroundColor Red
    Write-Host "Le port est peut-etre deja utilise par une autre instance de ce serveur." -ForegroundColor Red
    Write-Host ""
    Write-Host "Detail : $_"
    Write-Host ""
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

Write-Host "==================================================="
Write-Host "   GOLD EDGE ANALYTICS - Serveur local actif"
Write-Host "==================================================="
Write-Host ""
Write-Host "Dashboard disponible sur : $prefix" -ForegroundColor Green
Write-Host ""
Write-Host "Laissez cette fenetre ouverte. Le bouton 'Actualiser'" 
Write-Host "du dashboard passera par ce serveur pour recuperer de"
Write-Host "vraies nouvelles donnees. Fermez cette fenetre (ou Ctrl+C)"
Write-Host "pour tout arreter."
Write-Host ""

# Ouvre automatiquement le dashboard dans Chrome, profil "Pierre VIDE"
# (Profile 6, videgnonp@gmail.com) -- meme convention que BTC_Edge_Monitor_Chrome,
# pour garder les dashboards de trading regroupes dans ce profil dedie.
# Fallback sur le navigateur par defaut si Chrome n'est pas trouve a cet
# emplacement standard (ex: installe ailleurs, ou machine differente).
$chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (Test-Path $chromePath) {
    Start-Process -FilePath $chromePath -ArgumentList "--profile-directory=`"Profile 6`"", ($prefix + "index.html")
} else {
    Start-Process ($prefix + "index.html")
}

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".svg"  = "image/svg+xml"
}

while ($listener.IsListening) {
    $context = $null
    try {
        $context = $listener.GetContext()
    } catch {
        # Le listener a ete ferme (Ctrl+C) : on sort proprement
        break
    }

    $request = $context.Request
    $response = $context.Response

    try {
        if ($request.HttpMethod -eq "POST" -and $request.Url.AbsolutePath -eq "/refresh") {

            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Rafraichissement demande depuis le navigateur..." -ForegroundColor Cyan

            $updateScript = Join-Path $scriptDir "Update-Data.ps1"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateScript
            $exitCode = $LASTEXITCODE

            if ($exitCode -eq 0) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Rafraichissement termine avec succes." -ForegroundColor Green
                $response.StatusCode = 200
                $bodyText = '{"status":"ok"}'
            } else {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Le rafraichissement a echoue (code $exitCode)." -ForegroundColor Yellow
                $response.StatusCode = 500
                $bodyText = '{"status":"error"}'
            }

            $response.ContentType = "application/json; charset=utf-8"
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($bodyText)
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        else {
            # Servir un fichier statique depuis le dossier de l'application
            $relPath = $request.Url.AbsolutePath.TrimStart("/")
            if ([string]::IsNullOrWhiteSpace($relPath)) { $relPath = "index.html" }

            # Empeche de sortir du dossier de l'app (securite basique)
            $relPath = $relPath -replace "\.\.", ""
            $filePath = Join-Path $scriptDir $relPath

            if (Test-Path $filePath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($filePath)
                $contentType = $mimeTypes[$ext]
                if (-not $contentType) { $contentType = "application/octet-stream" }

                # data.js ne doit JAMAIS etre mis en cache par le navigateur :
                # c'est le fichier qui contient les donnees de marche, il change
                # a chaque clic sur "Actualiser". Sans ça, le navigateur peut
                # reservir une vieille version depuis son cache apres reload.
                if ($relPath -eq "data.js") {
                    $response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
                    $response.Headers.Add("Pragma", "no-cache")
                    $response.Headers.Add("Expires", "0")
                }

                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $response.ContentType = $contentType
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $response.StatusCode = 404
                $notFoundBytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $relPath")
                $response.ContentLength64 = $notFoundBytes.Length
                $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
            }
        }
    } catch {
        Write-Host "[ERREUR] $_" -ForegroundColor Red
        try { $response.StatusCode = 500 } catch {}
    } finally {
        $response.OutputStream.Close()
    }
}

$listener.Stop()
$listener.Close()
