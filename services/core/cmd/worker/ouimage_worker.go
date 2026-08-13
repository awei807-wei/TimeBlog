package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/example/personal-timeline/services/core/ouimage"
)

const externalTokenScope = "integration:external_image_host:token"

type workerImageHostConfig struct {
	Enabled      bool   `json:"enabled"`
	Endpoint     string `json:"endpoint"`
	WorkspaceID  string `json:"workspaceId"`
	StablePublic bool   `json:"stablePublicUrls"`
	SyncDeletes  bool   `json:"syncDeletes"`
}

func decryptWorkerSecret(scope, envelope string) (string, error) {
	parts := strings.SplitN(envelope, ".", 2)
	if len(parts) != 2 || parts[0] != "v1" {
		return "", fmt.Errorf("unsupported secret envelope")
	}
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(os.Getenv("CONFIG_ENCRYPTION_KEY")))
	if err != nil || len(key) != 32 {
		return "", fmt.Errorf("configuration key unavailable")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", fmt.Errorf("invalid secret envelope")
	}
	plain, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte(scope))
	return string(plain), err
}

func loadWorkerImageClientConfig(ctx context.Context, db *sql.DB, expectedRevision int64) (*ouimage.Client, workerImageHostConfig, error) {
	var raw []byte
	var encrypted string
	var revision int64
	var status string
	var config workerImageHostConfig
	if err := db.QueryRowContext(ctx, `SELECT config,COALESCE(secret_encrypted,''),revision,last_test_status FROM integration_settings WHERE name='external_image_host'`).Scan(&raw, &encrypted, &revision, &status); err != nil {
		return nil, workerImageHostConfig{}, err
	}
	if expectedRevision > 0 && revision != expectedRevision {
		return nil, config, fmt.Errorf("图床配置已更新，请使用新配置重试")
	}
	if json.Unmarshal(raw, &config) != nil || !config.Enabled || !config.StablePublic || (status != "verified" && status != "scope_limited") {
		return nil, config, fmt.Errorf("图床配置未启用或未验证")
	}
	token, err := decryptWorkerSecret(externalTokenScope, encrypted)
	if err != nil {
		return nil, config, err
	}
	client, err := ouimage.New(ouimage.Config{Endpoint: config.Endpoint, Token: token, WorkspaceID: config.WorkspaceID})
	return client, config, err
}

func publishMediaJob(ctx context.Context, db *sql.DB, payload []byte) error {
	var p struct {
		MediaID        string `json:"mediaId"`
		ConfigRevision int64  `json:"configRevision"`
	}
	if json.Unmarshal(payload, &p) != nil || p.MediaID == "" {
		return fmt.Errorf("invalid publish job")
	}
	var name, mimeType, storagePath, sha, state string
	var size int64
	if err := db.QueryRowContext(ctx, `SELECT original_name,mime_type,size_bytes,COALESCE(storage_path,''),COALESCE(sha256,''),external_publish_status FROM media WHERE id=$1::uuid`, p.MediaID).Scan(&name, &mimeType, &size, &storagePath, &sha, &state); err != nil {
		return err
	}
	if state == "published" {
		return nil
	}
	if !ouimage.SupportedMIME(mimeType) || size > ouimage.MaxImageBytes {
		return fmt.Errorf("媒体不符合外部图床限制")
	}
	client, _, err := loadWorkerImageClientConfig(ctx, db, p.ConfigRevision)
	if err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `UPDATE media SET external_publish_status='publishing',external_publish_error=NULL WHERE id=$1::uuid AND external_publish_status IN ('pending','failed','publishing')`, p.MediaID); err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	result, err := client.UploadFile(requestCtx, name, mimeType, storagePath, sha)
	if err != nil {
		_, _ = db.ExecContext(ctx, `UPDATE media SET external_publish_status='failed',external_publish_error=$2 WHERE id=$1::uuid`, p.MediaID, publicJobError(err))
		return err
	}
	_, err = db.ExecContext(ctx, `UPDATE media SET provider='custom_public',provider_key=$2,public_url=$3,external_publish_status='published',external_publish_error=NULL,external_published_at=now() WHERE id=$1::uuid`, p.MediaID, result.Image.ID, result.Image.OriginalURL)
	return err
}

func trashExternalMedia(ctx context.Context, db *sql.DB, mediaID, providerKey string, configRevision int64) error {
	if providerKey == "" {
		return nil
	}
	// Deleting a local media file must not require the external publish gate
	// when syncDeletes is disabled.  A configuration can be intentionally
	// disabled or unverified after an earlier publish; in that case retain the
	// remote copy and still complete local cleanup.
	var raw []byte
	if err := db.QueryRowContext(ctx, `SELECT config FROM integration_settings WHERE name='external_image_host'`).Scan(&raw); err != nil {
		return err
	}
	var config workerImageHostConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return err
	}
	if !config.SyncDeletes {
		// Deliberately leave a structured, non-secret operational trace. The media
		// row is about to be deleted, so logs are the durable signal that the
		// remote object was intentionally retained by policy.
		fmt.Fprintf(os.Stderr, "external_media_retained media_id=%s provider_key=%s reason=sync_deletes_disabled\n", mediaID, providerKey)
		return nil
	}
	client, _, err := loadWorkerImageClientConfig(ctx, db, configRevision)
	if err != nil {
		return err
	}
	trashCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := client.Trash(trashCtx, providerKey); err != nil {
		return err
	}
	// deleteMediaJob holds a FOR UPDATE lock on this media row.  Updating it
	// through db here would wait for the same transaction that is waiting for
	// this function, causing a self-deadlock. The row is deleted immediately
	// after the remote soft-trash succeeds, so no intermediate update is needed.
	return nil
}

func publicJobError(err error) string {
	message := err.Error()
	if len([]rune(message)) > 240 {
		message = string([]rune(message)[:240])
	}
	return message
}
