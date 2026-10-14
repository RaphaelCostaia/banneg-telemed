@echo off
title Banneg - Limpar dados
cd /d "%~dp0"
echo ATENCAO: isso apaga TODAS as vendas e cobrancas (mantem o login).
choice /m "Tem certeza que deseja apagar tudo"
if errorlevel 2 goto :fim
call npm run reset
:fim
echo.
pause
