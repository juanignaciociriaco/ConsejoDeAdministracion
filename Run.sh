#!/bin/bash
set -euo pipefail

if command -v docker-compose >/dev/null 2>&1; then
	COMPOSE_CMD="docker-compose"
else
	COMPOSE_CMD="docker compose"
fi

SERVICE="la-enriqueta-api"

echo "[1/5] Bajando contenedor anterior..."
$COMPOSE_CMD down

echo "[2/5] Rebuild sin cache de $SERVICE..."
$COMPOSE_CMD build --no-cache "$SERVICE"

echo "[3/5] Levantando $SERVICE..."
$COMPOSE_CMD up -d "$SERVICE"

echo "[4/5] Estado actual:"
$COMPOSE_CMD ps

echo "[5/5] Ultimos logs:"
$COMPOSE_CMD logs --tail=120 "$SERVICE"
