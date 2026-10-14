@echo off
title Banneg Telemedicina
cd /d "%~dp0"

echo ============================================
echo   Banneg Telemedicina - iniciando...
echo ============================================
echo.

REM Instala dependencias na primeira vez
if not exist node_modules (
  echo Instalando dependencias, aguarde...
  call npm install
  echo.
)

REM Sobe o servidor em uma janela propria (mantenha ela aberta)
start "Banneg Telemedicina - Servidor (NAO FECHAR)" cmd /k npm start

REM Espera o servidor subir e abre o navegador
echo Abrindo o painel no navegador...
timeout /t 4 /nobreak >nul
start "" http://localhost:3000

echo.
echo Pronto! O painel abriu no navegador.
echo Para usar o sistema, mantenha a janela do servidor aberta.
echo.
pause
