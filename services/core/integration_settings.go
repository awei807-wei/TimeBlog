package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/example/personal-timeline/services/core/ouimage"
)

const (
	externalImageHostName = "external_image_host"
	nasBackupName         = "nas_backup"
	externalTokenScope    = "integration:external_image_host:token"
	defaultImageHostURL   = "https://image.cainiao.me/api/uploads"
)

type externalImageHostConfig struct {
	Enabled      bool   `json:"enabled"`
	Endpoint     string `json:"endpoint"`
	WorkspaceID  string `json:"workspaceId,omitempty"`
	StablePublic bool   `json:"stablePublicUrls"`
	SyncDeletes  bool   `json:"syncDeletes"`
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
	Enabled      bool           `json:"enabled"`
	Endpoint     string         `json:"endpoint"`
	WorkspaceID  string         `json:"workspaceId"`
	StablePublic bool           `json:"stablePublicUrls"`
	SyncDeletes  bool           `json:"syncDeletes"`
	Token        secretMutation `json:"token"`
}

type externalImageHostProbeRequest struct {
	Endpoint    string `json:"endpoint"`
	WorkspaceID string `json:"workspaceId"`
	Token       string `json:"token,omitempty"`
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

type customPublicProvider struct {
	config          externalImageHostConfig
	tokenConfigured bool
	verified        bool
}

func (customPublicProvider) ProtocolStatus() string { return "ou_image_hosting_v1" }
func (p customPublicProvider) PublishEnabled() bool {
	return p.config.Enabled && p.config.StablePublic && p.tokenConfigured && p.verified
}

func imageHostResponse(record integrationRecord) map[string]any {
	config := externalImageHostConfig{Endpoint: defaultImageHostURL}
	_ = json.Unmarshal(record.Config, &config)
	return map[string]any{
		"provider":         "custom_public",
		"enabled":          config.Enabled,
		"endpoint":         config.Endpoint,
		"workspaceId":      config.WorkspaceID,
		"stablePublicUrls": config.StablePublic,
		"syncDeletes":      config.SyncDeletes,
		"tokenConfigured":  record.SecretEncrypted.Valid && record.SecretEncrypted.String != "",
		"tokenMasked": func() string {
			if record.SecretEncrypted.Valid && record.SecretEncrypted.String != "" {
				return "********"
			}
			return ""
		}(),
		"protocolStatus": "ou_image_hosting_v1",
		"verified":       record.TestStatus == "verified" || record.TestStatus == "scope_limited",
		"publishEnabled": customPublicProvider{config: config, tokenConfigured: record.SecretEncrypted.Valid, verified: record.TestStatus == "verified" || record.TestStatus == "scope_limited"}.PublishEnabled(),
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
	normalized, err := ouimage.NormalizeEndpoint(raw)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(normalized)
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

func validateWorkspaceID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) > 80 || strings.ContainsAny(value, " \t\r\n/?#") {
		return "", fmt.Errorf("工作区 ID 格式无效")
	}
	return value, nil
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
	workspaceID, err := validateWorkspaceID(patch.WorkspaceID)
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
	if patch.Enabled && !patch.StablePublic {
		problem(w, 400, "启用前必须确认图床使用稳定公开 URL，未启用短期签名链接")
		return
	}
	data, _ := json.Marshal(externalImageHostConfig{Enabled: patch.Enabled, Endpoint: endpoint, WorkspaceID: workspaceID, StablePublic: patch.StablePublic, SyncDeletes: patch.SyncDeletes})
	status, message := "configured", "已保存；请执行无副作用认证验证后启用外部发布"
	if patch.Enabled {
		status, message = "credentials_unverified", "启用意图已保存；认证验证通过前仍只保存本地原件"
	}
	var previousConfig []byte
	var previousStatus, previousMessage string
	if err := srv.store.database.QueryRowContext(r.Context(), `SELECT config,last_test_status,last_test_message FROM integration_settings WHERE name=$1`, externalImageHostName).Scan(&previousConfig, &previousStatus, &previousMessage); err == nil {
		var previous externalImageHostConfig
		if json.Unmarshal(previousConfig, &previous) == nil && previous.Endpoint == endpoint && previous.WorkspaceID == workspaceID && patch.Token.Action == "keep" && (previousStatus == "verified" || previousStatus == "scope_limited") {
			status, message = previousStatus, previousMessage
		}
	}
	_, err = srv.store.database.ExecContext(r.Context(), `INSERT INTO integration_settings(name,config,secret_encrypted,last_test_status,last_test_message,last_tested_at,updated_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $4 IN ('verified','scope_limited') THEN now() ELSE NULL END,now()) ON CONFLICT(name) DO UPDATE SET config=EXCLUDED.config,secret_encrypted=EXCLUDED.secret_encrypted,revision=integration_settings.revision+1,last_test_status=$4,last_test_message=$5,last_tested_at=CASE WHEN $4 IN ('verified','scope_limited') THEN integration_settings.last_tested_at ELSE NULL END,updated_at=now()`, externalImageHostName, data, secret, status, message)
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
	var request externalImageHostProbeRequest
	if decode(r, &request) != nil || strings.TrimSpace(request.Endpoint) == "" {
		problem(w, 400, "请提供要测试的图床 Endpoint")
		return
	}
	status, message := srv.probeExternalImageHost(r.Context(), request)
	jsonResponse(w, 200, map[string]any{"status": status, "message": message, "protocolStatus": "ou_image_hosting_v1"})
}

func (srv *Server) probeExternalImageHost(ctx context.Context, request externalImageHostProbeRequest) (string, string) {
	validated, err := validateExternalEndpoint(request.Endpoint)
	if err != nil {
		return "unreachable", "Endpoint 校验失败"
	}
	workspaceID, err := validateWorkspaceID(request.WorkspaceID)
	if err != nil {
		return "unreachable", err.Error()
	}
	token := strings.TrimSpace(request.Token)
	if token == "" {
		record, readErr := integrationRecordByName(ctx, srv.store.database, externalImageHostName)
		if readErr == nil && record.SecretEncrypted.Valid {
			token, err = decryptConfigSecret(externalTokenScope, record.SecretEncrypted.String)
		}
	}
	if err != nil || token == "" {
		return "credentials_unverified", "未提供可验证的 Token；上传协议已知但凭据未验证"
	}
	client, err := ouimage.New(ouimage.Config{Endpoint: validated, Token: token, WorkspaceID: workspaceID})
	if err != nil {
		return "unreachable", "图床客户端配置无效"
	}
	probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err = client.Probe(probeCtx); err != nil {
		var protocol *ouimage.ProtocolError
		if errors.As(err, &protocol) && protocol.StatusCode == http.StatusForbidden && protocol.Code == "TOKEN_SCOPE_DENIED" {
			_, _ = srv.store.database.ExecContext(ctx, `UPDATE integration_settings SET last_test_status='scope_limited',last_test_message='Token 未授权 images:read；上传协议已确认，按稳定 URL 确认允许启用',last_tested_at=now(),updated_at=now() WHERE name=$1`, externalImageHostName)
			return "scope_limited", "Token 未授权 images:read，无法无副作用读取验证；images:write 上传仍可按已审计协议启用"
		}
		return "credentials_unverified", "认证验证失败：" + err.Error()
	}
	_, _ = srv.store.database.ExecContext(ctx, `UPDATE integration_settings SET last_test_status='verified',last_test_message='认证与只读协议验证通过；未上传或删除文件',last_tested_at=now(),updated_at=now() WHERE name=$1`, externalImageHostName)
	return "verified", "认证与只读协议验证通过；未上传或删除文件"
}
