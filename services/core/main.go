package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--rotate-recovery-key" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := runRecoveryKeyRotationCLI(ctx, os.Args[2:], os.Getenv("DATABASE_URL")); err != nil {
			log.Fatalf("account recovery key rotation failed: %v", err)
		}
		log.Print("account recovery key rotated; secret written to the requested output file")
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--generate-recovery-key" {
		// Explicit operator action: print one high-entropy bootstrap secret to
		// stdout, never to logs or persistent application state.
		key, err := generateRecoveryKey()
		if err != nil {
			log.Fatalf("account recovery key generation failed: %v", err)
		}
		fmt.Println(key)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Get(getenv("HEALTHCHECK_URL", "http://127.0.0.1:8080/health/ready"))
		if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if resp != nil {
				_ = resp.Body.Close()
			}
			os.Exit(1)
		}
		_ = resp.Body.Close()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--export-nas-config" {
		if err := exportNASConfig(context.Background(), os.Stdout); err != nil {
			log.Fatalf("NAS config export failed: %v", err)
		}
		return
	}
	addr := getenv("API_ADDR", ":8080")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := openPersistentDatabase(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("persistent database startup failed: %v", err)
	}
	defer db.Close()
	var _ *sql.DB = db
	srv := NewServer(NewPersistentStore(db))
	httpSrv := &http.Server{Addr: addr, Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() { <-context.Background().Done() }()
	log.Printf("timeline api listening on %s", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
