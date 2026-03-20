SHELL := /bin/bash

NPM_CACHE ?= /tmp/openclaw-npm-cache
NPM_TAG ?= latest
NPM_REGISTRY ?= https://registry.npmjs.org/

.PHONY: help check lint typecheck pack pack-dry publish publish-no-check whoami

help:
	@echo "Targets:"
	@echo "  make check             - run lint + typecheck"
	@echo "  make pack-dry          - npm pack --dry-run"
	@echo "  make pack              - npm pack"
	@echo "  make whoami            - verify npm auth"
	@echo "  make publish           - check then npm publish"
	@echo "  make publish-no-check  - npm publish without checks"
	@echo ""
	@echo "Vars:"
	@echo "  NPM_TAG=$(NPM_TAG)"
	@echo "  NPM_REGISTRY=$(NPM_REGISTRY)"
	@echo "  NPM_CACHE=$(NPM_CACHE)"

lint:
	npm run lint

typecheck:
	npm run build

check: lint typecheck

pack-dry:
	npm pack --dry-run --cache $(NPM_CACHE)

pack:
	npm pack --cache $(NPM_CACHE)

whoami:
	npm whoami --registry $(NPM_REGISTRY) --cache $(NPM_CACHE)

publish: check
	npm publish --access public --tag $(NPM_TAG) --registry $(NPM_REGISTRY) --cache $(NPM_CACHE)

publish-no-check:
	npm publish --access public --tag $(NPM_TAG) --registry $(NPM_REGISTRY) --cache $(NPM_CACHE)
