#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE eventdb' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'eventdb')\gexec
    SELECT 'CREATE DATABASE n8ndb' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8ndb')\gexec
EOSQL

# テーブル作成は Prisma Migrate で行うため、ここでは DB 作成のみ
