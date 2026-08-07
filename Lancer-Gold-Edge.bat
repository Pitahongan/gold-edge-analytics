@echo off
title Gold Edge Analytics - Demarrage
echo ===================================================
echo        GOLD EDGE ANALYTICS - DEMARRAGE
echo ===================================================
echo.
echo Recuperation des donnees initiales depuis FRED et Yahoo Finance...
echo Veuillez patienter...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Data.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR] Une erreur est survenue lors de la mise a jour des donnees.
    echo Verifiez votre connexion internet ou la cle d'API FRED dans config.json.
    echo.
    pause
    exit /b 1
)

echo.
echo Donnees initiales recuperees avec succes !
echo Demarrage du serveur local (necessaire pour que le bouton
echo "Actualiser" fonctionne reellement dans le dashboard)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Server.ps1"
