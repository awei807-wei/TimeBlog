package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	externalImageHostName = "external_image_host"
	nasBackupName         = "nas_backup"
	externalTokenScope    = "integration:external_image_host:token"
	defaultImageHostURL   = "https://image.cainiao.me/api/uploads"
)

type externalImageHostConfig struct {
	Enabled  bool   `json:"enabled"`
	Endpoint string `json:"endpoint"`
}

type nasBackupConfig struct {
	Enabled       bool   `json:"enabled"`
	SourceHost    string `json:"sourceHost"`
	SourcePath    string `json:"sourcePath"`
	Destination   string `json:"destinationPath"`
	RetentionDays int    `json:"retentionDays"`
}

type integrationRecord struct {
	Config          []byte
	SecretEncrypted sql.NullString
	Revision        int64
	TestStatus      string
	TestMessage     string
	TestedAt        sql.NullTime
	UpdatedAt       time.Time
}

type secretMutation struct {
	Action string `json:"action"`
	Value  string `json:"value,omitempty"`
}

type externalImageHostPatch struct {
	Enabled  bool           `json:"enabled"`
	Endpoint string         `json:"endpoint"`
	Token    secretMutation `json:"token"`
}

func integrationRecordByName(ctx context.Context, db *sql.DB, name string) (integrationRecord, error) {
	var record integrationRecord
	err := db.QueryRowContext(ctx, `SELECT config,secret_encrypted,revision,last_test_status,last_test_message,last_tested_at,updated_at FROM integration_settings WHERE name=$1`, name).
		Scan(&record.Config, &record.SecretEncrypted, &record.Revision, &record.TestStatus, &record.TestMessage, &record.TestedAt, &record.UpdatedAt)
	return record, err
}

type externalImageHostProvider interface {
	ProtocolStatus() string
	PublishEnabled() bool
}

// customPublicProvider is intentionally fail-closed. The configured service
// has no verified official contract for token transport, upload fields,
// response shape or deletion, so it cannot accept media bytes yet.
type customPublicProvider struct{}

func (customPublicProvider) ProtocolStatus() string { return "unverified" }
func (customPublicProvider) PublishEnabled() bool   { return false }

func imageHostResponse(record integrationRecord) map[string]any {
	config := externalImageHostConfig{Endpoint: defaultImageHostURL}
	_ = json.Unmarshal(record.Config, &config)
	return map[string]any{
		"provider":        "custom_public",
		"enabled":         config.Enabled,
		"endpoint":        config.Endpoint,
		"tokenConfigured": record.SecretEncrypted.Valid && record.SecretEncrypted.String != "",
		"tokenMasked": func() string {
			if record.SecretEncrypted.Valid && record.SecretEncrypted.String != "" {
				return "********"
			}
			return ""
		}(),
		"protocolStatus": "unverified",
		"status":         record.TestStatus,
		"statusMessage":  record.TestMessage,
		"lastTestedAt":   nullableTime(record.TestedAt),
		"updatedAt":      record.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func nasBackupResponse(record integrationRecord) map[string]any {
	config := nasBackupConfig{RetentionDays: 90}
	_ = json.Unmarshal(record.Config, &config)
	return map[string]any{
		"enabled": config.Enabled, "sourceHost": config.SourceHost, "sourcePath": config.SourcePath,
		"destinationPath": config.Destination, "retentionDays": config.RetentionDays,
		"applyStatus": "pending_export", "status": record.TestStatus, "statusMessage": record.TestMessage,
		"lastTestedAt": nullableTime(record.TestedAt), "updatedAt": record.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func nullableTime(value sql.NullTime) any {
	if !value.Valid {
		return nil
	}
	return value.Time.UTC().Format(time.RFC3339)
}

func validateExternalEndpoint(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", fmt.Errorf("图床 API 必须是无用户名密码和片段的 HTTPS URL")
	}
	if u.Port() != "" && u.Port() != "443" {
		return "", fmt.Errorf("图床 API 仅允许 HTTPS 默认端口")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "localhost" || host == "localhost.localdomain" {
		return "", fmt.Errorf("图床 API 不允许本机地址")
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()) {
		return "", fmt.Errorf("图床 API 不允许内网地址")
	}
	return u.String(), nil
}

func validNASHost(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 255 || strings.ContainsAny(value, " \t\r\n;&|`$<>(){}[]\\\"'") {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("._@:-", r)) {
			return false
		}
	}
	return true
}

func validNASPath(value string) bool {
	if value == "" || len(value) > 1024 || !strings.HasPrefix(value, "/") || value == "/" || strings.Contains(value, "..") {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("/._-", r)) {
			return false
		}
	}
	return !strings.Contains(value, "/./") && !strings.HasSuffix(value, "/.")
}

func validateNASConfig(config nasBackupConfig) error {
	if config.RetentionDays < 1 || config.RetentionDays > 3650 {
		return fmt.Errorf("NAS 保留天数必须在 1 到 3650 之间")
	}
	if !validNASHost(config.SourceHost) {
		return fmt.Errorf("NAS 源主机格式无效")
	}
	if !validNASPath(config.SourcePath) {
		return fmt.Errorf("NAS 源路径必须是安全绝对路径")
	}
	if !validNASPath(config.Destination) {
		return fmt.Errorf("NAS 目标路径必须是安全绝对路径")
	}
	return nil
}

func (srv *Server) integrationSettingsEndpoint(w http.ResponseWriter, r *http.Request) {
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/integrations/"), "/")
	if name != externalImageHostName && name != nasBackupName {
		problem(w, http.StatusNotFound, "集成配置不存在")
		return
	}
	if !srv.requirePersistent(w) {
		return
	}
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	switch r.Method {
	case http.MethodGet:
		record, err := integrationRecordByName(r.Context(), srv.store.database, name)
		if err == sql.ErrNoRows {
			record = integrationRecord{Config: []byte(`{}`), TestStatus: "untested", UpdatedAt: time.Now()}
		} else if err != nil {
			problem(w, 500, "读取集成配置失败")
			return
		}
		if name == externalImageHostName {
			jsonResponse(w, 200, imageHostResponse(record))
		} else {
			jsonResponse(w, 200, nasBackupResponse(record))
		}
	case http.MethodPatch:
		if !srv.checkMutation(w, r) {
			return
		}
		if name == externalImageHostName {
			srv.updateExternalImageHost(w, r)
		} else {
			srv.updateNASBackup(w, r)
		}
	default:
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (srv *Server) updateExternalImageHost(w http.ResponseWriter, r *http.Request) {
	var patch externalImageHostPatch
	if decode(r, &patch) != nil {
		problem(w, 400, "图床配置无效")
		return
	}
	endpoint, err := validateExternalEndpoint(patch.Endpoint)
	if err != nil {
		problem(w, 400, err.Error())
		return
	}
	if patch.Token.Action == "" {
		patch.Token.Action = "keep"
	}
	if patch.Token.Action != "keep" && patch.Token.Action != "replace" && patch.Token.Action != "clear" {
		problem(w, 400, "Token 操作无效")
		return
	}
	var previous sql.NullString
	_ = srv.store.database.QueryRowContext(r.Context(), `SELECT secret_encrypted FROM integration_settings WHERE name=$1`, externalImageHostName).Scan(&previous)
	secret := previous
	if patch.Token.Action == "clear" {
		secret = sql.NullString{}
	}
	if patch.Token.Action == "replace" {
		value := strings.TrimSpace(patch.Token.Value)
		if value == "" || len(value) > 8192 {
			problem(w, 400, "Token 不能为空且不能超过 8192 字符")
			return
		}
		encrypted, encErr := encryptConfigSecret(externalTokenScope, value)
		if encErr != nil {
			problem(w, http.StatusServiceUnavailable, "配置加密密钥不可用，未保存 Token")
			return
		}
		secret = sql.NullString{String: encrypted, Valid: true}
	}
	if patch.Enabled && !secret.Valid {
		problem(w, 400, "启用图床前必须保存 Token")
		return
	}
	data, _ := json.Marshal(externalImageHostConfig{Enabled: patch.Enabled, Endpoint: endpoint})
	_, err = srv.store.database.ExecContext(r.Context(), `INSERT INTO integration_settings(name,config,secret_encrypted,last_test_status,last_test_message,updated_at) VALUES($1,$2,$3,'configured_unverified','已保存；API 协议尚未验证，外部发布保持禁用',now()) ON CONFLICT(name) DO UPDATE SET config=EXCLUDED.config,secret_encrypted=EXCLUDED.secret_encrypted,revision=integration_settings.revision+1,last_test_status='configured_unverified',last_test_message='已保存；API 协议尚未验证，外部发布保持禁用',last_tested_at=NULL,updated_at=now()`, externalImageHostName, data, secret)
	if err != nil {
		problem(w, 500, "保存图床配置失败")
		return
	}
	record, _ := integrationRecordByName(r.Context(), srv.store.database, externalImageHostName)
	jsonResponse(w, 200, imageHostResponse(record))
}

func (srv *Server) updateNASBackup(w http.ResponseWriter, r *http.Request) {
	var config nasBackupConfig
	if decode(r, &config) != nil {
		problem(w, 400, "NAS 配置无效")
		return
	}
	config.SourceHost = strings.TrimSpace(config.SourceHost)
	config.SourcePath = strings.TrimSuffix(strings.TrimSpace(config.SourcePath), "/")
	config.Destination = strings.TrimSuffix(strings.TrimSpace(config.Destination), "/")
	if err := validateNASConfig(config); err != nil {
		problem(w, 400, err.Error())
		return
	}
	data, _ := json.Marshal(config)
	_, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO integration_settings(name,config,last_test_status,last_test_message,updated_at) VALUES($1,$2,'configured','已入库；导出到 NAS 环境文件后生效',now()) ON CONFLICT(name) DO UPDATE SET config=EXCLUDED.config,revision=integration_settings.revision+1,last_test_status='configured',last_test_message='已入库；导出到 NAS 环境文件后生效',updated_at=now()`, nasBackupName, data)
	if err != nil {
		problem(w, 500, "保存 NAS 配置失败")
		return
	}
	record, _ := integrationRecordByName(r.Context(), srv.store.database, nasBackupName)
	jsonResponse(w, 200, nasBackupResponse(record))
}

func (srv *Server) integrationTestEndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.requirePersistent(w) || !srv.checkMutation(w, r) {
		return
	}
	name := strings.TrimSuffix(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/integrations/"), "/"), "/test")
	if name != externalImageHostName {
		problem(w, http.StatusNotFound, "集成测试不存在")
		return
	}
	record, err := integrationRecordByName(r.Context(), srv.store.database, name)
	if err != nil {
		problem(w, 404, "请先保存图床配置")
		return
	}
	config := externalImageHostConfig{}
	if json.Unmarshal(record.Config, &config) != nil {
		problem(w, 500, "图床配置损坏")
		return
	}
	status, message := probeExternalImageHost(r.Context(), config.Endpoint)
	_, _ = srv.store.database.ExecContext(r.Context(), `UPDATE integration_settings SET last_test_status=$1,last_test_message=$2,last_tested_at=now(),updated_at=now() WHERE name=$3`, status, message, name)
	jsonResponse(w, 200, map[string]any{"status": status, "message": message, "protocolStatus": "unverified"})
}

func probeExternalImageHost(ctx context.Context, endpoint string) (string, string) {
	validated, err := validateExternalEndpoint(endpoint)
	if err != nil {
		return "unreachable", "Endpoint 校验失败"
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, validated, nil)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return http.ErrUseLastResponse
		}
		if req.URL.Scheme != "https" || req.URL.Hostname() != via[0].URL.Hostname() {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	resp, err := client.Do(req)
	if err != nil {
		return "unreachable", "Endpoint 无法访问；未发送 Token，也未上传文件"
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "configured_unverified", "Endpoint 可达且要求认证；未发送 Token，API 协议仍待文档确认"
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 500 {
		return "configured_unverified", "Endpoint 可达；未发送 Token，API 协议仍待文档确认（HTTP " + strconv.Itoa(resp.StatusCode) + "）"
	}
	return "unreachable", "Endpoint 返回异常状态（HTTP " + strconv.Itoa(resp.StatusCode) + "）"
}
