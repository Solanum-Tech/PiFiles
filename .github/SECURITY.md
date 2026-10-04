# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately:
**Security › Report a vulnerability** on this repository (GitHub private vulnerability reporting).

Include what you found, how to reproduce it (a sample file or folder name is ideal), and the
PiFiles version (Settings › About). We aim to acknowledge reports within 3 working days and to
ship a fix for confirmed high-severity issues within 14 days, crediting you unless you prefer
otherwise.

## Supported versions

Only the latest release receives security fixes. PiFiles updates itself from GitHub releases
(Settings › About › Updates), and every update is signature-checked before it installs.

## Scope

In scope: anything where opening, previewing or browsing content (files, folder names, archives,
theme or icon packs, network shares) leads to code execution, file access beyond what the user
asked for, or data leaving the computer. The design and current controls are described in
[docs/SECURITY.md](../docs/SECURITY.md).
