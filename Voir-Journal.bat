@echo off
title Gold Edge Analytics - Journal
if not exist "%~dp0edge_log.txt" (
    echo Aucun journal pour le moment. Il sera cree des la premiere execution
    echo d'Update-Data.ps1 ^(via Lancer-Gold-Edge.bat ou le Planificateur^).
    pause
    exit /b
)
notepad "%~dp0edge_log.txt"
