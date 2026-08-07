# ===================================================================
# Install-Startup.ps1
# ===================================================================
# Installe une tache planifiee Windows qui, a chaque OUVERTURE DE SESSION
# (allumage du PC / connexion Windows), lance automatiquement :
#   1. Update-Data.ps1 (une passe immediate : donnees fraiches + verdict
#      recalcule + notif Telegram/Windows si un edge est deja actif au
#      demarrage, sans attendre jusqu'a 15 min le prochain cycle
#      GoldEdge-AutoRefresh).
#   2. Server.ps1, qui reste ouvert en arriere-plan (fenetre cachee) pour
#      servir le dashboard sur http://localhost:8934/ des que tu veux
#      l'ouvrir, sans avoir a double-cliquer sur Lancer-Gold-Edge.bat.
#
# Complementaire a GoldEdge-AutoRefresh (Install-AutoRefresh.ps1), qui
# gere le rafraichissement recurrent toutes les 15 min. Installe les DEUX
# pour un systeme qui tourne seul du demarrage du PC jusqu'a l'extinction.
#
# A FAIRE : clic droit sur ce fichier -> "Executer avec PowerShell"
#           (de preference en tant qu'Administrateur).
# ===================================================================

$ErrorActionPreference = "Stop"

$taskName     = "GoldEdge-Startup"
$scriptDir    = $PSScriptRoot
$updateScript = Join-Path $scriptDir "Update-Data.ps1"
$serverScript = Join-Path $scriptDir "Server.ps1"

if (-not (Test-Path $updateScript) -or -not (Test-Path $serverScript)) {
    Write-Host ""
    Write-Host "[ERREUR] Update-Data.ps1 ou Server.ps1 introuvable a cote de ce script." -ForegroundColor Red
    Write-Host "Place Install-Startup.ps1 DANS le dossier gold_edge_analytics_corrige." -ForegroundColor Red
    Write-Host ""
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

Write-Host "==================================================="
Write-Host "  Gold Edge Analytics - Installation Demarrage Auto"
Write-Host "==================================================="
Write-Host ""
Write-Host "Dossier detecte : $scriptDir" -ForegroundColor Cyan
Write-Host "Declencheur     : a chaque ouverture de session Windows" -ForegroundColor Cyan
Write-Host ""

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Une tache '$taskName' existe deja -> suppression avant reinstallation..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Action : lance Update-Data.ps1 (une passe), PUIS Server.ps1 (qui reste
# actif indefiniment -> pas de limite de temps d'execution sur cette tache,
# contrairement a GoldEdge-AutoRefresh qui est ponctuelle toutes les 15 min).
$logFile = Join-Path $scriptDir "auto_refresh_log.txt"
$command = "& '$updateScript' *>> '$logFile'; & '$serverScript' *>> '$logFile'"
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`"" `
    -WorkingDirectory $scriptDir

# Declencheur : a l'ouverture de session de l'utilisateur courant. Delai de
# 30s pour laisser le reseau/Wi-Fi se stabiliser avant le premier fetch
# Yahoo/FRED (evite un echec systematique juste apres le boot).
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "Gold Edge Analytics : lance une mise a jour des donnees puis le serveur du dashboard a chaque ouverture de session Windows." `
        | Out-Null
} catch {
    Write-Host ""
    Write-Host "[ERREUR] La creation de la tache a echoue : $_" -ForegroundColor Red
    Write-Host "Relance ce script en tant qu'Administrateur." -ForegroundColor Red
    Write-Host ""
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

Start-Sleep -Milliseconds 500
$verify = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $verify) {
    Write-Host ""
    Write-Host "[ERREUR] La tache ne semble pas avoir ete creee (verification echouee)." -ForegroundColor Red
    Write-Host "Relance ce script en tant qu'Administrateur." -ForegroundColor Red
    Write-Host ""
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

Write-Host ""
Write-Host "[OK] Tache '$taskName' installee avec succes !" -ForegroundColor Green
Write-Host ""
Write-Host "A partir du prochain demarrage / de la prochaine connexion Windows :" -ForegroundColor White
Write-Host "  - Le systeme se lance seul (donnees + serveur dashboard), sans double-clic." -ForegroundColor White
Write-Host "  - Le dashboard est immediatement accessible sur http://localhost:8934/" -ForegroundColor White
Write-Host "  - Les alertes Telegram ET les notifications Windows fonctionnent des le demarrage." -ForegroundColor White
Write-Host ""
Write-Host "Pense a installer AUSSI Install-AutoRefresh.ps1 si ce n'est pas deja fait" -ForegroundColor Yellow
Write-Host "(rafraichissement recurrent toutes les 15 min, complementaire a cette tache)." -ForegroundColor Yellow
Write-Host ""
Write-Host "Pour desinstaller : lance Uninstall-Startup.ps1" -ForegroundColor Gray
Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
