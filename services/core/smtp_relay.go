package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/smtp"
	"sort"
	"strings"
	"time"
)

const (
	smtpRelayName     = "smtp_relay"
	smtpPasswordScope = "integration:smtp_relay:password"
	defaultSMTPPort   = 465
)

var defaultAdvanceDays = []int{30, 15, 7, 3, 1}

type smtpRelayConfig struct {
	Enabled     bool   `json:"enabled"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	FromEmail   string `json:"fromEmail"`
	ToEmail     string `json:"toEmail"`
	AdvanceDays []int  `json:"advanceDays"`
}

type smtpRelayPatch struct {
	Enabled     bool           `json:"enabled"`
	Host        string         `json:"host"`
	Port        int            `json:"port"`
	Username    string         `json:"username"`
	FromEmail   string         `json:"fromEmail"`
	ToEmail     string         `json:"toEmail"`
	AdvanceDays []int          `json:"advanceDays"`
	Password    secretMutation `json:"password"`
}

type smtpProbeRequest struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username"`
	FromEmail string `json:"fromEmail"`
	ToEmail   string `json:"toEmail"`
	Password  string `json:"password,omitempty"`
}

func defaultSMTPConfig() smtpRelayConfig {
	return smtpRelayConfig{
		Enabled:     false,
		Host:        "smtp.qq.com",
		Port:        defaultSMTPPort,
		Username:    "",
		FromEmail:   "",
		ToEmail:     "",
		AdvanceDays: []int{30, 15, 7, 3, 1},
	}
}

func normalizeAdvanceDays(days []int) []int {
	if len(days) == 0 {
		return []int{30, 15, 7, 3, 1}
	}
	seen := make(map[int]bool)
	var list []int
	for _, d := range days {
		if d > 0 && d <= 365 && !seen[d] {
			seen[d] = true
			list = append(list, d)
		}
	}
	if len(list) == 0 {
		return []int{30, 15, 7, 3, 1}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(list)))
	return list
}

func validateSMTPConfig(cfg smtpRelayConfig) error {
	cfg.Host = strings.TrimSpace(cfg.Host)
	if cfg.Host == "" || len(cfg.Host) > 255 {
		return errors.New("SMTP 主机地址无效")
	}
	if strings.ContainsAny(cfg.Host, " \t\r\n/?#:") {
		return errors.New("SMTP 主机地址格式无效")
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return errors.New("SMTP 端口范围须在 1 到 65535 之间")
	}
	cfg.Username = strings.TrimSpace(cfg.Username)
	if cfg.Username == "" || len(cfg.Username) > 255 {
		return errors.New("SMTP 用户名不能为空")
	}
	cfg.FromEmail = strings.TrimSpace(cfg.FromEmail)
	if !strings.Contains(cfg.FromEmail, "@") || len(cfg.FromEmail) > 255 {
		return errors.New("发件人邮箱格式无效")
	}
	cfg.ToEmail = strings.TrimSpace(cfg.ToEmail)
	if !strings.Contains(cfg.ToEmail, "@") || len(cfg.ToEmail) > 255 {
		return errors.New("收件人邮箱格式无效")
	}
	return nil
}

func smtpRelayResponse(record integrationRecord) map[string]any {
	cfg := defaultSMTPConfig()
	_ = json.Unmarshal(record.Config, &cfg)
	if len(cfg.AdvanceDays) == 0 {
		cfg.AdvanceDays = defaultAdvanceDays
	}
	return map[string]any{
		"enabled":            cfg.Enabled,
		"host":               cfg.Host,
		"port":               cfg.Port,
		"username":           cfg.Username,
		"fromEmail":          cfg.FromEmail,
		"toEmail":            cfg.ToEmail,
		"advanceDays":        cfg.AdvanceDays,
		"passwordConfigured": encryptedSecretConfigured(record.SecretEncrypted),
		"passwordMasked": func() string {
			if encryptedSecretConfigured(record.SecretEncrypted) {
				return "********"
			}
			return ""
		}(),
		"status":        record.TestStatus,
		"statusMessage": record.TestMessage,
		"lastTestedAt":  nullableTime(record.TestedAt),
		"updatedAt":     record.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// loginAuth 兼容不支持 PLAIN 的旧式 SMTP 授权服务器（如部分需要 LOGIN 模式的邮箱）
type loginAuth struct {
	username, password string
}

func (a *loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", []byte(a.username), nil
}

func (a *loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if more {
		prompt := strings.ToLower(string(fromServer))
		if strings.Contains(prompt, "username") {
			return []byte(a.username), nil
		}
		if strings.Contains(prompt, "password") {
			return []byte(a.password), nil
		}
		// 某些服务器不发送明确单词，按次序交付
		return []byte(a.password), nil
	}
	return nil, nil
}

func buildRFC5322Message(from, to, subject, htmlBody, plainBody string) []byte {
	boundary := fmt.Sprintf("=_mime_%d", time.Now().UnixNano())
	encodedSubject := mime.BEncoding.Encode("UTF-8", subject)

	var buf bytes.Buffer
	fmt.Fprintf(&buf, "From: %s\r\n", from)
	fmt.Fprintf(&buf, "To: %s\r\n", to)
	fmt.Fprintf(&buf, "Subject: %s\r\n", encodedSubject)
	fmt.Fprintf(&buf, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&buf, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&buf, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", boundary)

	// Plain text
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	fmt.Fprintf(&buf, "Content-Type: text/plain; charset=\"UTF-8\"\r\n")
	fmt.Fprintf(&buf, "Content-Transfer-Encoding: base64\r\n\r\n")
	plainBase64 := base64.StdEncoding.EncodeToString([]byte(plainBody))
	for i := 0; i < len(plainBase64); i += 76 {
		end := i + 76
		if end > len(plainBase64) {
			end = len(plainBase64)
		}
		buf.WriteString(plainBase64[i:end] + "\r\n")
	}

	// HTML
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	fmt.Fprintf(&buf, "Content-Type: text/html; charset=\"UTF-8\"\r\n")
	fmt.Fprintf(&buf, "Content-Transfer-Encoding: base64\r\n\r\n")
	htmlBase64 := base64.StdEncoding.EncodeToString([]byte(htmlBody))
	for i := 0; i < len(htmlBase64); i += 76 {
		end := i + 76
		if end > len(htmlBase64) {
			end = len(htmlBase64)
		}
		buf.WriteString(htmlBase64[i:end] + "\r\n")
	}

	fmt.Fprintf(&buf, "--%s--\r\n", boundary)
	return buf.Bytes()
}

func sendMailViaSMTP(ctx context.Context, host string, port int, username, password, from, to, subject, htmlBody, plainBody string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	tlsConfig := &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
	}

	dialer := &net.Dialer{Timeout: 12 * time.Second}
	var client *smtp.Client
	var err error

	if port == 465 {
		// SMTPS 隐式 TLS
		tlsConn, dialErr := tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
		if dialErr != nil {
			return fmt.Errorf("SMTPS (TLS) 连接失败: %w", dialErr)
		}
		client, err = smtp.NewClient(tlsConn, host)
		if err != nil {
			_ = tlsConn.Close()
			return fmt.Errorf("初始化 SMTP 会话失败: %w", err)
		}
	} else {
		// 显式连接 (可带 STARTTLS)
		conn, dialErr := dialer.DialContext(ctx, "tcp", addr)
		if dialErr != nil {
			return fmt.Errorf("连接 SMTP 服务器失败: %w", dialErr)
		}
		client, err = smtp.NewClient(conn, host)
		if err != nil {
			_ = conn.Close()
			return fmt.Errorf("初始化 SMTP 会话失败: %w", err)
		}
		if ok, _ := client.Extension("STARTTLS"); ok {
			if startErr := client.StartTLS(tlsConfig); startErr != nil {
				_ = client.Close()
				return fmt.Errorf("STARTTLS 协商失败: %w", startErr)
			}
		}
	}
	defer client.Close()

	// 身份验证
	if username != "" && password != "" {
		auth := smtp.PlainAuth("", username, password, host)
		if authErr := client.Auth(auth); authErr != nil {
			// 如果 PLAIN 失败，尝试 LOGIN
			login := &loginAuth{username: username, password: password}
			if loginErr := client.Auth(login); loginErr != nil {
				return fmt.Errorf("SMTP 身份验证失败: %v (原错误: %v)", loginErr, authErr)
			}
		}
	}

	if err = client.Mail(from); err != nil {
		return fmt.Errorf("MAIL FROM 错误: %w", err)
	}
	if err = client.Rcpt(to); err != nil {
		return fmt.Errorf("RCPT TO 错误: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("DATA 指令失败: %w", err)
	}
	msg := buildRFC5322Message(from, to, subject, htmlBody, plainBody)
	if _, err = writer.Write(msg); err != nil {
		return fmt.Errorf("写入邮件内容失败: %w", err)
	}
	if err = writer.Close(); err != nil {
		return fmt.Errorf("提交邮件内容失败: %w", err)
	}
	return client.Quit()
}

func (srv *Server) updateSMTPRelay(w http.ResponseWriter, r *http.Request) {
	var patch smtpRelayPatch
	if decode(r, &patch) != nil {
		problem(w, 400, "SMTP 配置参数无效")
		return
	}
	cfg := smtpRelayConfig{
		Enabled:     patch.Enabled,
		Host:        strings.TrimSpace(patch.Host),
		Port:        patch.Port,
		Username:    strings.TrimSpace(patch.Username),
		FromEmail:   strings.TrimSpace(patch.FromEmail),
		ToEmail:     strings.TrimSpace(patch.ToEmail),
		AdvanceDays: normalizeAdvanceDays(patch.AdvanceDays),
	}
	if cfg.Port == 0 {
		cfg.Port = defaultSMTPPort
	}
	if err := validateSMTPConfig(cfg); err != nil {
		problem(w, 400, err.Error())
		return
	}

	if patch.Password.Action == "" {
		patch.Password.Action = "keep"
	}
	if patch.Password.Action != "keep" && patch.Password.Action != "replace" && patch.Password.Action != "clear" {
		problem(w, 400, "授权密码操作无效")
		return
	}

	var previous sql.NullString
	_ = srv.store.database.QueryRowContext(r.Context(), `SELECT secret_encrypted FROM integration_settings WHERE name=$1`, smtpRelayName).Scan(&previous)
	secret := previous
	if patch.Password.Action == "clear" {
		secret = sql.NullString{}
	}
	if patch.Password.Action == "replace" {
		val := strings.TrimSpace(patch.Password.Value)
		if val == "" || len(val) > 4096 {
			problem(w, 400, "密码/授权码不能为空且不能超过 4096 字符")
			return
		}
		encrypted, encErr := encryptConfigSecret(smtpPasswordScope, val)
		if encErr != nil {
			problem(w, http.StatusServiceUnavailable, "配置加密密钥不可用，未保存密码")
			return
		}
		secret = sql.NullString{String: encrypted, Valid: true}
	}

	if patch.Enabled && !encryptedSecretConfigured(secret) {
		problem(w, 400, "启用邮件提醒前必须配置密码/授权码")
		return
	}

	data, _ := json.Marshal(cfg)
	status, message := "configured", "已保存配置；建议点击“发送测试邮件”验证连通性"
	if patch.Enabled {
		status, message = "credentials_unverified", "启用意图已保存；测试邮件验证通过前建议先核验证书与凭据"
	}

	var previousConfig []byte
	var previousStatus, previousMessage string
	if err := srv.store.database.QueryRowContext(r.Context(), `SELECT config,last_test_status,last_test_message FROM integration_settings WHERE name=$1`, smtpRelayName).Scan(&previousConfig, &previousStatus, &previousMessage); err == nil {
		var prev smtpRelayConfig
		if json.Unmarshal(previousConfig, &prev) == nil && prev.Host == cfg.Host && prev.Port == cfg.Port && prev.Username == cfg.Username && prev.FromEmail == cfg.FromEmail && prev.ToEmail == cfg.ToEmail && patch.Password.Action == "keep" && previousStatus == "verified" {
			status, message = previousStatus, previousMessage
		}
	}

	_, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO integration_settings(name,config,secret_encrypted,last_test_status,last_test_message,last_tested_at,updated_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $4='verified' THEN now() ELSE NULL END,now()) ON CONFLICT(name) DO UPDATE SET config=EXCLUDED.config,secret_encrypted=EXCLUDED.secret_encrypted,revision=integration_settings.revision+1,last_test_status=$4,last_test_message=$5,last_tested_at=CASE WHEN $4='verified' THEN integration_settings.last_tested_at ELSE NULL END,updated_at=now()`, smtpRelayName, data, secret, status, message)
	if err != nil {
		problem(w, 500, "保存 SMTP 配置失败")
		return
	}
	record, _ := integrationRecordByName(r.Context(), srv.store.database, smtpRelayName)
	jsonResponse(w, 200, smtpRelayResponse(record))
}

func (srv *Server) smtpTestEndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.requirePersistent(w) || !srv.checkMutation(w, r) {
		return
	}
	var req smtpProbeRequest
	if decode(r, &req) != nil {
		problem(w, 400, "测试请求参数无效")
		return
	}
	cfg := smtpRelayConfig{
		Host:      strings.TrimSpace(req.Host),
		Port:      req.Port,
		Username:  strings.TrimSpace(req.Username),
		FromEmail: strings.TrimSpace(req.FromEmail),
		ToEmail:   strings.TrimSpace(req.ToEmail),
	}
	if cfg.Port == 0 {
		cfg.Port = defaultSMTPPort
	}
	if err := validateSMTPConfig(cfg); err != nil {
		problem(w, 400, err.Error())
		return
	}
	password := strings.TrimSpace(req.Password)
	if password == "" {
		record, readErr := integrationRecordByName(r.Context(), srv.store.database, smtpRelayName)
		if readErr == nil && encryptedSecretConfigured(record.SecretEncrypted) {
			decrypted, decErr := decryptConfigSecret(smtpPasswordScope, record.SecretEncrypted.String)
			if decErr == nil {
				password = decrypted
			}
		}
	}
	if password == "" {
		problem(w, 400, "未提供可验证的 SMTP 密码/授权码")
		return
	}

	testSubject := "【TimeBlog】数字资产到期提醒测试邮件"
	testTime := time.Now().Format("2006-01-02 15:04:05")
	plainBody := fmt.Sprintf("你好！\n\n这是一封来自 TimeBlog（菜鸟手记）的数字资产到期提醒测试邮件。\n发送时间：%s\n\n如果您收到此邮件，说明您的 SMTP 中继设置工作完全正常！", testTime)
	htmlBody := fmt.Sprintf(`<!doctype html><html><body style="font-family:sans-serif;color:#333;line-height:1.6;padding:20px;"><div style="max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:8px;padding:24px;background:#ffffff;"><h2 style="color:#0f172a;margin-top:0;">TimeBlog 邮件提醒测试</h2><p>你好！这是一封来自 <strong>TimeBlog（菜鸟手记）</strong> 的数字资产到期预警测试邮件。</p><div style="background:#f8fafc;padding:12px 16px;border-radius:6px;margin:16px 0;font-size:14px;color:#475569;"><strong>发送时间：</strong>%s<br><strong>SMTP 主机：</strong>%s:%d</div><p style="color:#16a34a;font-weight:600;">✓ 连通性与身份验证测试成功！</p></div></body></html>`, testTime, cfg.Host, cfg.Port)

	probeCtx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	if err := sendMailViaSMTP(probeCtx, cfg.Host, cfg.Port, cfg.Username, password, cfg.FromEmail, cfg.ToEmail, testSubject, htmlBody, plainBody); err != nil {
		errMsg := fmt.Sprintf("发送失败: %v", err)
		_, _ = srv.store.database.ExecContext(r.Context(), `UPDATE integration_settings SET last_test_status='unreachable',last_test_message=$1,last_tested_at=now(),updated_at=now() WHERE name=$2`, errMsg, smtpRelayName)
		jsonResponse(w, 200, map[string]any{"status": "unreachable", "message": errMsg})
		return
	}

	succMsg := fmt.Sprintf("测试邮件已成功发送至 %s，请检查收件箱", cfg.ToEmail)
	_, _ = srv.store.database.ExecContext(r.Context(), `UPDATE integration_settings SET last_test_status='verified',last_test_message=$1,last_tested_at=now(),updated_at=now() WHERE name=$2`, succMsg, smtpRelayName)
	jsonResponse(w, 200, map[string]any{"status": "verified", "message": succMsg})
}