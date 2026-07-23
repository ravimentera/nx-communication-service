#!/usr/bin/env bash
#
# Local development database — lifecycle only.
#
# ─────────────────────────────────────────────────────────────────────────────
# THIS SCRIPT NEVER APPLIES A MIGRATION.
#
# Hard rule 1 of EXTRACTION_PLAN.md: migrations are applied by an operator, by
# hand, never by tooling and never by an agent. `db-local.sh status` prints the
# commands; running them is yours.
# ─────────────────────────────────────────────────────────────────────────────
#
# It also never reads DATABASE_URL. Every command execs into the compose
# container `outreach-postgres` by name, so it is structurally incapable of
# touching a remote database even if the environment points at one.
#
#   ./scripts/db-local.sh up       start postgres + redis, wait for healthy
#   ./scripts/db-local.sh status   health, tables, row counts, migration state
#   ./scripts/db-local.sh psql     interactive shell (extra args pass through)
#   ./scripts/db-local.sh down     stop the containers, keep the data volume
#   ./scripts/db-local.sh nuke     destroy the containers AND the data volume
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Compose *service* names (what `docker compose exec` takes) and the container
# names the healthcheck reports under (what `docker inspect` takes).
PG_SERVICE=postgres
REDIS_SERVICE=redis
PG_CONTAINER=outreach-postgres
REDIS_CONTAINER=outreach-redis
PG_USER=outreach
PG_DB=outreach

# Host-side coordinates. These match .env.example; the ports are deliberately
# non-default so this never collides with a local Mentera Postgres.
HOST_DSN="postgres://outreach:outreach@localhost:5433/outreach"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n'  "$*"; }

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    red "Docker is not running. Start Docker Desktop and retry."
    exit 1
  fi
}

wait_healthy() {
  local name=$1 i status
  for i in $(seq 1 45); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
    [ "$status" = "healthy" ] && { green "  $name: healthy"; return 0; }
    sleep 2
  done
  red "  $name: not healthy after 90s (last status: ${status:-unknown})"
  red "  docker compose logs $name"
  return 1
}

psql_q() { docker compose exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -qtAX -c "$1"; }

cmd_up() {
  require_docker
  docker compose up -d postgres redis
  wait_healthy "$PG_CONTAINER"
  wait_healthy "$REDIS_CONTAINER"
  echo
  dim "  postgres  $HOST_DSN"
  dim "  redis     redis://localhost:6380"
  echo
  cmd_status
}

cmd_status() {
  require_docker
  echo "containers"
  docker compose ps --format '  {{.Name}}\t{{.Status}}' postgres redis 2>/dev/null || true
  echo

  if ! docker compose exec -T "$PG_SERVICE" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    red "postgres is not accepting connections — run: ./scripts/db-local.sh up"
    exit 1
  fi

  local count
  count=$(psql_q "select count(*) from information_schema.tables where table_schema='public'")
  echo "database: $PG_DB — $count table(s) in schema public"

  if [ "$count" -gt 0 ]; then
    echo
    docker compose exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -qX -c "
      select c.relname as table,
             c.reltuples::bigint as approx_rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname;"
  fi

  echo
  echo "migration files on disk:"
  local f
  for f in migrations/[0-9][0-9][0-9][0-9]_*.sql; do
    [ -e "$f" ] || { echo "  (none)"; break; }
    echo "  $(basename "$f")"
  done

  if [ "$count" -eq 0 ]; then
    echo
    red "No tables yet. Apply the migrations yourself:"
    echo
    npm run --silent migrate:print || true
  fi
}

cmd_psql() {
  require_docker
  shift || true
  docker compose exec "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" "$@"
}

cmd_down() {
  require_docker
  docker compose stop postgres redis
  dim "Data volume kept. './scripts/db-local.sh up' brings it back as it was."
}

cmd_nuke() {
  require_docker
  red "This destroys the outreach database AND its data volume."
  printf 'Type the word DESTROY to confirm: '
  read -r reply
  [ "$reply" = "DESTROY" ] || { echo "aborted"; exit 1; }
  docker compose down -v
  green "Gone. './scripts/db-local.sh up' gives you an empty database; migrations must be re-applied."
}

case "${1:-status}" in
  up)     cmd_up ;;
  status) cmd_status ;;
  psql)   cmd_psql "$@" ;;
  down)   cmd_down ;;
  nuke)   cmd_nuke ;;
  *)      sed -n '1,25p' "$0"; exit 1 ;;
esac
