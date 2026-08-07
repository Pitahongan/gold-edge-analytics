# ===================================================================
# Install-AutoRefresh.ps1
# ===================================================================
# Installe une tache planifiee Windows qui execute Update-Data.ps1
# automatiquement toutes les 15 minutes, 24h/24, MEME SI le navigateur
# et le dashboard sont fermes.
#
# Effet concret :
#   - Les donnees (data.js) se rafraichissent seules en arriere-plan.
#   - Si un edge fort NOUVEAU apparait, Telegram-Notify.ps1 t'envoie
#     une notif sur ton telephone (logique deja geree par notify_state.json,
#     inchangee).
#   - Tu n'as plus besoin de cliquer sur "Actualiser" pour etre alerte.
#     Tu ouvres le dashboard seulement quand ton telephone sonne.
#
# A FAIRE : clic droit sur ce fichier -> "Executer avec PowerShell"
#           (de preference en tant qu'Administrateur, pour eviter
#           toute question de permissions).
# ===================================================================

$ErrorActionPreference = "Stop"

$taskName    = "GoldEdge-AutoRefresh"
$scriptDir   = $PSScriptRoot
$updateScript = Join-Path $scriptDir "Update-Data.ps1"

if (-not (Test-Path $updateScript)) {
    Write-Host ""
    Write-Host "[ERREUR] Update-Data.ps1 introuvable a cote de ce script." -ForegroundColor Red
    Write-Host "Place Install-AutoRefresh.ps1 DANS le meme dossier que Update-Data.ps1" -ForegroundColor Red
    Write-Host "(le dossier gold_edge_analytics_corrige)." -ForegroundColor Red
    Write-Host ""
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

Write-Host "==================================================="
Write-Host "  Gold Edge Analytics - Installation Auto-Refresh"
Write-Host "==================================================="
Write-Host ""
Write-Host "Dossier detecte : $scriptDir" -ForegroundColor Cyan
Write-Host "Frequence       : toutes les 15 minutes, 24h/24" -ForegroundColor Cyan
Write-Host ""

# Supprime une eventuelle tache existante du meme nom (pour permettre
# de relancer ce script si tu veux reinstaller / reparer la tache).
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Une tache '$taskName' existe deja -> suppression avant reinstallation..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Action : lance PowerShell en mode invisible (pas de fenetre qui clignote)
# pour executer Update-Data.ps1. La sortie (y compris les erreurs) est
# redirigee vers auto_refresh_log.txt : sans ca, un echec silencieux de la
# tache planifiee (ex: Yahoo bloque temporairement, FRED indisponible) ne
# laisserait AUCUNE trace nulle part.
$logFile = Join-Path $scriptDir "auto_refresh_log.txt"
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$updateScript' *>> '$logFile'`"" `
    -WorkingDirectory $scriptDir

# Declencheur : demarre "maintenant" puis se repete toutes les 15 min.
# NOTE : [TimeSpan]::MaxValue depasse la limite acceptee par le schema XML
# du Planificateur de taches (erreur "valeur hors limites"). On utilise donc
# une duree tres longue mais valide (10 ans) -> repetition en pratique illimitee.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

# Parametres : continue de tourner meme sur batterie / reseau limite,
# ne s'arrete pas apres X jours d'inactivite, autorise l'execution a
# la demande, et NE LANCE PAS de nouvelle instance si une precedente
# est encore en cours (evite les executions qui s'empilent si Yahoo
# Finance est lent a repondre).
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# Principal : tourne sous ton compte utilisateur, seulement quand tu es
# connecte (pas besoin de stocker ton mot de passe Windows).
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
        -Description "Gold Edge Analytics : rafraichit data.js et envoie une notif Telegram toutes les 15 min si un edge fort apparait, meme dashboard ferme." `
        | Out-Null
} catch {
    Write-Host ""
    Write-Host "[ERREUR] La creation de la tache a echoue : $_" -ForegroundColor Red
    Write-Host "Aucune tache fonctionnelle n'a ete installee. Relance ce script" -ForegroundColor Red
    Write-Host "en tant qu'Administrateur (clic droit -> Executer avec PowerShell" -ForegroundColor Red
    Write-Host "en tant qu'administrateur) et reessaie." -ForegroundColor Red
    Write-Host ""
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

# Verification : on relit la tache pour confirmer qu'elle existe vraiment
# et que la repetition est bien configuree, plutot que de faire confiance
# aveuglement au fait que Register-ScheduledTask n'a pas leve d'exception.
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
$verifyRepeat = $verify.Triggers[0].Repetition.Interval
if ([string]::IsNullOrWhiteSpace($verifyRepeat)) {
    Write-Host ""
    Write-Host "[ATTENTION] La tache existe mais la repetition toutes les 15 min" -ForegroundColor Yellow
    Write-Host "ne semble pas enregistree correctement. Ouvre le Planificateur de" -ForegroundColor Yellow
    Write-Host "taches Windows -> '$taskName' -> onglet Declencheurs pour verifier" -ForegroundColor Yellow
    Write-Host "manuellement (repetition toutes les 15 min doit apparaitre)." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host ""
Write-Host "[OK] Tache '$taskName' installee avec succes !" -ForegroundColor Green
Write-Host ""
Write-Host "A partir de maintenant :" -ForegroundColor White
Write-Host "  - Tant que ton PC est allume et ta session ouverte, les donnees" -ForegroundColor White
Write-Host "    se rafraichissent seules toutes les 15 min, meme sans navigateur ouvert." -ForegroundColor White
Write-Host "  - Tu recevras une notif Telegram si un NOUVEL edge Fort OU Modere" -ForegroundColor White
Write-Host "    (BUY ou SELL) apparait -> pas de spam (hysteresis anti-rebond incluse)." -ForegroundColor White
Write-Host "  - Quand tu recois la notif, ouvre le dashboard (double-clic sur" -ForegroundColor White
Write-Host "    Lancer-Gold-Edge.bat) pour voir le detail complet avant de trader." -ForegroundColor White
Write-Host ""
Write-Host "Pour verifier que la tache existe : ouvre le Planificateur de taches" -ForegroundColor Gray
Write-Host "Windows -> Bibliotheque du Planificateur de taches -> '$taskName'." -ForegroundColor Gray
Write-Host ""
Write-Host "Pour desinstaller : lance Uninstall-AutoRefresh.ps1" -ForegroundColor Gray
Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
