# Creates the role and database the server uses. The image runs this once,
# when the data volume is empty. The role isn't a superuser: it owns its own
# database and nothing else.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v password="$CONDUIT_DB_PASSWORD" <<'SQL'
CREATE ROLE conduit LOGIN PASSWORD :'password';
CREATE DATABASE conduit OWNER conduit;
SQL
