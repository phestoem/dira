#!/bin/bash
set -e

APP="dira"
DIR="/opt/qusaz/dira"
API_SERVICE="dira-api"
WEB_SERVICE="dira-web"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploying $APP"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd $DIR

echo "→ Pulling latest code..."
git pull

echo "→ Installing API dependencies..."
cd api
npm install --omit=dev

echo "→ Running Prisma migrations..."
npx prisma migrate deploy
npx prisma generate

cd $DIR

echo "→ Installing web dependencies..."
cd web
npm install

echo "→ Building web..."
npm run build

cd $DIR

echo "→ Restarting services..."
sudo systemctl restart $API_SERVICE
sudo systemctl restart $WEB_SERVICE

sleep 3

API_STATUS=$(sudo systemctl is-active $API_SERVICE)
WEB_STATUS=$(sudo systemctl is-active $WEB_SERVICE)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$API_STATUS" = "active" ] && [ "$WEB_STATUS" = "active" ]; then
  echo "  ✓ $APP deployed successfully"
  echo "  ✓ $API_SERVICE: $API_STATUS"
  echo "  ✓ $WEB_SERVICE: $WEB_STATUS"
else
  echo "  ✗ Deployment may have issues"
  echo "  $API_SERVICE: $API_STATUS"
  echo "  $WEB_SERVICE: $WEB_STATUS"
  echo ""
  echo "  Check logs:"
  echo "  journalctl -u $API_SERVICE -n 30"
  echo "  journalctl -u $WEB_SERVICE -n 30"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
