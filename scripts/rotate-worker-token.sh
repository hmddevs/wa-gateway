#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Rotate the worker RS256 signing keypair.
# Procedure per docs/SECURITY.md. M5 will turn this into a full rotation that
# calls the gateway's admin API. For now it just generates a fresh keypair.
# -----------------------------------------------------------------------------
set -euo pipefail
IFS=$'\n\t'

OUT_DIR="${1:-./.rotation}"
mkdir -p "${OUT_DIR}"
PRIV="${OUT_DIR}/worker-$(date +%Y%m%d-%H%M%S).key"
PUB="${PRIV%.key}.pub"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${PRIV}"
openssl rsa -in "${PRIV}" -pubout -out "${PUB}"
chmod 600 "${PRIV}"

echo "Generated:"
echo "  Private: ${PRIV}  (keep OFF the repo, set as WORKER_JWT_SIGNING_KEY)"
echo "  Public:  ${PUB}   (set as WORKER_JWT_PUBLIC_KEY, keep old one too during grace)"
echo
echo "Next steps (per docs/SECURITY.md):"
echo "  1. Deploy gateway with BOTH public keys (comma-separated)."
echo "  2. Wait for all workers to refresh via /v1/worker/bootstrap."
echo "  3. After 7 days, remove the legacy public key and redeploy."
