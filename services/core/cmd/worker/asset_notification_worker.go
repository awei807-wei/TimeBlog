package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"mime"
	"net"
	"net/smtp"
	"strings"
	"time"
)

const (
	workerSMTPRelayName     = "smtp_relay"
	workerSMTPPasswordScope = "integration:smtp_relay:password"
)

type workerSMTPConfig struct {
	Enabled     bool   `json:"enabled"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	FromEmail   string `json:"fromEmail"`
	ToEmail     string `json:"toEmail"`
	AdvanceDays []int  `json:"advanceDays"`
}

var lastAssetNotificationCheck time.Time

func buildWorkerRFC5322Message(from, to, subject, htmlBody, plainBody string) []byte {
	boundary := fmt.Sprintf("=_mime_worker_%d", time.Now().UnixNano())
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

type workerLoginAuth struct {
	username, password string
}

func (a *workerLoginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", []byte(a.username), nil
}

func (a *workerLoginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if more {
		prompt := strings.ToLower(string(fromServer))
		if strings.Contains(prompt, "username") {
			return []byte(a.username), nil
		}
		if strings.Contains(prompt, "password") {
			return []byte(a.password), nil
		}
		return []byte(a.password), nil
	}
	return nil, nil
}

func sendWorkerMail(ctx context.Context, host string, port int, username, password, from, to, subject, htmlBody, plainBody string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	tlsConfig := &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
	}

	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var client *smtp.Client
	var err error

	if port == 465 {
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

	if username != "" && password != "" {
		auth := smtp.PlainAuth("", username, password, host)
		if authErr := client.Auth(auth); authErr != nil {
			login := &workerLoginAuth{username: username, password: password}
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
	msg := buildWorkerRFC5322Message(from, to, subject, htmlBody, plainBody)
	if _, err = writer.Write(msg); err != nil {
		return fmt.Errorf("写入邮件内容失败: %w", err)
	}
	if err = writer.Close(); err != nil {
		return fmt.Errorf("提交邮件内容失败: %w", err)
	}
	return client.Quit()
}

func checkDigitalAssetNotifications(ctx context.Context, db *sql.DB) error {
	var configJSON []byte
	var encrypted sql.NullString
	var testStatus string
	err := db.QueryRowContext(ctx, `SELECT config, secret_encrypted, last_test_status FROM integration_settings WHERE name=$1`, workerSMTPRelayName).
		Scan(&configJSON, &encrypted, &testStatus)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("查询 SMTP 设置失败: %w", err)
	}

	var cfg workerSMTPConfig
	if err = json.Unmarshal(configJSON, &cfg); err != nil || !cfg.Enabled || testStatus != "verified" || !encrypted.Valid {
		return nil
	}

	password, err := decryptWorkerSecret(workerSMTPPasswordScope, encrypted.String)
	if err != nil || password == "" {
		return fmt.Errorf("解密 SMTP 密码失败: %w", err)
	}

	if len(cfg.AdvanceDays) == 0 {
		cfg.AdvanceDays = []int{30, 15, 7, 3, 1}
	}

	shanghaiLoc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		shanghaiLoc = time.FixedZone("CST", 8*3600)
	}
	now := time.Now().In(shanghaiLoc)
	todayStr := now.Format("2006-01-02")
	todayTime, _ := time.ParseInLocation("2006-01-02", todayStr, shanghaiLoc)

	rows, err := db.QueryContext(ctx, `SELECT id::text, name, end_date::text, renewal_price, renewal_url FROM digital_assets WHERE end_date >= $1::date ORDER BY end_date ASC`, todayStr)
	if err != nil {
		return fmt.Errorf("查询数字资产失败: %w", err)
	}
	defer rows.Close()

	type assetItem struct {
		id           string
		name         string
		endDateStr   string
		renewalPrice float64
		renewalURL   string
	}

	var assets []assetItem
	for rows.Next() {
		var a assetItem
		if scanErr := rows.Scan(&a.id, &a.name, &a.endDateStr, &a.renewalPrice, &a.renewalURL); scanErr != nil {
			return scanErr
		}
		assets = append(assets, a)
	}
	if err = rows.Err(); err != nil {
		return err
	}

	for _, a := range assets {
		endT, pErr := time.ParseInLocation("2006-01-02", a.endDateStr, shanghaiLoc)
		if pErr != nil {
			continue
		}
		diffDays := int(math.Round(endT.Sub(todayTime).Hours() / 24.0))
		if diffDays < 0 {
			continue
		}

		for _, stage := range cfg.AdvanceDays {
			// 当剩余天数在预警阶段窗口内（diffDays <= stage）时，检查该 stage 是否已发过
			if diffDays <= stage {
				var alreadySent bool
				_ = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM digital_asset_notifications WHERE asset_id=$1::uuid AND notice_stage=$2 AND target_date=$3::date)`, a.id, stage, a.endDateStr).Scan(&alreadySent)
				if alreadySent {
					continue
				}

				// 发送邮件提醒
				var urgencyText string
				if diffDays == 0 {
					urgencyText = "将于【今天】到期"
				} else if diffDays == 1 {
					urgencyText = "将于【明天】到期"
				} else {
					urgencyText = fmt.Sprintf("将在 %d 天后（%s）到期", diffDays, a.endDateStr)
				}

				subject := fmt.Sprintf("【到期预警】您的数字资产「%s」%s", a.name, urgencyText)
				plainBody := fmt.Sprintf("你好！\n\n您的数字资产「%s」%s。\n\n- 到期日期：%s\n- 剩余天数：%d 天\n- 续费预估：¥%.2f\n- 续费地址：%s\n\n请及时关注并办理续费，以免服务中断。", a.name, urgencyText, a.endDateStr, diffDays, a.renewalPrice, a.renewalURL)
				htmlBody := fmt.Sprintf(`<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;line-height:1.6;background-color:#f8fafc;padding:24px 12px;margin:0;">
  <div style="max-width:580px;margin:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);overflow:hidden;">
    <div style="background:linear-gradient(135deg, #0ea5e9, #0284c7);padding:24px;color:#ffffff;">
      <h2 style="margin:0;font-size:20px;font-weight:600;">TimeBlog 数字资产到期提醒</h2>
      <p style="margin:6px 0 0 0;font-size:14px;opacity:0.9;">资产「%s」%s</p>
    </div>
    <div style="padding:24px;">
      <table style="width:100%%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:10px 0;color:#64748b;width:90px;">资产名称</td><td style="padding:10px 0;font-weight:600;color:#0f172a;">%s</td></tr>
        <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:10px 0;color:#64748b;">到期日期</td><td style="padding:10px 0;font-weight:600;color:#e11d48;">%s（剩余 %d 天）</td></tr>
        <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:10px 0;color:#64748b;">续费金额</td><td style="padding:10px 0;font-weight:600;color:#0f172a;">¥%.2f</td></tr>
      </table>
      <div style="text-align:center;margin:28px 0 16px 0;">
        <a href="%s" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 32px;border-radius:8px;font-size:15px;box-shadow:0 2px 4px rgba(2,132,199,0.25);">直达续费管理地址 →</a>
      </div>
      <p style="margin:16px 0 0 0;font-size:12px;color:#94a3b8;text-align:center;">此邮件由 TimeBlog 系统自动发送，请勿直接回复。</p>
    </div>
  </div>
</body>
</html>`, a.name, urgencyText, a.name, a.endDateStr, diffDays, a.renewalPrice, a.renewalURL)

				sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				sendErr := sendWorkerMail(sendCtx, cfg.Host, cfg.Port, cfg.Username, password, cfg.FromEmail, cfg.ToEmail, subject, htmlBody, plainBody)
				cancel()

				if sendErr != nil {
					log.Printf("[worker] 发送资产 [%s] 提醒邮件失败: %v", a.name, sendErr)
					continue
				}

				// 登记防重记录
				_, insErr := db.ExecContext(ctx, `INSERT INTO digital_asset_notifications (asset_id, notice_stage, target_date, recipient, sent_at) VALUES ($1::uuid, $2, $3::date, $4, now()) ON CONFLICT (asset_id, notice_stage, target_date) DO NOTHING`, a.id, stage, a.endDateStr, cfg.ToEmail)
				if insErr != nil {
					log.Printf("[worker] 记录通知防重状态失败: %v", insErr)
				} else {
					log.Printf("[worker] 成功投递资产 [%s] (阶段: %d 天) 到期提醒至 %s", a.name, stage, cfg.ToEmail)
				}
				// 针对每个资产，本次巡检处理完该阶段即可，避免重复触发后续 stage
				break
			}
		}
	}

	return nil
}