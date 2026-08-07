# ===================================================================
# Uninstall-Startup.ps1
# ===================================================================
# Supprime la tache planifiee installee par Install-Startup.ps1.
# N'affecte pas GoldEdge-AutoRefresh (rafraichissement 15 min) : pour
# celle-la, utilise Uninstall-AutoRefresh.ps1 separement.
# ===================================================================

$taskName = "GoldEdge-Startup"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[OK] Tache '$taskName' supprimee. Le lancement automatique au demarrage est desactive." -ForegroundColor Green
} else {
    Write-Host "Aucune tache '$taskName' trouvee (deja desinstallee ?)." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
