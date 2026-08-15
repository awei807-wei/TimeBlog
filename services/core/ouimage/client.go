package ouimage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

const (
	MaxImageBytes    int64 = 20 * 1024 * 1024
	MaxResponseBytes       = 256 * 1024
	uploadWriterWait       = time.Second
)

var errUploadResponseClosed = errors.New("upload request body closed after response")

var supportedMIME = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true,
	"image/avif": true, "image/heic": true, "image/heif": true,
}

type Config struct {
	Endpoint    string
	Token       string
	WorkspaceID string
}

type Image struct {
	ID           string `json:"id"`
	OriginalURL  string `json:"originalUrl"`
	ThumbnailURL string `json:"thumbnailUrl"`
	SHA256       string `json:"sha256"`
	Name         string `json:"name"`
	MIME         string `json:"mime"`
	Size         int64  `json:"size"`
}

type UploadResult struct {
	Image     Image `json:"image"`
	Duplicate bool  `json:"duplicate"`
}

type ProtocolError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *ProtocolError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("图床请求失败（HTTP %d，%s）", e.StatusCode, e.Code)
	}
	return fmt.Sprintf("图床请求失败（HTTP %d）", e.StatusCode)
}

type Client struct {
	config Config
	http   *http.Client
	sleep  func(context.Context, time.Duration) error
}

func New(config Config) (*Client, error) {
	endpoint, err := NormalizeEndpoint(config.Endpoint)
	if err != nil {
		return nil, err
	}
	config.Endpoint = endpoint
	if strings.TrimSpace(config.Token) == "" {
		return nil, fmt.Errorf("图床 Token 未配置")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = safeDialer((&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext)
	return NewWithHTTPClient(config, &http.Client{Transport: transport, Timeout: 30 * time.Second})
}

func NewWithHTTPClient(config Config, client *http.Client) (*Client, error) {
	endpoint, err := NormalizeEndpoint(config.Endpoint)
	if err != nil {
		return nil, err
	}
	config.Endpoint = endpoint
	if client == nil {
		return nil, fmt.Errorf("HTTP client 未配置")
	}
	origin, _ := url.Parse(endpoint)
	clone := *client
	clone.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !sameOrigin(origin, req.URL) {
			return http.ErrUseLastResponse
		}
		return nil
	}
	return &Client{config: config, http: &clone, sleep: sleepContext}, nil
}

func NormalizeEndpoint(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("图床 API 必须是无凭据、查询参数和片段的 HTTPS URL")
	}
	if u.Port() != "" && u.Port() != "443" {
		return "", fmt.Errorf("图床 API 仅允许 HTTPS 默认端口")
	}
	if strings.TrimSuffix(u.EscapedPath(), "/") == "" {
		u.Path = "/api/uploads"
	} else if strings.TrimSuffix(u.Path, "/") != "/api/uploads" {
		return "", fmt.Errorf("图床 API 路径必须是 /api/uploads")
	}
	u.Path = "/api/uploads"
	u.RawPath = ""
	return u.String(), nil
}

func SupportedMIME(value string) bool {
	return supportedMIME[strings.ToLower(strings.TrimSpace(value))]
}

func (c *Client) Probe(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.config.Endpoint+"?limit=1", nil)
	if err != nil {
		return err
	}
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("图床认证探测失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return decodeProtocolError(resp)
	}
	var result struct {
		Images     []json.RawMessage `json:"images"`
		Page       int               `json:"page"`
		Limit      int               `json:"limit"`
		Total      int               `json:"total"`
		TotalPages int               `json:"totalPages"`
	}
	if err := decodeBoundedJSON(resp.Body, &result); err != nil {
		return fmt.Errorf("图床探测响应无效")
	}
	if result.Limit < 1 || result.TotalPages < 1 {
		return fmt.Errorf("图床探测响应结构不匹配")
	}
	return nil
}

func (c *Client) UploadFile(ctx context.Context, filename, mimeType, filePath, expectedSHA string) (UploadResult, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return UploadResult{}, fmt.Errorf("读取本地媒体失败")
	}
	if info.Size() <= 0 || info.Size() > MaxImageBytes {
		return UploadResult{}, fmt.Errorf("图片必须在 1 字节到 20 MiB 之间")
	}
	if !SupportedMIME(mimeType) {
		return UploadResult{}, fmt.Errorf("图片格式不受 OU Image Hosting 支持")
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		result, retry, err := c.uploadOnce(ctx, filename, mimeType, filePath, expectedSHA)
		if err == nil {
			return result, nil
		}
		last = err
		if !retry || attempt == 2 {
			break
		}
		if err := c.sleep(ctx, time.Duration(1<<attempt)*250*time.Millisecond); err != nil {
			return UploadResult{}, err
		}
	}
	return UploadResult{}, last
}

func (c *Client) uploadOnce(ctx context.Context, filename, mimeType, filePath, expectedSHA string) (UploadResult, bool, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return UploadResult{}, false, fmt.Errorf("读取本地媒体失败")
	}
	defer file.Close()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	writeErr := make(chan error, 1)
	go func() {
		part, err := mw.CreateFormFile("file", path.Base(filename))
		if err == nil {
			_, err = io.Copy(part, file)
		}
		if closeErr := mw.Close(); err == nil {
			err = closeErr
		}
		_ = pw.CloseWithError(err)
		writeErr <- err
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.config.Endpoint, pr)
	if err != nil {
		_ = pr.CloseWithError(err)
		_, _ = waitUploadWriter(writeErr)
		return UploadResult{}, false, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		_ = pr.CloseWithError(err)
		_, _ = waitUploadWriter(writeErr)
		return UploadResult{}, true, fmt.Errorf("图床网络请求失败")
	}
	defer resp.Body.Close()
	// A server or RoundTripper may return a response before consuming the
	// request body. Close the read side first so the multipart writer cannot
	// remain blocked on io.Pipe, then wait only for a bounded period.
	_ = pr.CloseWithError(errUploadResponseClosed)
	write, writerDone := waitUploadWriter(writeErr)
	if !writerDone {
		return UploadResult{}, false, fmt.Errorf("上传请求体写入超时")
	}
	if write != nil && !errors.Is(write, errUploadResponseClosed) && !errors.Is(write, io.ErrClosedPipe) {
		return UploadResult{}, false, fmt.Errorf("读取本地媒体失败")
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		err := decodeProtocolError(resp)
		return UploadResult{}, resp.StatusCode == 429 || resp.StatusCode >= 500, err
	}
	var result UploadResult
	if err := decodeBoundedJSON(resp.Body, &result); err != nil {
		return UploadResult{}, false, fmt.Errorf("图床上传响应无效")
	}
	if result.Image.ID == "" || result.Image.OriginalURL == "" || result.Image.SHA256 == "" {
		return UploadResult{}, false, fmt.Errorf("图床上传响应缺少必要字段")
	}
	if expectedSHA != "" && !strings.EqualFold(expectedSHA, result.Image.SHA256) {
		return UploadResult{}, false, fmt.Errorf("图床返回的文件校验和不匹配")
	}
	publicURL, err := c.resolveDeliveryURL(result.Image.OriginalURL)
	if err != nil {
		return UploadResult{}, false, err
	}
	result.Image.OriginalURL = publicURL
	if result.Image.ThumbnailURL != "" {
		if thumbnail, err := c.resolveDeliveryURL(result.Image.ThumbnailURL); err == nil {
			result.Image.ThumbnailURL = thumbnail
		}
	}
	return result, false, nil
}

func waitUploadWriter(writeErr <-chan error) (error, bool) {
	timer := time.NewTimer(uploadWriterWait)
	defer timer.Stop()
	select {
	case err := <-writeErr:
		return err, true
	case <-timer.C:
		return fmt.Errorf("上传请求体写入超时"), false
	}
}

func (c *Client) Trash(ctx context.Context, imageID string) error {
	if strings.TrimSpace(imageID) == "" {
		return nil
	}
	u, _ := url.Parse(c.config.Endpoint)
	u.Path = "/api/uploads/bulk"
	body, _ := json.Marshal(map[string]any{"ids": []string{imageID}, "action": "trash"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("图床回收请求失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return decodeProtocolError(resp)
	}
	var result struct {
		Updated int `json:"updated"`
	}
	if err := decodeBoundedJSON(resp.Body, &result); err != nil {
		return fmt.Errorf("图床回收响应无效")
	}
	return nil
}

func (c *Client) authorize(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	if c.config.WorkspaceID != "" {
		req.Header.Set("X-Workspace-ID", c.config.WorkspaceID)
	}
}

func (c *Client) resolveDeliveryURL(raw string) (string, error) {
	base, _ := url.Parse(c.config.Endpoint)
	target, err := base.Parse(raw)
	if err != nil || !sameOrigin(base, target) || target.Scheme != "https" || target.User != nil {
		return "", fmt.Errorf("图床返回了非同源 HTTPS 文件地址")
	}
	query := target.Query()
	for key := range query {
		lower := strings.ToLower(key)
		if lower == "expires" || lower == "signature" || lower == "token" || strings.HasPrefix(lower, "x-amz-") {
			return "", fmt.Errorf("图床返回临时签名链接，不适合作为博客公开地址")
		}
	}
	return target.String(), nil
}

func decodeProtocolError(resp *http.Response) error {
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = decodeBoundedJSON(resp.Body, &body)
	return &ProtocolError{StatusCode: resp.StatusCode, Code: body.Error.Code, Message: body.Error.Message}
}

func decodeBoundedJSON(reader io.Reader, target any) error {
	limited := io.LimitReader(reader, MaxResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) > MaxResponseBytes {
		return errors.New("response too large")
	}
	return json.Unmarshal(data, target)
}

func sameOrigin(left, right *url.URL) bool {
	return left != nil && right != nil && strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}

func safeDialer(next func(context.Context, string, string) (net.Conn, error)) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
				return nil, fmt.Errorf("图床地址解析到不安全网络")
			}
		}
		return next(ctx, network, address)
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
