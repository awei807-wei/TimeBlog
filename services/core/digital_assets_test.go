package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const validDigitalAssetRequestBody = `{"name":"Example Domain","startDate":"2026-01-01","endDate":"2026-12-31","renewalPrice":123.45,"renewalUrl":"https://example.com/renew"}`

func validateDigitalAssetRequestBody(body string) (digitalAssetInput, error) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/digital-assets", strings.NewReader(body))
	var input digitalAssetInput
	if err := decodeStrictJSON(request, &input); err != nil {
		return input, err
	}
	return input, input.normalizeAndValidate()
}

func TestDigitalAssetInputValidation(t *testing.T) {
	input, err := validateDigitalAssetRequestBody(`{"name":"  域名  ","startDate":"2026-01-01","endDate":"2026-01-01","renewalPrice":9999999999.99,"renewalUrl":"  HTTPS://example.com/renew  "}`)
	if err != nil {
		t.Fatalf("valid digital asset input: %v", err)
	}
	if input.Name != "域名" || input.RenewalURL != "HTTPS://example.com/renew" {
		t.Fatalf("input was not normalized: %+v", input)
	}
	if input.RenewalPrice == nil || int64(*input.RenewalPrice) != digitalAssetMaxPriceCents {
		t.Fatalf("price cents=%v", input.RenewalPrice)
	}

	tooLongName := strings.Repeat("资", 161)
	tooLongURL := "https://example.com/" + strings.Repeat("a", 2050)
	tests := []struct {
		name string
		body string
	}{
		{name: "null", body: `null`},
		{name: "array", body: `[]`},
		{name: "empty object", body: `{}`},
		{name: "second JSON value", body: validDigitalAssetRequestBody + ` {}`},
		{name: "unknown field", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"https://example.com","ownerId":"other"}`},
		{name: "blank name", body: `{"name":"  ","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"https://example.com"}`},
		{name: "name too long", body: `{"name":"` + tooLongName + `","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"https://example.com"}`},
		{name: "date not zero padded", body: `{"name":"x","startDate":"2026-1-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"https://example.com"}`},
		{name: "impossible date", body: `{"name":"x","startDate":"2026-02-30","endDate":"2026-03-01","renewalPrice":1,"renewalUrl":"https://example.com"}`},
		{name: "end before start", body: `{"name":"x","startDate":"2026-01-02","endDate":"2026-01-01","renewalPrice":1,"renewalUrl":"https://example.com"}`},
		{name: "price missing", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalUrl":"https://example.com"}`},
		{name: "price null", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":null,"renewalUrl":"https://example.com"}`},
		{name: "price negative", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":-0.01,"renewalUrl":"https://example.com"}`},
		{name: "price too large", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":10000000000,"renewalUrl":"https://example.com"}`},
		{name: "price has three decimals", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":12.345,"renewalUrl":"https://example.com"}`},
		{name: "price is string", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":"12.34","renewalUrl":"https://example.com"}`},
		{name: "blank URL", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"  "}`},
		{name: "unsupported URL scheme", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"ftp://example.com/renew"}`},
		{name: "URL without hostname", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"https:///renew"}`},
		{name: "URL too long", body: `{"name":"x","startDate":"2026-01-01","endDate":"2026-01-02","renewalPrice":1,"renewalUrl":"` + tooLongURL + `"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := validateDigitalAssetRequestBody(test.body); err == nil {
				t.Fatalf("invalid body unexpectedly accepted: %s", test.body)
			}
		})
	}
}

func TestDigitalAssetRenewalPriceMarshalsAsJSONNumber(t *testing.T) {
	encoded, err := json.Marshal(digitalAssetRecord{
		ID:           "00000000-0000-0000-0000-000000000001",
		Name:         "domain",
		StartDate:    "2026-01-01",
		EndDate:      "2026-12-31",
		RenewalPrice: digitalAssetPrice(12345),
		RenewalURL:   "https://example.com/renew",
		CreatedAt:    time.Unix(0, 0).UTC(),
		UpdatedAt:    time.Unix(0, 0).UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"renewalPrice":"`) || !strings.Contains(string(encoded), `"renewalPrice":123.45`) {
		t.Fatalf("renewalPrice is not a JSON number: %s", encoded)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded["renewalPrice"].(float64); !ok {
		t.Fatalf("renewalPrice type=%T", decoded["renewalPrice"])
	}
}

func TestDigitalAssetIDFromPathRejectsUnsafeShapes(t *testing.T) {
	validID := "00000000-0000-0000-0000-000000000001"
	if got, ok := digitalAssetIDFromPath(digitalAssetItemPathPrefix + validID); !ok || got != validID {
		t.Fatalf("valid id=%q ok=%v", got, ok)
	}
	for _, path := range []string{
		"/api/v1/admin/digital-assets",
		digitalAssetItemPathPrefix,
		digitalAssetItemPathPrefix + "not-a-uuid",
		digitalAssetItemPathPrefix + validID + "/extra",
		digitalAssetItemPathPrefix + validID + " ",
	} {
		if _, ok := digitalAssetIDFromPath(path); ok {
			t.Fatalf("unsafe path accepted: %q", path)
		}
	}
}

func TestDigitalAssetRoutesEnforceAdminSecurityAndPersistence(t *testing.T) {
	t.Setenv("APP_ENV", "test")
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	handler := NewServer(NewStore()).routes()

	serve := func(method, path, body, cookie, csrf string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if cookie != "" {
			request.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
		}
		if method != http.MethodGet && method != http.MethodHead {
			request.Header.Set("Origin", "http://localhost:3000")
		}
		if csrf != "" {
			request.Header.Set("X-CSRF-Token", csrf)
		}
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if strings.HasPrefix(path, "/api/v1/admin/") {
			if got := response.Header().Get("Cache-Control"); got != "no-store, max-age=0" {
				t.Fatalf("%s %s Cache-Control=%q", method, path, got)
			}
			if got := response.Header().Get("CDN-Cache-Control"); got != "no-store" {
				t.Fatalf("%s %s CDN-Cache-Control=%q", method, path, got)
			}
			if got := response.Header().Get("Pragma"); got != "no-cache" {
				t.Fatalf("%s %s Pragma=%q", method, path, got)
			}
		}
		return response
	}

	if response := serve(http.MethodGet, "/api/v1/admin/digital-assets", "", "", ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated collection status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodPost, "/api/v1/admin/digital-assets", validDigitalAssetRequestBody, "", ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated mutation status=%d body=%s", response.Code, response.Body.String())
	}

	_, session := loginForTest(t, handler)
	parts := strings.SplitN(session, "\n", 2)
	if len(parts) != 2 {
		t.Fatalf("invalid test session: %q", session)
	}
	cookie, csrf := parts[0], parts[1]

	if response := serve(http.MethodGet, "/api/v1/admin/digital-assets", "", cookie, ""); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("memory collection status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodPost, "/api/v1/admin/digital-assets", validDigitalAssetRequestBody, cookie, ""); response.Code != http.StatusForbidden {
		t.Fatalf("mutation without CSRF status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodPost, "/api/v1/admin/digital-assets", `{"name":"x","unexpected":true}`, cookie, csrf); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodPost, "/api/v1/admin/digital-assets", validDigitalAssetRequestBody, cookie, csrf); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("valid mutation without database status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodPut, "/api/v1/admin/digital-assets", "", cookie, csrf); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unsupported collection method status=%d body=%s", response.Code, response.Body.String())
	}

	validID := "00000000-0000-0000-0000-000000000001"
	if response := serve(http.MethodGet, digitalAssetItemPathPrefix+validID, "", cookie, ""); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unsupported item method status=%d body=%s", response.Code, response.Body.String())
	}
	if response := serve(http.MethodPatch, digitalAssetItemPathPrefix+"not-a-uuid", validDigitalAssetRequestBody, cookie, csrf); response.Code != http.StatusNotFound {
		t.Fatalf("invalid item id status=%d body=%s", response.Code, response.Body.String())
	}

	for _, path := range []string{"/api/v1/digital-assets", "/api/v1/public/digital-assets"} {
		if response := serve(http.MethodGet, path, "", "", ""); response.Code != http.StatusNotFound {
			t.Fatalf("unexpected public route %s status=%d", path, response.Code)
		}
	}
}
