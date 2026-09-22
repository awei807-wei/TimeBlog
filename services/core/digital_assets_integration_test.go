package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostgresDigitalAssetCRUDAndOwnerIsolation(t *testing.T) {
	t.Setenv("APP_ENV", "test")
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)

	var ownerID string
	if err := db.QueryRow(`SELECT id::text FROM users WHERE username='owner'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	prefix := "digital-asset-" + strings.ReplaceAll(newID(), "-", "")
	var otherOwnerID, sessionHash string
	t.Cleanup(func() {
		if sessionHash != "" {
			if _, err := db.Exec(`DELETE FROM sessions WHERE token_hash=$1`, sessionHash); err != nil {
				t.Errorf("cleanup digital asset session: %v", err)
			}
		}
		if _, err := db.Exec(`DELETE FROM digital_assets WHERE owner_id=$1::uuid AND name LIKE $2`, ownerID, prefix+"%"); err != nil {
			t.Errorf("cleanup owner digital assets: %v", err)
		}
		if otherOwnerID != "" {
			if _, err := db.Exec(`DELETE FROM users WHERE id=$1::uuid`, otherOwnerID); err != nil {
				t.Errorf("cleanup foreign digital asset owner: %v", err)
			}
		}
	})

	if err := db.QueryRow(`INSERT INTO users(id,username,password_hash,totp_secret_encrypted)
		VALUES(gen_random_uuid(),$1,$2,$3)
		RETURNING id::text`, prefix, "integration-only", "integration-only").Scan(&otherOwnerID); err != nil {
		t.Fatal(err)
	}
	var foreignAssetID string
	if err := db.QueryRow(`INSERT INTO digital_assets(owner_id,name,start_date,end_date,renewal_price,renewal_url)
		VALUES($1::uuid,$2,'2026-01-01','2026-12-31',9.99,$3)
		RETURNING id::text`, otherOwnerID, prefix+" foreign", "https://example.com/foreign").Scan(&foreignAssetID); err != nil {
		t.Fatal(err)
	}

	sessionToken := "session-" + newID()
	csrfToken := "csrf-" + newID()
	sessionHash = tokenHash(sessionToken)
	if _, err := db.Exec(`INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,last_seen,idle_expires,absolute_expires)
		VALUES(gen_random_uuid(),$1::uuid,$2,$3,now(),now()+interval '1 hour',now()+interval '2 hours')`,
		ownerID, sessionHash, tokenHash(csrfToken)); err != nil {
		t.Fatal(err)
	}

	handler := NewServer(NewPersistentStore(db)).routes()
	assetBody := func(name, startDate, endDate string, price float64, renewalURL string) string {
		t.Helper()
		body, err := json.Marshal(map[string]any{
			"name":         name,
			"startDate":    startDate,
			"endDate":      endDate,
			"renewalPrice": price,
			"renewalUrl":   renewalURL,
		})
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	serve := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		request.AddCookie(&http.Cookie{Name: "timeline_session", Value: sessionToken})
		if method != http.MethodGet && method != http.MethodHead {
			request.Header.Set("Origin", "http://localhost:3000")
			request.Header.Set("X-CSRF-Token", csrfToken)
		}
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	create := func(name, endDate string, price float64) digitalAssetRecord {
		t.Helper()
		response := serve(http.MethodPost, "/api/v1/admin/digital-assets", assetBody(name, "2026-01-01", endDate, price, "https://example.com/renew"))
		if response.Code != http.StatusCreated {
			t.Fatalf("create digital asset status=%d body=%s", response.Code, response.Body.String())
		}
		var asset digitalAssetRecord
		if err := json.Unmarshal(response.Body.Bytes(), &asset); err != nil {
			t.Fatalf("decode created digital asset: %v; body=%s", err, response.Body.String())
		}
		if !validImportUUID(asset.ID) || asset.CreatedAt.IsZero() || asset.UpdatedAt.IsZero() {
			t.Fatalf("created digital asset metadata=%+v", asset)
		}
		return asset
	}

	later := create(prefix+" z-later", "2027-12-31", 123.45)
	earlier := create(prefix+" a-earlier", "2026-06-30", 0)
	if int64(later.RenewalPrice) != 12345 || int64(earlier.RenewalPrice) != 0 {
		t.Fatalf("created digital asset prices=%d/%d", later.RenewalPrice, earlier.RenewalPrice)
	}

	listResponse := serve(http.MethodGet, "/api/v1/admin/digital-assets", "")
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list digital assets status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}
	var listBody struct {
		DigitalAssets []digitalAssetRecord `json:"digitalAssets"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode digital asset list: %v; body=%s", err, listResponse.Body.String())
	}
	positions := map[string]int{}
	for index, asset := range listBody.DigitalAssets {
		positions[asset.ID] = index
		if asset.ID == foreignAssetID {
			t.Fatalf("foreign owner's asset leaked into list: %+v", asset)
		}
	}
	earlierPosition, hasEarlier := positions[earlier.ID]
	laterPosition, hasLater := positions[later.ID]
	if !hasEarlier || !hasLater || earlierPosition >= laterPosition {
		t.Fatalf("digital assets are not ordered by endDate then name: earlier=%d/%v later=%d/%v body=%s", earlierPosition, hasEarlier, laterPosition, hasLater, listResponse.Body.String())
	}

	patchedBody := assetBody(prefix+" patched", "2026-02-01", "2028-02-01", 88.08, "https://example.com/patched")
	patchResponse := serve(http.MethodPatch, digitalAssetItemPathPrefix+later.ID, patchedBody)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("patch digital asset status=%d body=%s", patchResponse.Code, patchResponse.Body.String())
	}
	var patched digitalAssetRecord
	if err := json.Unmarshal(patchResponse.Body.Bytes(), &patched); err != nil {
		t.Fatalf("decode patched digital asset: %v; body=%s", err, patchResponse.Body.String())
	}
	if patched.ID != later.ID || patched.Name != prefix+" patched" || patched.StartDate != "2026-02-01" || patched.EndDate != "2028-02-01" || int64(patched.RenewalPrice) != 8808 || patched.RenewalURL != "https://example.com/patched" {
		t.Fatalf("patched digital asset=%+v", patched)
	}
	if patched.CreatedAt != later.CreatedAt || patched.UpdatedAt.Before(later.UpdatedAt) {
		t.Fatalf("patched timestamps before=%+v after=%+v", later, patched)
	}

	if response := serve(http.MethodPatch, digitalAssetItemPathPrefix+foreignAssetID, patchedBody); response.Code != http.StatusNotFound {
		t.Fatalf("cross-owner patch status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodDelete, digitalAssetItemPathPrefix+foreignAssetID, ""); response.Code != http.StatusNotFound {
		t.Fatalf("cross-owner delete status=%d body=%s", response.Code, response.Body.String())
	}
	var foreignCount int
	if err := db.QueryRow(`SELECT count(*) FROM digital_assets WHERE id=$1::uuid AND owner_id=$2::uuid`, foreignAssetID, otherOwnerID).Scan(&foreignCount); err != nil {
		t.Fatal(err)
	}
	if foreignCount != 1 {
		t.Fatalf("cross-owner asset count=%d", foreignCount)
	}

	for _, assetID := range []string{later.ID, earlier.ID} {
		response := serve(http.MethodDelete, digitalAssetItemPathPrefix+assetID, "")
		if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
			t.Fatalf("delete digital asset %s status=%d body=%s", assetID, response.Code, response.Body.String())
		}
	}
	var ownerAssetCount int
	if err := db.QueryRow(`SELECT count(*) FROM digital_assets WHERE owner_id=$1::uuid AND id IN ($2::uuid,$3::uuid)`, ownerID, later.ID, earlier.ID).Scan(&ownerAssetCount); err != nil {
		t.Fatal(err)
	}
	if ownerAssetCount != 0 {
		t.Fatalf("deleted owner digital assets remain=%d", ownerAssetCount)
	}
}
