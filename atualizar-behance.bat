@echo off
chcp 65001 >nul
title Atualizar portfolio do Behance
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo ERRO: Node.js nao foi encontrado neste computador.
    echo Instale o Node.js e execute este arquivo novamente.
    echo.
    pause
    exit /b 1
)

echo Atualizando portfolio a partir do Behance...
echo.
node "scripts\sync-behance.mjs" --usuario "lucas-o-goncalves" --limite 50

if errorlevel 1 (
    echo.
    echo A atualizacao nao foi concluida. Nenhum arquivo deve ser publicado antes de corrigir o erro acima.
    pause
    exit /b 1
)

echo.
echo Agora basta revisar o site e publicar as alteracoes.
pause
