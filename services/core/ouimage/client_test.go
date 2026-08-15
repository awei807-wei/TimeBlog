package ouimage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func testClient(t *testing.T, trip roundTripFunc) *Client {
	t.Helper()
	c, err := NewWithHTTPClient(Config{Endpoint: "https://image.example.test/api/uploads", Token: "ouh_prefix_secret", WorkspaceID: "space-1"}, &http.Client{Transport: trip})
	if err != nil {
		t.Fatal(err)
	}
	c.sleep = func(context.Context, time.Duration) error { return nil }
	return c
}

func TestUploadContractAndRelativeURL(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "image-*.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("test-image"))
	_ = file.Close()
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		if r.Header.Get("Authorization") != "Bearer ouh_prefix_secret" || r.Header.Get("X-Workspace-ID") != "space-1" {
			t.Fatal("missing auth headers")
		}
		if err := r.ParseMultipartForm(MaxImageBytes); err != nil {
			t.Fatal(err)
		}
		part, _, err := r.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer part.Close()
		return response(201, `{"image":{"id":"remote-1","originalUrl":"/api/files/remote-1/original?width=1200","thumbnailUrl":"/api/files/remote-1/thumbnail","sha256":"abc"},"duplicate":false}`), nil
	})
	got, err := c.UploadFile(context.Background(), "photo.png", "image/png", file.Name(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if got.Image.OriginalURL != "https://image.example.test/api/files/remote-1/original?width=1200" || got.Duplicate {
		t.Fatalf("unexpected result: %+v", got)
	}
}

func TestUploadEarlyResponseWithoutConsumingBody(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "image-*.jpg")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("jpeg"))
	_ = file.Close()
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		// Deliberately model an early response that leaves the request body
		// untouched. uploadOnce must close its own pipe reader defensively.
		return response(200, `{"image":{"id":"early","originalUrl":"/api/files/early/original","sha256":"def"},"duplicate":false}`), nil
	})
	done := make(chan struct{})
	var got UploadResult
	var uploadErr error
	go func() {
		got, uploadErr = c.UploadFile(context.Background(), "photo.jpg", "image/jpeg", file.Name(), "def")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("early response upload did not return promptly")
	}
	if uploadErr != nil || got.Image.ID != "early" {
		t.Fatalf("early response upload failed: %+v %v", got, uploadErr)
	}
}

func TestUploadEarlyResponseStillRetries(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "image-*.jpg")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("jpeg"))
	_ = file.Close()
	var calls atomic.Int32
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		// The first response arrives before the body is consumed. The client
		// must close the pipe and still preserve the 429 retry contract.
		if calls.Add(1) == 1 {
			return response(429, `{"error":{"code":"RATE_LIMITED"}}`), nil
		}
		return response(200, `{"image":{"id":"retried","originalUrl":"/api/files/retried/original","sha256":"def"},"duplicate":true}`), nil
	})
	got, err := c.UploadFile(context.Background(), "photo.jpg", "image/jpeg", file.Name(), "def")
	if err != nil || !got.Duplicate || got.Image.ID != "retried" || calls.Load() != 2 {
		t.Fatalf("early response retry failed: %+v %v calls=%d", got, err, calls.Load())
	}
}

func TestUploadDuplicateAndRetry(t *testing.T) {
	file, _ := os.CreateTemp(t.TempDir(), "image-*.jpg")
	_, _ = file.Write([]byte("jpeg"))
	_ = file.Close()
	var calls atomic.Int32
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		_, _ = io.Copy(io.Discard, r.Body)
		if calls.Add(1) < 3 {
			return response(429, `{"error":{"code":"RATE_LIMITED"}}`), nil
		}
		return response(200, `{"image":{"id":"same","originalUrl":"/api/files/same/original","sha256":"def"},"duplicate":true}`), nil
	})
	got, err := c.UploadFile(context.Background(), "photo.jpg", "image/jpeg", file.Name(), "def")
	if err != nil || !got.Duplicate || calls.Load() != 3 {
		t.Fatalf("retry failed: %+v %v calls=%d", got, err, calls.Load())
	}
}

func TestUploadDoesNotRetryOrdinary4xx(t *testing.T) {
	file, _ := os.CreateTemp(t.TempDir(), "image-*.png")
	_, _ = file.Write([]byte("png"))
	_ = file.Close()
	var calls atomic.Int32
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		_, _ = io.Copy(io.Discard, r.Body)
		calls.Add(1)
		return response(403, `{"error":{"code":"TOKEN_SCOPE_DENIED"}}`), nil
	})
	_, err := c.UploadFile(context.Background(), "photo.png", "image/png", file.Name(), "abc")
	if err == nil || calls.Load() != 1 {
		t.Fatalf("4xx must not retry: %v calls=%d", err, calls.Load())
	}
}

func TestUploadContextCancelUnblocksWriter(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "image-*.jpg")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("jpeg"))
	_ = file.Close()
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	c.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	defer cancel()
	start := time.Now()
	_, uploadErr := c.UploadFile(ctx, "photo.jpg", "image/jpeg", file.Name(), "def")
	if uploadErr == nil {
		t.Fatal("expected context cancellation error")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("context cancellation took too long: %s", elapsed)
	}
}

func TestRejectSignedOrCrossOriginDeliveryURL(t *testing.T) {
	c := testClient(t, func(r *http.Request) (*http.Response, error) { return nil, nil })
	for _, raw := range []string{"/api/files/x/original?expires=1&signature=a", "https://evil.example/x", "/api/files/x/original?X-Amz-Signature=a"} {
		if _, err := c.resolveDeliveryURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
}

func TestProbeAndTrashContracts(t *testing.T) {
	var paths []string
	c := testClient(t, func(r *http.Request) (*http.Response, error) {
		if r.Body != nil {
			defer r.Body.Close()
		}
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		if r.Method == http.MethodGet {
			return response(200, `{"images":[],"page":1,"limit":1,"total":0,"totalPages":1}`), nil
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		return response(200, `{"updated":1}`), nil
	})
	if err := c.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := c.Trash(context.Background(), "remote-1"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(paths, "|") != "GET /api/uploads?limit=1|POST /api/uploads/bulk" {
		t.Fatalf("unexpected paths: %v", paths)
	}
}

func TestNormalizeEndpoint(t *testing.T) {
	if got, err := NormalizeEndpoint("https://example.test"); err != nil || got != "https://example.test/api/uploads" {
		t.Fatalf("normalize: %q %v", got, err)
	}
	for _, raw := range []string{"http://example.test/api/uploads", "https://user@example.test/api/uploads", "https://example.test/api/other", "https://example.test/api/uploads?q=1"} {
		if _, err := NormalizeEndpoint(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
