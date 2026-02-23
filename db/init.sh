#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE eventdb;
    CREATE DATABASE n8ndb;
EOSQL

# テーブル作成は Prisma Migrate で行うため、ここでは DB 作成のみ
