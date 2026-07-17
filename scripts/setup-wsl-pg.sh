#!/bin/bash
set -e
sudo -u postgres psql -c "SELECT version();"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='workforce'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER workforce WITH PASSWORD 'workforce' SUPERUSER;"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='workforce'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE workforce OWNER workforce;"
sudo -u postgres psql -c "ALTER USER workforce WITH PASSWORD 'workforce';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE workforce TO workforce;"
echo "DB_READY"
# show listen addresses
sudo -u postgres psql -c "SHOW listen_addresses;"
ss -ltnp 2>/dev/null | grep 5432 || true
