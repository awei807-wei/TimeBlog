FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -buildvcs=false -o /out/api . && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -buildvcs=false -o /out/worker ./cmd/worker
RUN mkdir -p /srv/timeline/media /srv/timeline/exports && chmod 0770 /srv/timeline/media /srv/timeline/exports
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/api /app/api
COPY --from=build /out/worker /app/worker
COPY --from=build --chown=65532:65532 /srv/timeline /srv/timeline
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/app/api"]
