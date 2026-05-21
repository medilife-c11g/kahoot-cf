.PHONY: help install setup migrate migrate-local dev deploy reset

help:
	@echo "Targets:"
	@echo "  make install        — npm install"
	@echo "  make setup          — create D1 DB, print database_id"
	@echo "  make migrate        — apply schema.sql to remote D1"
	@echo "  make migrate-local  — apply schema.sql to local D1"
	@echo "  make dev            — wrangler dev (uses .dev.vars for DEV_USER_EMAIL bypass)"
	@echo "  make deploy         — deploy to Cloudflare"
	@echo "  make reset          — drop & recreate all remote tables (destructive)"

install:
	npm install

setup:
	@echo ">> Creating D1 database 'kahoot-cf'..."
	@npx wrangler d1 create kahoot-cf || true
	@echo ""
	@echo ">> Copy the printed database_id into wrangler.toml, then run: make migrate"

migrate:
	npx wrangler d1 execute kahoot-cf --remote --file=./schema.sql

migrate-local:
	npx wrangler d1 execute kahoot-cf --local --file=./schema.sql

dev: migrate-local
	npx wrangler dev

deploy:
	npx wrangler deploy

reset:
	@echo ">> WARNING: drops all tables from remote D1"
	@read -p "Type 'yes' to continue: " ans && [ "$$ans" = "yes" ]
	npx wrangler d1 execute kahoot-cf --remote --command="DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS quizzes; DROP TABLE IF EXISTS questions; DROP TABLE IF EXISTS game_history;"
	$(MAKE) migrate
