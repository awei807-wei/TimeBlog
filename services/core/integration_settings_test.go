package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateExternalEndpoint(t *testing.T) {
	if got, err := validateExternalEndpoint(defaultImageHostURL); err != nil || got != defaultImageHostURL {
		t.Fatalf("default endpoint rejected: %q %v", got, err)
	}
	for _, value := range []string{"http://image.example.test/uploads", "https://127.0.0.1/uploads", "https://10.0.0.1/uploads", "https://user:pass@example.test/uploads", "https://example.test:8443/uploads"} {
		if _, err := validateExternalEndpoint(value); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", value)
		}
	}
}

func TestProbeExternalImageHostTreatsUnauthorizedAsReachable(t *testing.T) {
	var receivedAuthorization string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuthorization = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	status, message := probeExternalImageHostWithClient(context.Background(), server.URL, server.Client())
	if status != "configured_unverified" {
		t.Fatalf("401 should mean reachable/authentication required, got %q: %s", status, message)
	}
	if !strings.Contains(message, "要求认证") {
		t.Fatalf("401 probe message should explain authentication challenge: %s", message)
	}
	if receivedAuthorization != "" {
		t.Fatalf("reachability probe leaked authorization header: %q", receivedAuthorization)
	}
}

func TestValidateNASConfigMatchesScriptContract(t *testing.T) {
	valid := nasBackupConfig{Enabled: true, SourceHost: "backup@vps.example.test", SourcePath: "/srv/timeblog/backup-staging", Destination: "/srv/timeblog/nas-snapshots", RetentionDays: 90}
	if err := validateNASConfig(valid); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	invalid := []nasBackupConfig{
		{Enabled: true, SourceHost: "host;id", SourcePath: valid.SourcePath, Destination: valid.Destination, RetentionDays: 90},
		{Enabled: true, SourceHost: valid.SourceHost, SourcePath: "/srv/../etc", Destination: valid.Destination, RetentionDays: 90},
		{Enabled: true, SourceHost: valid.SourceHost, SourcePath: valid.SourcePath, Destination: "/", RetentionDays: 90},
		{Enabled: true, SourceHost: valid.SourceHost, SourcePath: valid.SourcePath, Destination: valid.Destination, RetentionDays: 0},
	}
	for _, value := range invalid {
		if err := validateNASConfig(value); err == nil {
			t.Fatalf("invalid config accepted: %+v", value)
		}
	}
}

func TestWriteNASConfigMatchesPullScriptVariablesAndContainsNoSecret(t *testing.T) {
	config := nasBackupConfig{Enabled: true, SourceHost: "backup-source", SourcePath: "/srv/timeblog/backup-staging", Destination: "/srv/timeblog/nas-snapshots", RetentionDays: 90}
	var out bytes.Buffer
	if err := writeNASConfig(&out, config); err != nil {
		t.Fatal(err)
	}
	want := "SOURCE_HOST=backup-source\nSOURCE_PATH=/srv/timeblog/backup-staging\nDEST_PATH=/srv/timeblog/nas-snapshots\nRETENTION_DAYS=90\n"
	if out.String() != want {
		t.Fatalf("unexpected export:\n%s", out.String())
	}
	for _, forbidden := range []string{"PRIVATE_KEY", "PASSWORD", "TOKEN", "CONFIG_ENCRYPTION_KEY", "DATABASE_URL"} {
		if strings.Contains(out.String(), forbidden) {
			t.Fatalf("export leaked forbidden field %s", forbidden)
		}
	}
}
