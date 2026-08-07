# ===================================================================
# Uninstall-AutoRefresh.ps1
# ===================================================================
# Supprime la tache planifiee installee par Install-AutoRefresh.ps1.
# A utiliser si tu veux revenir au fonctionnement manuel (bouton
# "Actualiser" uniquement), ou avant de reinstaller proprement.
# ===================================================================

$taskName = "GoldEdge-AutoRefresh"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[OK] Tache '$taskName' supprimee. Le rafraichissement auto est desactive." -ForegroundColor Green
} else {
    Write-Host "Aucune tache '$taskName' trouvee (deja desinstallee ?)." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
