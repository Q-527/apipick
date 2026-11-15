@echo off
rem Windows wrapper for the apipick CLI (same as `api`).
rem Usage:  apipick  |  apipick list  |  apipick serve  |  apipick serve --provider ds
node "%~dp0bin\api.mjs" %*
