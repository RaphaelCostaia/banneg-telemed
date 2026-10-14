@echo off
title Banneg - Carregar dados demo
cd /d "%~dp0"
echo Inserindo dados de demonstracao...
call npm run demo
echo.
echo Abra o painel (Abrir Banneg.bat) para visualizar.
pause
