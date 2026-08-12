.PHONY: api-test web-test test
api-test:
	GOCACHE=/tmp/go-cache go test -C services/core ./...
api-vet:
	GOCACHE=/tmp/go-cache go vet -C services/core ./...
web-test:
	npm --workspace apps/web test
test: api-test api-vet web-test
