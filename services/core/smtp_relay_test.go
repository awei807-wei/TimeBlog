package main

import (
	"database/sql"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeAdvanceDays(t *testing.T) {
	cases := []struct {
		input []int
		want  []int
	}{
		{nil, []int{30, 15, 7, 3, 1}},
		{[]int{}, []int{30, 15, 7, 3, 1}},
		{[]int{1, 3, 7, 15, 30}, []int{30, 15, 7, 3, 1}},
		{[]int{7, 7, 15, 0, -5, 400, 3}, []int{15, 7, 3}},
	}
	for _, tc := range cases {
		got := normalizeAdvanceDays(tc.input)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("normalizeAdvanceDays(%v) = %v, want %v", tc.input, got, tc.want)
		}
	}
}

func TestValidateSMTPConfig(t *testing.T) {
	valid := smtpRelayConfig{
		Enabled:     true,
		Host:        "smtp.qq.com",
		Port:        465,
		Username:    "user@qq.com",
		FromEmail:   "user@qq.com",
		ToEmail:     "notify@qq.com",
		AdvanceDays: []int{30, 7, 1},
	}
	if err := validateSMTPConfig(valid); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}

	invalid := []smtpRelayConfig{
		{Host: "   ", Port: 465, Username: "u", FromEmail: "u@q.com", ToEmail: "t@q.com"},
		{Host: "smtp.qq.com:465", Port: 465, Username: "u", FromEmail: "u@q.com", ToEmail: "t@q.com"},
		{Host: "smtp.qq.com", Port: 0, Username: "u", FromEmail: "u@q.com", ToEmail: "t@q.com"},
		{Host: "smtp.qq.com", Port: 70000, Username: "u", FromEmail: "u@q.com", ToEmail: "t@q.com"},
		{Host: "smtp.qq.com", Port: 465, Username: "", FromEmail: "u@q.com", ToEmail: "t@q.com"},
		{Host: "smtp.qq.com", Port: 465, Username: "u", FromEmail: "invalid-email", ToEmail: "t@q.com"},
		{Host: "smtp.qq.com", Port: 465, Username: "u", FromEmail: "u@q.com", ToEmail: "invalid-email"},
	}
	for _, tc := range invalid {
		if err := validateSMTPConfig(tc); err == nil {
			t.Fatalf("invalid config unexpectedly passed: %+v", tc)
		}
	}
}

func TestBuildRFC5322Message(t *testing.T) {
	from := "sender@test.local"
	to := "receiver@test.local"
	subject := "【测试】到期提醒通知"
	html := "<p>你好，资产到期测试！</p>"
	plain := "你好，资产到期测试！"

	raw := buildRFC5322Message(from, to, subject, html, plain)
	msg := string(raw)

	if !strings.Contains(msg, "From: "+from) {
		t.Errorf("missing From header")
	}
	if !strings.Contains(msg, "To: "+to) {
		t.Errorf("missing To header")
	}
	if !strings.Contains(msg, "Content-Type: multipart/alternative;") {
		t.Errorf("missing multipart Content-Type")
	}
	if !strings.Contains(msg, "text/plain; charset=\"UTF-8\"") {
		t.Errorf("missing text/plain part")
	}
	if !strings.Contains(msg, "text/html; charset=\"UTF-8\"") {
		t.Errorf("missing text/html part")
	}
}

func TestSMTPRelayResponseMasking(t *testing.T) {
	record := integrationRecord{
		Config:          []byte(`{"enabled":true,"host":"smtp.qq.com","port":465,"username":"test@qq.com","fromEmail":"test@qq.com","toEmail":"test@qq.com","advanceDays":[30,7]}`),
		SecretEncrypted: sql.NullString{Valid: true, String: "v1.mock_encrypted"},
		TestStatus:      "verified",
		TestMessage:     "OK",
	}
	resp := smtpRelayResponse(record)
	if resp["passwordConfigured"] != true {
		t.Errorf("expected passwordConfigured=true")
	}
	if resp["passwordMasked"] != "********" {
		t.Errorf("expected masked password")
	}
	if resp["enabled"] != true || resp["host"] != "smtp.qq.com" {
		t.Errorf("unexpected field values in response: %+v", resp)
	}

	emptyRecord := integrationRecord{
		Config:          []byte(`{}`),
		SecretEncrypted: sql.NullString{Valid: false},
	}
	respEmpty := smtpRelayResponse(emptyRecord)
	if respEmpty["passwordConfigured"] != false {
		t.Errorf("expected passwordConfigured=false")
	}
	if respEmpty["passwordMasked"] != "" {
		t.Errorf("expected empty passwordMasked")
	}
}