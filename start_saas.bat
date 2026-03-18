@echo off
title ArbitraSaaS Multi-Tenant Host

echo ========================================================
echo 🚀 Deploying ArbitraSaaS (Local Host Edition)
echo ========================================================
echo.


echo ^> [1/4] Installing necessary NPM dependencies...
call npm install

echo ^> [2/4] Generating Database Schemas...
call npx prisma generate

echo ^> [3/4] Compiling React Dashboard for Production (NextJS)...
call npm run build

echo.
echo ========================================================
echo 🟢 Deployment Complete. Online at: http://localhost:3000
echo  Press CTRL+C at any time to shutdown the hosting cluster.
echo.

:: 4. Start the production Node API & Frontend
call npm start
