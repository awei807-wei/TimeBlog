package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var mediaReferencePattern = regexp.MustCompile(`media://([A-Za-z0-9._~-]+)`)
var mediaUploadLocks sync.Map

// mediaCapability reports the trusted server-side media storage capability.
// This project uses a local media volume (provider local_private), not an
// external image host. The write probe is intentionally performed by the API
// so the editor never guesses from client-side environment variables.
func (srv *Server) mediaCapability(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	jsonResponse(w, http.StatusOK, srv.mediaCapabilityStatus())
}

// mediaCapabilityStatus is deliberately metadata-only so it can be reused by
// the authenticated runtime status endpoint without exposing filesystem paths.
func (srv *Server) mediaCapabilityStatus() map[string]any {
	provider := "local_private"
	writable := checkWritableDirectory(srv.mediaRoot) == nil
	externalProvider := customPublicProvider{}
	external := map[string]any{"provider": "custom_public", "configured": false, "enabled": false, "protocolStatus": externalProvider.ProtocolStatus(), "publishEnabled": false}
	if srv.store.persistent && srv.store.database != nil {
		if record, err := integrationRecordByName(context.Background(), srv.store.database, externalImageHostName); err == nil {
			config := externalImageHostConfig{}
			_ = json.Unmarshal(record.Config, &config)
			provider := customPublicProvider{config: config, tokenConfigured: record.SecretEncrypted.Valid, verified: record.TestStatus == "verified" || record.TestStatus == "scope_limited"}
			external = map[string]any{"provider": "custom_public", "configured": record.SecretEncrypted.Valid, "enabled": config.Enabled, "protocolStatus": provider.ProtocolStatus(), "publishEnabled": provider.PublishEnabled()}
		}
	}
	return map[string]any{
		"provider":              provider,
		"writable":              writable,
		"imageUploadEnabled":    writable,
		"nonImageUploadEnabled": writable,
		"maxUploadBytes":        configuredMaxUploadBytes(),
		"externalPublic":        external,
	}
}

func parseUploadOffset(value string) int64 {
	if value == "" {
		return 0
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 {
		return -1
	}
	return n
}

func extractMediaReferences(markdown string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0)
	for _, match := range mediaReferencePattern.FindAllStringSubmatch(markdown, -1) {
		if len(match) < 2 {
			continue
		}
		id := match[1]
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func validateMediaFile(path string, expectedSize int64, declaredMime string) (string, int64, error) {
	if expectedSize < 0 || expectedSize > configuredMaxUploadBytes() || !allowedMediaMime(declaredMime) {
		return "", 0, fmt.Errorf("invalid media declaration")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	if st.Size() != expectedSize || st.Size() > configuredMaxUploadBytes() {
		return "", st.Size(), fmt.Errorf("media size mismatch")
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return "", st.Size(), err
	}
	detected := http.DetectContentType(head[:n])
	declared, _, _ := mime.ParseMediaType(declaredMime)
	detected, _, _ = mime.ParseMediaType(detected)
	if detected == "application/octet-stream" || declared != detected {
		return "", st.Size(), fmt.Errorf("media MIME mismatch")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", st.Size(), err
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", st.Size(), err
	}
	return hex.EncodeToString(h.Sum(nil)), st.Size(), nil
}

func requestContentLength(r *http.Request) (int64, error) {
	if r.ContentLength < 0 {
		return 0, fmt.Errorf("content length required")
	}
	if r.ContentLength > configuredMaxUploadBytes() {
		return 0, fmt.Errorf("media too large")
	}
	return r.ContentLength, nil
}

func (srv *Server) mediaTicket(w http.ResponseWriter, r *http.Request) {
	if !srv.checkMutation(w, r) {
		return
	}
	var in struct {
		Name       string `json:"name"`
		Size       int64  `json:"size"`
		Mime       string `json:"mime"`
		Visibility string `json:"visibility"`
	}
	if decode(r, &in) != nil {
		problem(w, 400, "请求无效")
		return
	}
	if in.Size < 0 || in.Size > configuredMaxUploadBytes() {
		problem(w, 413, "文件超过上传限制")
		return
	}
	if in.Visibility == "" {
		in.Visibility = "private"
	}
	if in.Visibility != "private" && in.Visibility != "public" {
		problem(w, http.StatusBadRequest, "媒体可见性无效")
		return
	}
	if in.Mime == "" {
		in.Mime = mime.TypeByExtension(filepath.Ext(in.Name))
	}
	if in.Mime == "" || !allowedMediaMime(in.Mime) {
		problem(w, http.StatusUnsupportedMediaType, "不支持的媒体类型")
		return
	}
	m := &Media{ID: newID(), OriginalName: filepath.Base(in.Name), MimeType: in.Mime, SizeBytes: in.Size, Visibility: in.Visibility, Status: "uploading", CreatedAt: time.Now()}
	if srv.store.persistent && srv.store.database != nil {
		var owner string
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT id::text FROM users WHERE username='owner'`).Scan(&owner); err != nil {
			problem(w, 500, "用户不存在")
			return
		}
		if _, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO media(id,owner_id,provider,visibility,original_name,mime_type,size_bytes,status) VALUES($1::uuid,$2::uuid,'local_private',$3,$4,$5,$6,'uploading')`, m.ID, owner, in.Visibility, m.OriginalName, m.MimeType, m.SizeBytes); err != nil {
			problem(w, 500, "创建媒体失败")
			return
		}
	}
	srv.store.mu.Lock()
	srv.store.media[m.ID] = m
	srv.store.mu.Unlock()
	jsonResponse(w, 201, map[string]any{"media": m, "uploadUrl": "/api/v1/admin/media/" + m.ID + "/upload", "finalizeUrl": "/api/v1/admin/media/" + m.ID + "/finalize", "expiresIn": 3600})
}

func allowedMediaMime(v string) bool {
	u, err := url.Parse("x:" + v)
	_ = u
	return err == nil && (strings.HasPrefix(v, "image/") || strings.HasPrefix(v, "audio/") || strings.HasPrefix(v, "video/") || v == "application/pdf" || v == "application/zip" || v == "text/plain")
}

func mediaUploadLock(id string) *sync.Mutex {
	value, _ := mediaUploadLocks.LoadOrStore(id, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func emptyFinalizeBody(r *http.Request) bool {
	if r.Body == nil {
		return true
	}
	buf := make([]byte, 1)
	n, err := r.Body.Read(buf)
	return n == 0 && err == io.EOF
}

func mediaPathWithinRoot(root, path string) bool {
	if root == "" || path == "" {
		return false
	}
	cleanRoot, errRoot := filepath.Abs(root)
	cleanPath, errPath := filepath.Abs(path)
	if errRoot != nil || errPath != nil {
		return false
	}
	return cleanPath != cleanRoot && strings.HasPrefix(cleanPath, cleanRoot+string(os.PathSeparator))
}

func (srv *Server) mediaEndpoint(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		srv.mediaEndpointDatabase(w, r)
		return
	}
	if r.Method != http.MethodGet && !srv.checkMutation(w, r) {
		return
	}
	if r.Method == http.MethodGet && !srv.requireAuth(w, r) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/media/"), "/")
	id := parts[0]
	srv.store.mu.RLock()
	m := srv.store.media[id]
	srv.store.mu.RUnlock()
	if m == nil {
		problem(w, 404, "媒体不存在")
		return
	}
	if len(parts) > 1 && parts[1] == "finalize" {
		if !emptyFinalizeBody(r) {
			problem(w, http.StatusBadRequest, "完成上传不接受文件体")
			return
		}
		path := filepath.Join(srv.mediaRoot, id+"-upload")
		if !mediaPathWithinRoot(srv.mediaRoot, path) {
			problem(w, http.StatusInternalServerError, "媒体存储路径无效")
			return
		}
		lock := mediaUploadLock(id)
		lock.Lock()
		defer lock.Unlock()
		if _, err := os.Stat(path); err != nil {
			problem(w, http.StatusNotFound, "上传文件不存在")
			return
		}
		sum, size, err := validateMediaFile(path, m.SizeBytes, m.MimeType)
		if err != nil {
			problem(w, http.StatusBadRequest, "媒体校验失败")
			return
		}
		m.SizeBytes = size
		m.StoragePath = path
		m.SHA256 = sum
		m.Status = "ready"
		srv.store.mu.Lock()
		srv.store.media[id] = m
		srv.store.mu.Unlock()
		if srv.store.persistent && srv.store.database != nil {
			_, _ = srv.store.database.ExecContext(r.Context(), `UPDATE media SET status='ready',storage_path=$1,size_bytes=$2,sha256=$3,mime_type=$4 WHERE id=$5::uuid`, path, m.SizeBytes, m.SHA256, m.MimeType, id)
		}
		jsonResponse(w, 200, m)
		return
	}
	if len(parts) > 1 && parts[1] == "upload" {
		if r.Method != http.MethodPatch && r.Method != http.MethodHead {
			problem(w, http.StatusMethodNotAllowed, "方法不允许")
			return
		}
		path := filepath.Join(srv.mediaRoot, id+"-upload")
		if !mediaPathWithinRoot(srv.mediaRoot, path) {
			problem(w, http.StatusInternalServerError, "媒体存储路径无效")
			return
		}
		lock := mediaUploadLock(id)
		lock.Lock()
		defer lock.Unlock()
		_ = os.MkdirAll(srv.mediaRoot, 0750)
		st, _ := os.Stat(path)
		offset := int64(0)
		if st != nil {
			offset = st.Size()
		}
		w.Header().Set("Tus-Resumable", "1.0.0")
		w.Header().Set("Upload-Offset", fmt.Sprintf("%d", offset))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		requested := parseUploadOffset(r.Header.Get("Upload-Offset"))
		if requested < 0 || requested != offset {
			w.Header().Set("Upload-Offset", fmt.Sprintf("%d", offset))
			problem(w, http.StatusConflict, "上传偏移不匹配")
			return
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			problem(w, http.StatusInternalServerError, "无法打开上传文件")
			return
		}
		if _, err = f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			problem(w, http.StatusInternalServerError, "无法定位上传偏移")
			return
		}
		remaining := m.SizeBytes - offset
		if remaining < 0 || (r.ContentLength >= 0 && r.ContentLength > remaining) {
			f.Close()
			problem(w, http.StatusRequestEntityTooLarge, "文件超过声明大小")
			return
		}
		n, err := io.Copy(f, io.LimitReader(r.Body, remaining+1))
		f.Close()
		if err != nil {
			problem(w, http.StatusInternalServerError, "写入媒体失败")
			return
		}
		if n > remaining || (r.ContentLength >= 0 && n != r.ContentLength) {
			problem(w, http.StatusRequestEntityTooLarge, "文件超过声明大小")
			return
		}
		if offset+n > configuredMaxUploadBytes() {
			problem(w, http.StatusRequestEntityTooLarge, "文件超过上传限制")
			return
		}
		w.Header().Set("Upload-Offset", fmt.Sprintf("%d", offset+n))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet {
		jsonResponse(w, 200, m)
		return
	}
	problem(w, 405, "方法不允许")
}

func (srv *Server) mediaEndpointDatabase(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/media/"), "/"), "/")
	id := parts[0]
	ownerID, ownerErr := srv.persistentUserID(r)
	if ownerErr != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	if len(parts) > 1 && parts[1] == "upload" {
		if r.Method != http.MethodPatch && r.Method != http.MethodHead {
			problem(w, http.StatusMethodNotAllowed, "方法不允许")
			return
		}
		lock := mediaUploadLock(id)
		lock.Lock()
		defer lock.Unlock()
		tx, err := srv.store.database.BeginTx(r.Context(), nil)
		if err != nil {
			problem(w, http.StatusInternalServerError, "上传锁定失败")
			return
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, id); err != nil {
			problem(w, http.StatusInternalServerError, "上传锁定失败")
			return
		}
		var status string
		var expectedSize int64
		if err := tx.QueryRowContext(r.Context(), `SELECT status,size_bytes FROM media WHERE id=$1::uuid AND owner_id=$2::uuid`, id, ownerID).Scan(&status, &expectedSize); err != nil || status != "uploading" {
			problem(w, http.StatusNotFound, "媒体不存在")
			return
		}
		path := filepath.Join(srv.mediaRoot, id+"-upload")
		if !mediaPathWithinRoot(srv.mediaRoot, path) {
			problem(w, http.StatusInternalServerError, "媒体存储路径无效")
			return
		}
		_ = os.MkdirAll(srv.mediaRoot, 0750)
		st, _ := os.Stat(path)
		offset := int64(0)
		if st != nil {
			offset = st.Size()
		}
		w.Header().Set("Tus-Resumable", "1.0.0")
		w.Header().Set("Upload-Offset", fmt.Sprintf("%d", offset))
		if r.Method == http.MethodHead {
			_ = tx.Commit()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		requested := parseUploadOffset(r.Header.Get("Upload-Offset"))
		if requested < 0 || requested != offset {
			problem(w, http.StatusConflict, "上传偏移不匹配")
			return
		}
		if offset >= configuredMaxUploadBytes() {
			problem(w, http.StatusRequestEntityTooLarge, "文件超过上传限制")
			return
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			problem(w, http.StatusInternalServerError, "无法打开上传文件")
			return
		}
		if _, err = f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			problem(w, http.StatusInternalServerError, "无法定位上传偏移")
			return
		}
		remaining := expectedSize - offset
		if remaining < 0 || (r.ContentLength >= 0 && r.ContentLength > remaining) {
			f.Close()
			problem(w, http.StatusRequestEntityTooLarge, "文件超过声明大小")
			return
		}
		n, err := io.Copy(f, io.LimitReader(r.Body, remaining+1))
		f.Close()
		if err != nil {
			problem(w, http.StatusInternalServerError, "写入媒体失败")
			return
		}
		if n > remaining || (r.ContentLength >= 0 && n != r.ContentLength) {
			problem(w, http.StatusRequestEntityTooLarge, "文件超过声明大小")
			return
		}
		w.Header().Set("Upload-Offset", fmt.Sprintf("%d", offset+n))
		if err := tx.Commit(); err != nil {
			problem(w, http.StatusInternalServerError, "提交上传偏移失败")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(parts) > 1 && parts[1] == "finalize" {
		if !emptyFinalizeBody(r) {
			problem(w, http.StatusBadRequest, "完成上传不接受文件体")
			return
		}
		lock := mediaUploadLock(id)
		lock.Lock()
		defer lock.Unlock()
		tx, err := srv.store.database.BeginTx(r.Context(), nil)
		if err != nil {
			problem(w, http.StatusInternalServerError, "完成上传锁定失败")
			return
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, id); err != nil {
			problem(w, http.StatusInternalServerError, "完成上传锁定失败")
			return
		}
		var expectedSize int64
		var declaredMime, status string
		if err := tx.QueryRowContext(r.Context(), `SELECT size_bytes,mime_type,status FROM media WHERE id=$1::uuid AND owner_id=$2::uuid`, id, ownerID).Scan(&expectedSize, &declaredMime, &status); err != nil || status != "uploading" {
			problem(w, http.StatusNotFound, "媒体不存在")
			return
		}
		path := filepath.Join(srv.mediaRoot, id+"-upload")
		if !mediaPathWithinRoot(srv.mediaRoot, path) {
			problem(w, http.StatusInternalServerError, "媒体存储路径无效")
			return
		}
		sum, actualSize, err := validateMediaFile(path, expectedSize, declaredMime)
		if err != nil {
			problem(w, http.StatusBadRequest, "媒体校验失败")
			return
		}
		externalStatus, configRevision := srv.externalPublishPlan(r.Context(), declaredMime, actualSize)
		res, err := tx.ExecContext(r.Context(), `UPDATE media SET status='ready',storage_path=$1,size_bytes=$2,sha256=$3,external_publish_status=$6,external_publish_error=NULL,external_config_revision=$7 WHERE id=$4::uuid AND owner_id=$5::uuid AND status='uploading'`, path, actualSize, sum, id, ownerID, externalStatus, configRevision)
		if err != nil {
			problem(w, 500, "保存媒体失败")
			return
		}
		rows, _ := res.RowsAffected()
		if rows != 1 {
			problem(w, 404, "媒体不存在")
			return
		}
		if externalStatus == "pending" {
			payload, _ := json.Marshal(map[string]any{"mediaId": id, "configRevision": configRevision})
			if _, err := tx.ExecContext(r.Context(), `INSERT INTO jobs(type,payload) VALUES('publish_media',$1) ON CONFLICT DO NOTHING`, payload); err != nil {
				problem(w, 500, "排队外部发布失败")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			problem(w, http.StatusInternalServerError, "保存媒体失败")
			return
		}
		jsonResponse(w, 200, map[string]any{"id": id, "status": "ready", "sizeBytes": actualSize, "sha256": sum, "externalPublishStatus": externalStatus})
		return
	}
	if len(parts) > 1 && parts[1] == "retry-publish" {
		if r.Method != http.MethodPost {
			problem(w, http.StatusMethodNotAllowed, "方法不允许")
			return
		}
		var mimeType, state string
		var size int64
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT mime_type,size_bytes,external_publish_status FROM media WHERE id=$1::uuid AND owner_id=$2::uuid AND status='ready'`, id, ownerID).Scan(&mimeType, &size, &state); err != nil {
			problem(w, 404, "媒体不存在")
			return
		}
		next, revision := srv.externalPublishPlan(r.Context(), mimeType, size)
		if next != "pending" {
			problem(w, 409, "外部图床未启用、未验证或媒体格式不支持")
			return
		}
		if state == "pending" || state == "publishing" {
			jsonResponse(w, 202, map[string]any{"externalPublishStatus": state})
			return
		}
		payload, _ := json.Marshal(map[string]any{"mediaId": id, "configRevision": revision})
		tx, err := srv.store.database.BeginTx(r.Context(), nil)
		if err != nil {
			problem(w, 500, "重试发布失败")
			return
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(r.Context(), `UPDATE media SET external_publish_status='pending',external_publish_error=NULL,external_config_revision=$2 WHERE id=$1::uuid`, id, revision); err != nil {
			problem(w, 500, "重试发布失败")
			return
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO jobs(type,payload) VALUES('publish_media',$1) ON CONFLICT DO NOTHING`, payload); err != nil {
			problem(w, 500, "重试发布失败")
			return
		}
		if err = tx.Commit(); err != nil {
			problem(w, 500, "重试发布失败")
			return
		}
		jsonResponse(w, 202, map[string]any{"externalPublishStatus": "pending"})
		return
	}
	var m Media
	err := srv.store.database.QueryRowContext(r.Context(), `SELECT id::text,original_name,mime_type,size_bytes,visibility,status,COALESCE(storage_path,''),COALESCE(sha256,''),created_at,provider,COALESCE(provider_key,''),COALESCE(public_url,''),external_publish_status,COALESCE(external_publish_error,'') FROM media WHERE id=$1::uuid AND owner_id=$2::uuid`, id, ownerID).Scan(&m.ID, &m.OriginalName, &m.MimeType, &m.SizeBytes, &m.Visibility, &m.Status, &m.StoragePath, &m.SHA256, &m.CreatedAt, &m.Provider, &m.ProviderKey, &m.PublicURL, &m.ExternalPublishStatus, &m.ExternalPublishError)
	if err != nil {
		problem(w, 404, "媒体不存在")
		return
	}
	if r.Method == http.MethodDelete {
		res, delErr := srv.store.database.ExecContext(r.Context(), `UPDATE media m SET status='deleting' WHERE m.id=$1::uuid AND m.owner_id=$2::uuid AND m.status <> 'deleting' AND NOT EXISTS (SELECT 1 FROM media_refs mr WHERE mr.media_id=m.id)`, id, ownerID)
		if delErr != nil {
			problem(w, 500, "删除媒体失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, http.StatusConflict, "媒体不存在或仍被内容引用")
			return
		}
		if m.StoragePath != "" {
			payload, _ := json.Marshal(map[string]any{"path": m.StoragePath, "mediaId": id})
			if _, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO jobs(type,payload) VALUES('media_delete',$1)`, payload); err != nil {
				problem(w, 500, "排队清理媒体失败")
				return
			}
		}
		jsonResponse(w, http.StatusNoContent, nil)
		return
	}
	jsonResponse(w, 200, &m)
}

func (srv *Server) externalPublishPlan(ctx context.Context, mimeType string, size int64) (string, any) {
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") || size > 20*1024*1024 {
		return "not_requested", nil
	}
	record, err := integrationRecordByName(ctx, srv.store.database, externalImageHostName)
	if err != nil {
		return "not_requested", nil
	}
	config := externalImageHostConfig{}
	if json.Unmarshal(record.Config, &config) != nil {
		return "not_requested", nil
	}
	provider := customPublicProvider{config: config, tokenConfigured: record.SecretEncrypted.Valid, verified: record.TestStatus == "verified" || record.TestStatus == "scope_limited"}
	if !provider.PublishEnabled() {
		return "not_requested", nil
	}
	return "pending", record.Revision
}

func (srv *Server) mediaContent(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		srv.mediaContentDatabase(w, r)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/media/"), "/")
	id = strings.TrimSuffix(id, "/content")
	srv.store.mu.RLock()
	m := srv.store.media[id]
	srv.store.mu.RUnlock()
	if m == nil || m.Status != "ready" {
		problem(w, 404, "媒体不存在")
		return
	}
	if m.Visibility != "public" && m.Visibility != "private" {
		problem(w, http.StatusNotFound, "媒体不存在")
		return
	}
	if m.Visibility == "private" && !srv.store.authenticated(r) {
		problem(w, 404, "媒体不存在")
		return
	}
	if !mediaPathWithinRoot(srv.mediaRoot, m.StoragePath) {
		problem(w, http.StatusNotFound, "媒体不存在")
		return
	}
	f, err := os.Open(m.StoragePath)
	if err != nil {
		problem(w, 404, "媒体不存在")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", m.MimeType)
	if m.Visibility == "private" {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Content-Disposition", `inline; filename="`+strings.ReplaceAll(m.OriginalName, `"`, "")+`"`)
	}
	if m.SHA256 == "" {
		h := sha256.New()
		if _, err := io.Copy(h, f); err == nil {
			m.SHA256 = hex.EncodeToString(h.Sum(nil))
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				problem(w, http.StatusInternalServerError, "读取媒体失败")
				return
			}
		}
	}
	if m.SHA256 != "" {
		w.Header().Set("ETag", `"`+m.SHA256+`"`)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	if etag := w.Header().Get("ETag"); etag != "" && r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	http.ServeContent(w, r, m.OriginalName, m.CreatedAt, f)
}

func (srv *Server) mediaContentDatabase(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/media/"), "/")
	id = strings.TrimSuffix(id, "/content")
	var m Media
	err := srv.store.database.QueryRowContext(r.Context(), `SELECT id::text,original_name,mime_type,size_bytes,visibility,status,storage_path,COALESCE(sha256,''),created_at FROM media WHERE id=$1::uuid`, id).Scan(&m.ID, &m.OriginalName, &m.MimeType, &m.SizeBytes, &m.Visibility, &m.Status, &m.StoragePath, &m.SHA256, &m.CreatedAt)
	if err != nil || m.Status != "ready" {
		problem(w, 404, "媒体不存在")
		return
	}
	if m.Visibility != "public" && m.Visibility != "private" {
		problem(w, http.StatusNotFound, "媒体不存在")
		return
	}
	if m.Visibility == "private" && !srv.authenticatedPersistent(r) {
		problem(w, 404, "媒体不存在")
		return
	}
	if !mediaPathWithinRoot(srv.mediaRoot, m.StoragePath) {
		problem(w, http.StatusNotFound, "媒体不存在")
		return
	}
	f, err := os.Open(m.StoragePath)
	if err != nil {
		problem(w, 404, "媒体不存在")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", m.MimeType)
	if m.Visibility == "private" {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Content-Disposition", `inline; filename="`+strings.ReplaceAll(m.OriginalName, `"`, "")+`"`)
	}
	w.Header().Set("ETag", `"`+m.SHA256+`"`)
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, m.OriginalName, m.CreatedAt, f)
}
