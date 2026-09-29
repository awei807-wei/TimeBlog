package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/example/personal-timeline/services/core/ouimage"
)

func TestImageHostPublishingEligibility(t *testing.T) {
	for _, tc := range []struct {
		visibility, mime string
		size             int64
		want             bool
	}{
		{"public", "image/jpeg", 1, true},
		{"public", "image/png", ouimage.MaxImageBytes, true},
		{"private", "image/jpeg", 1, false},
		{"", "image/jpeg", 1, false},
		{"public", "application/pdf", 1, false},
		{"public", "image/svg+xml", 1, false},
		{"public", "image/jpeg", 0, false},
		{"public", "image/jpeg", ouimage.MaxImageBytes + 1, false},
	} {
		if got := ouimage.CanPublish(tc.visibility, tc.mime, tc.size); got != tc.want {
			t.Errorf("CanPublish(%+v) = %v", tc, got)
		}
	}
}

func TestPublishedImageDeliveryAndLocalFallback(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MEDIA_ROOT", root)
	path := filepath.Join(root, "photo.jpg")
	if err := os.WriteFile(path, []byte("local-original"), 0600); err != nil {
		t.Fatal(err)
	}
	store := NewStore()
	base := Media{ID: "photo", OriginalName: "photo.jpg", MimeType: "image/jpeg", Status: "ready", Visibility: "public", StoragePath: path, Provider: "custom_public", ExternalPublishStatus: "published", PublicURL: "https://image.example.test/photo.jpg"}
	store.media[base.ID] = &base
	handler := NewServer(store).routes()
	for _, tc := range []struct {
		name, method, query, visibility, publication, target string
		status                                               int
	}{
		{"host first", "GET", "", "public", "published", base.PublicURL, 307},
		{"explicit fallback", "GET", "?local=1", "public", "published", base.PublicURL, 200},
		{"metadata remains local", "HEAD", "", "public", "published", base.PublicURL, 200},
		{"publishing uses local", "GET", "", "public", "pending", base.PublicURL, 200},
		{"failed host uses local", "GET", "", "public", "failed", base.PublicURL, 200},
		{"private stays protected", "GET", "", "private", "published", base.PublicURL, 404},
		{"private fallback stays protected", "GET", "?local=1", "private", "published", base.PublicURL, 404},
		{"unsafe URL uses local", "GET", "", "public", "published", "javascript:alert(1)", 200},
		{"credentials rejected", "GET", "", "public", "published", "https://user:secret@example.test/x", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := base
			m.Visibility = tc.visibility
			m.ExternalPublishStatus = tc.publication
			m.PublicURL = tc.target
			store.media[base.ID] = &m
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(tc.method, "/api/v1/media/photo/content"+tc.query, nil))
			if response.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, tc.status, response.Body.String())
			}
			if tc.status == 307 {
				if response.Header().Get("Location") != tc.target || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("bad host redirect: %v", response.Header())
				}
			} else if response.Header().Get("Location") != "" {
				t.Fatal("unexpected external redirect")
			}
			if tc.status == 200 && tc.method == "GET" && response.Body.String() != "local-original" {
				t.Fatal("local original missing")
			}
		})
	}
}

func TestPostgresPublishedImageDelivery(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	root := t.TempDir()
	t.Setenv("MEDIA_ROOT", root)
	path := filepath.Join(root, "published.jpg")
	if err := os.WriteFile(path, []byte("local-original"), 0600); err != nil {
		t.Fatal(err)
	}
	var id string
	err := db.QueryRow(`INSERT INTO media(id,owner_id,provider,visibility,original_name,mime_type,size_bytes,status,storage_path,public_url,external_publish_status) SELECT gen_random_uuid(),id,'custom_public','public','published.jpg','image/jpeg',14,'ready',$1,'https://image.example.test/published.jpg','published' FROM users WHERE username='owner' RETURNING id::text`, path).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM media WHERE id=$1::uuid`, id); err != nil {
			t.Error(err)
		}
	})
	handler := NewServer(NewPersistentStore(db)).routes()
	for _, tc := range []struct {
		method, query string
		status        int
	}{{"GET", "", 307}, {"GET", "?local=1", 200}, {"HEAD", "", 200}} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, "/api/v1/media/"+id+"/content"+tc.query, nil))
		if response.Code != tc.status {
			t.Fatalf("%s %s: status=%d body=%s", tc.method, tc.query, response.Code, response.Body.String())
		}
	}
	if _, err := db.Exec(`UPDATE media SET visibility='private' WHERE id=$1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"", "?local=1"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/media/"+id+"/content"+query, nil))
		if response.Code != 404 || response.Header().Get("Location") != "" {
			t.Fatal("private image disclosed")
		}
	}
}
