@echo off
rem Windows wrapper for the `api` CLI.
rem Usage:  api  |  api list  |  api add  |  api run ds  ...
node "%~dp0bin\api.mjs" %*
