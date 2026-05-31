# Minecraft Server Manager

A web-based dashboard for managing multiple Minecraft Java Edition servers via Docker.

## Features

- Create and manage multiple servers running in parallel
- Start / stop / restart controls with live status
- Real-time console log stream + RCON command input
- File explorer with drag-and-drop upload
- World import (`.zip` or `.tar.gz` extraction)
- Scheduled and on-demand backups

## Requirements

- Docker + Docker Compose

## Setup

```bash
git clone https://github.com/ef5001/minecraft-server-manager
cd minecraft-server-manager
docker compose up -d --build
```

Open **http://localhost:3000** (or replace `localhost` with your server's IP).

## Notes

- The first time you start a Minecraft server, Docker will pull the `itzg/minecraft-server` image (~200 MB). The server will take a few minutes to initialize.
- Server data is stored in `./data/<server-id>/` and backups in `./backups/<server-id>/`.
- Game ports start at `25565` and are auto-assigned. Players connect to `<your-ip>:<port>`.
