#!/bin/bash
set -euo pipefail

REMOTE="acceso@192.168.99.167"
REMOTE_DIR="~/ConsejoDeAdministracion"

ssh "$REMOTE" "rm -rf $REMOTE_DIR || true; mkdir -p $REMOTE_DIR/secrets"

# Copia el proyecto completo excepto node_modules/.git/secrets/data
tar --exclude='./node_modules' --exclude='./.git' --exclude='./secrets' --exclude='./data' -czf - . \
	| ssh "$REMOTE" "tar -xzf - -C $REMOTE_DIR"

scp .env "$REMOTE:$REMOTE_DIR/"
scp secrets/*.json "$REMOTE:$REMOTE_DIR/secrets/"
ssh "$REMOTE" "chmod 700 $REMOTE_DIR/secrets && chmod 600 $REMOTE_DIR/secrets/*.json"
ssh "$REMOTE" "cd $REMOTE_DIR && ./Run.sh"
