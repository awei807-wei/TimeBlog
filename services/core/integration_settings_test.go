package main

import (
	"bytes"
	"database/sql"
	"strings"
	"testing"
)

func TestExternalImageHostPublishGateAfterProbeStatus(t *testing.T) {
	for _, status := range []string{"verified", "scope_limited"} {
		provider := customPublicProvider{
			config:          externalImageHostConfig{Enabled: true, StablePublic: true},
			tokenConfigured: true,
			verified:        status == "verified" || status == "scope_limited",
		}
		if !provider.PublishEnabled() {
			t.Fatalf("publish gate should open for probe status %s", status)
		}
	}
	for name, provider := range map[string]customPublicProvider{
		"disabled":      {config: externalImageHostConfig{Enabled: false, StablePublic: true}, tokenConfigured: true, verified: true},
		"unstable-url":  {config: externalImageHostConfig{Enabled: true, StablePublic: false}, tokenConfigured: true, verified: true},
		"missing-token": {config: externalImageHostConfig{Enabled: true, StablePublic: true}, tokenConfigured: false, verified: true},
		"unverified":    {config: externalImageHostConfig{Enabled: true, StablePublic: true}, tokenConfigured: true, verified: false},
	} {
		if provider.PublishEnabled() {
			t.Fatalf("publish gate unexpectedly open for %s", name)
		}
	}
}

func TestImageHostResponseDoesNotTreatEmptyCiphertextAsConfigured(t *testing.T) {
	record := integrationRecord{Config: []byte(`{"enabled":true,"stablePublicUrls":true}`), SecretEncrypted: sql.NullString{Valid: true, String: "   "}, TestStatus: "verified"}
	response := imageHostResponse(record)
	if response["tokenConfigured"] != false || response["publishEnabled"] != false {
		t.Fatalf("empty encrypted token must not enable publishing: %+v", response)
	}
}

func TestImageHostResponseReflectsVerifiedProbeImmediately(t *testing.T) {
	record := integrationRecord{
		Config:          []byte(`{"enabled":true,"endpoint":"https://image.example.test/api/uploads","stablePublicUrls":true}`),
		SecretEncrypted: sql.NullString{Valid: true, String: "v1.encrypted"},
		TestStatus:      "verified",
	}
	response := imageHostResponse(record)
	if response["verified"] != true || response["publishEnabled"] != true || response["status"] != "verified" {
		t.Fatalf("verified probe status not reflected by GET response: %+v", response)
	}
}

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
