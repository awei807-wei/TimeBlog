package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// exportNASConfig emits only the fixed, non-secret variables consumed by
// deploy/nas-pull-backup.sh. SSH identities and known_hosts stay outside the
// application database and remain owned by the NAS operating system account.
func exportNASConfig(ctx context.Context, out io.Writer) error {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var raw []byte
	if err := db.QueryRowContext(ctx, `SELECT config FROM integration_settings WHERE name=$1`, nasBackupName).Scan(&raw); err != nil {
		return err
	}
	var config nasBackupConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return err
	}
	return writeNASConfig(out, config)
}

func writeNASConfig(out io.Writer, config nasBackupConfig) error {
	if !config.Enabled {
		return fmt.Errorf("NAS backup integration is disabled")
	}
	if err := validateNASConfig(config); err != nil {
		return err
	}
	_, err := fmt.Fprintf(out, "SOURCE_HOST=%s\nSOURCE_PATH=%s\nDEST_PATH=%s\nRETENTION_DAYS=%d\n", config.SourceHost, config.SourcePath, config.Destination, config.RetentionDays)
	return err
}
